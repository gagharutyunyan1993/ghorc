'use strict';
// SessionStart: a short reminder into the context (stdout); starts the per-project transcript watchdog for a lead session.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { found, load, projectRoot, optedIn } = require('./lib/config.cjs');
const { check } = require('./lib/validate.cjs');
const { run } = require('./lib/hook-io.cjs');
const tmp = require('./lib/tmp.cjs');
const { role: roleOf } = require('./lib/role.cjs');
const { refuseReason, deriveTranscriptDir } = require('./lib/scandir.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'session-start.cjs: SessionStart hook; silent in a project without .claude/ghorc.json (it never opted in). Otherwise prints, in this order, pending watchdog alerts (count + last 2 lines), ' +
      '"ghorc <version> session=<id> role=<role>", the config status, then reminders (skill ghorc:lead for the lead, ' +
      'a missing CLAUDE.md ghorc section, a /ghorc:setup hint). Output is at most 299 characters, built from whole lines: when it does not fit, whole lines are dropped, lowest priority first ("config: ok", alert details, alert count, CLAUDE.md hint, setup hint, ...), and it ends with "+more: run ctx"; the lead reminder is never dropped, the identity and "config invalid" lines fall back to a short form and go whole only as a last resort. ' +
      'Role: GHORC_ROLE is optional; an empty GHORC_ROLE on a main session prints role=lead, GHORC_ROLE=worker stays explicit. ' +
      'It appends a session line (session id, role, transcript path) to .claude/ghorc-out/ledger.jsonl for the cost report, and deletes ctx files, session state and alert offsets older than 7 days. ' +
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

// Lines are { t: text, p: drop priority, s: optional short form, keep: never dropped }. p 0 is dropped only as a last resort; a
// higher p goes first, and among equal p the earlier line goes first (so the newest alert detail outlives the older one).
// Nothing is cut inside a line; when lines were dropped the output ends with MORE.
// Priorities: 0 identity, lead reminder (keep), config invalid or unreadable; 3 config warning, sticky notice; 4 watchdog note;
// 5 setup hint, permissions hint; 6 CLAUDE.md hint; 7 alert count; 8 alert details; 9 config ok (the routine line goes first).
function build(items) {
  const join = (xs) => xs.map((x) => x.t).join('\n');
  if (join(items).length <= LIMIT) return join(items);
  const kept = items.slice();
  const room = LIMIT - MORE.length;
  while (join(kept).length > room) {
    let at = -1;
    kept.forEach((x, i) => {
      if (x.p > 0 && (at < 0 || x.p > kept[at].p)) at = i;
    });
    if (at < 0) break;
    kept.splice(at, 1);
  }
  if (join(kept).length > room) for (const x of kept) if (x.s) x.t = x.s;
  // last resort: the lead line stays, the other lines that were never dropped go whole, the later ones first
  while (join(kept).length > room) {
    let at = -1;
    kept.forEach((x, i) => {
      if (!x.keep) at = i;
    });
    if (at < 0) break;
    kept.splice(at, 1);
  }
  return join(kept) + MORE;
}

run((input) => {
  const version = pluginVersion();
  const cwd = input.cwd || process.cwd();
  if (!optedIn(cwd)) return; // a project without .claude/ghorc.json never opted in: no lines, no watchdog, no cleanup
  const sid = input.session_id;
  const root = projectRoot(cwd);
  const role = roleOf();
  const cfg = load(cwd);
  const isMain = !input.agent_id;

  // the ledger prices main sessions (lead, tab workers) from their transcripts: scripts/ledger.cjs report
  try {
    const ledger = require('./ledger.cjs');
    const line = ledger.sessionLine(input, role);
    if (line) ledger.append(ledger.ledgerPath(cwd), line);
  } catch {
    /* the ledger is optional */
  }

  try {
    tmp.cleanup(root);
  } catch {
    /* housekeeping is optional */
  }

  const alerts = [];
  try {
    const { lines } = tmp.unreadAlerts(root, sid);
    if (lines.length) {
      alerts.push({ t: `${lines.length} watchdog alerts pending, run ctx`, p: 7 });
      for (const l of lines.slice(-2)) alerts.push({ t: `  ${l.slice(0, 80)}`, p: 8 });
    }
  } catch {
    /* alerts are optional */
  }

  const ident = { t: [`ghorc ${version}`, `session=${sid || '?'}`, `role=${role || (isMain ? 'lead' : 'agent')}`].join(' '), p: 0, s: `ghorc ${version} role=${role || (isMain ? 'lead' : 'agent')}` };

  const status = [];
  if (isMain && role === '' && (cfg.handoff || {}).stickyOnCompact === true) {
    status.push({ t: 'handoff.stickyOnCompact is on, but GHORC_ROLE is not set: the block after compaction applies only to a proven lead (see docs/handoff.md), otherwise set GHORC_ROLE=lead', p: 3 });
  }
  status.push(found(cwd) ? { t: 'config: ok', p: 9 } : { t: 'config unreadable: fix .claude/ghorc.json (node scripts/check-config.cjs)', p: 0, s: 'config unreadable: run check-config' });
  try {
    const { problems, fatal } = check(cwd);
    if (problems.length) {
      const label = fatal.length ? `config invalid: ${fatal[0]}` : `config warning: ${problems[0]}`;
      status.push({ t: label.slice(0, 150) + ' (node scripts/check-config.cjs)', p: fatal.length ? 0 : 3, s: label.slice(0, 60) });
    }
  } catch {
    /* the check is optional */
  }

  const remind = cfg.lead;
  const isLead = isMain && (role === 'lead' || (role === '' && !(remind && remind.remind === false)));
  const reminders = [];
  if (isLead) reminders.push({ t: 'lead: load skill ghorc:lead', p: 0, keep: true });
  if (isMain && (role === 'lead' || role === '')) {
    const w = startWatchdog(cfg, root, version, input, cwd);
    if (typeof w === 'string') status.push({ t: w, p: 4 });
  }

  try {
    let md = null;
    try {
      md = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    } catch {
      /* missing */
    }
    if (md === null) reminders.push({ t: 'CLAUDE.md is missing, so it has no ghorc section: paste templates/CLAUDE-section.md', p: 6 });
    else if (!md.includes('<!-- ghorc -->')) reminders.push({ t: 'CLAUDE.md has no ghorc section: paste templates/CLAUDE-section.md', p: 6 });
  } catch {
    /* optional */
  }

  try {
    if (isLead) {
      const r = require('./setup.cjs').check(cwd);
      if (r.items.some((i) => !i.ok && !i.owner && !i.warn) || r.settingsError) reminders.push({ t: 'run /ghorc:setup', p: 5 });
      else if (r.items.some((i) => i.id === 'permissions' && !i.ok)) reminders.push({ t: 'tab worker permission mode not chosen: /ghorc:setup asks', p: 5 });
    }
  } catch {
    /* optional */
  }

  process.stdout.write(build([...alerts, ident, ...status, ...reminders]) + '\n');
});
