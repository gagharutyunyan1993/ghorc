'use strict';
// SessionStart: a short reminder into the context (stdout); starts the per-project transcript watchdog for a lead session.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { found, load, projectRoot } = require('./lib/config.cjs');
const { check } = require('./lib/validate.cjs');
const { run } = require('./lib/hook-io.cjs');
const tmp = require('./lib/tmp.cjs');
const { refuseReason, deriveTranscriptDir } = require('./lib/scandir.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'session-start.cjs: SessionStart hook; prints, in this order, pending watchdog alerts (count + last 2 lines), ' +
      '"ghorc <version> session=<id> role=<role>", the config status, then reminders (skill ghorc:lead for the lead, ' +
      'a missing CLAUDE.md ghorc section, a /ghorc:setup hint). Output is cut at 299 characters and then ends with "+more: run ctx". ' +
      'Role: GHORC_ROLE is optional; an empty GHORC_ROLE on a main session prints role=lead, GHORC_ROLE=worker stays explicit. ' +
      'It deletes ctx files, session state and alert offsets older than 7 days. ' +
      'A lead session starts scripts/watchdog.cjs detached only when watchdog.autostart is true (default false; opt in with /ghorc:setup, stop with watchdog.cjs --stop): one watchdog per project root, ' +
      'restarted when its pid is dead, its heartbeat is stale (2 intervals) or its version differs from the plugin version. ' +
      'Nothing is killed: the new pid file makes an older watchdog exit on its next poll.',
  );
  process.exit(0);
}

const LIMIT = 299;
const MORE = '\n+more: run ctx';

function pluginVersion() {
  try {
    return require(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')).version;
  } catch {
    return '?';
  }
}

// Start the watchdog detached unless a live, fresh, same-version one holds the pid file for this root. Never throws.
function startWatchdog(cfg, root, version, input, cwd) {
  try {
    const w = cfg.watchdog || {};
    if (w.autostart !== true || process.env.GHORC_NO_AUTOSTART === '1') return false;
    const interval = Number(w.intervalSec ?? 30);
    const dir = deriveTranscriptDir(input, cwd);
    const refused = refuseReason(dir);
    if (refused) return `watchdog: not started (${refused})`;
    const status = tmp.watchdogStatus(root, version, interval);
    if (status.alive) return false;
    // No kill: a stale pid may belong to a foreign process (pid reuse after a reboot or a hard kill). The new pid file
    // below hands the root over; a still-running older watchdog sees a pid that is not its own and exits by itself.
    fs.mkdirSync(tmp.tmpDir(), { recursive: true });
    const log = fs.openSync(tmp.logFile(root), 'a');
    const args = [
      path.join(__dirname, 'watchdog.cjs'),
      '--interval', String(interval),
      '--rateMiBPerMin', String(w.rateMiBPerMin ?? 10),
      '--warnMiB', String(w.warnMiB ?? 100),
      '--stopMiB', String(w.stopMiB ?? 250),
      '--transcript-dir', dir,
      '--project-root', root,
      '--version', version,
      '--notify-file', tmp.alertsFile(root),
      '--pid-file', tmp.pidFile(root),
      '--heartbeat-file', tmp.heartbeatFile(root),
    ];
    if (process.env.GHORC_WATCHDOG_DRY === '1') {
      fs.closeSync(log);
      process.stderr.write('watchdog-args: ' + JSON.stringify(args.slice(1)) + '\n');
      return false;
    }
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', () => {});
    if (child.pid) {
      // close the race before the child writes it itself
      tmp.atomicWrite(tmp.pidFile(root), JSON.stringify({ pid: child.pid, version, root, startedAt: Date.now() }));
    }
    child.unref();
    fs.closeSync(log);
    return false;
  } catch {
    return false;
  }
}

function cut(lines) {
  const text = lines.join('\n');
  if (text.length <= LIMIT) return text;
  return text.slice(0, LIMIT - MORE.length) + MORE;
}

run((input) => {
  const version = pluginVersion();
  const cwd = input.cwd || process.cwd();
  const sid = input.session_id;
  const root = projectRoot(cwd);
  const role = (process.env.GHORC_ROLE || '').trim();
  const cfg = load(cwd);
  const isMain = !input.agent_id;

  try {
    tmp.cleanup(root);
  } catch {
    /* housekeeping is optional */
  }

  const alerts = [];
  try {
    const { lines } = tmp.unreadAlerts(root, sid);
    if (lines.length) {
      alerts.push(`${lines.length} watchdog alerts pending, run ctx`);
      for (const l of lines.slice(-2)) alerts.push(`  ${l.slice(0, 80)}`);
    }
  } catch {
    /* alerts are optional */
  }

  const ident = [`ghorc ${version}`, `session=${sid || '?'}`, `role=${role || (isMain ? 'lead' : 'agent')}`];

  const status = [];
  status.push(found(cwd) ? 'config: ok' : 'config not found: copy templates/ghorc.json to .claude/ghorc.json');
  try {
    const { problems, fatal } = check(cwd);
    if (problems.length) {
      const label = fatal.length ? `config invalid: ${fatal[0]}` : `config warning: ${problems[0]}`;
      status.push(label.slice(0, 150) + ' (node scripts/check-config.cjs)');
    }
  } catch {
    /* the check is optional */
  }

  const remind = cfg.lead;
  const isLead = isMain && (role === 'lead' || (role === '' && !(remind && remind.remind === false)));
  const reminders = [];
  if (isLead) reminders.push('lead: load skill ghorc:lead');
  if (isMain && (role === 'lead' || role === '')) {
    const w = startWatchdog(cfg, root, version, input, cwd);
    if (typeof w === 'string') status.push(w);
  }

  try {
    let md = null;
    try {
      md = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    } catch {
      /* missing */
    }
    if (md === null) reminders.push('CLAUDE.md is missing, so it has no ghorc section: paste templates/CLAUDE-section.md');
    else if (!md.includes('<!-- ghorc -->')) reminders.push('CLAUDE.md has no ghorc section: paste templates/CLAUDE-section.md');
  } catch {
    /* optional */
  }

  try {
    if (isLead) {
      const r = require('./setup.cjs').check(cwd);
      if (r.items.some((i) => !i.ok && !i.owner && !i.warn) || r.settingsError) reminders.push('run /ghorc:setup');
    }
  } catch {
    /* optional */
  }

  process.stdout.write(cut([...alerts, ident.join(' '), ...status, ...reminders]) + '\n');
});
