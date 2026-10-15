'use strict';
// SessionStart: a short reminder into the context (stdout); starts the transcript watchdog for a lead session.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { found, load, projectRoot } = require('./lib/config.cjs');
const { check } = require('./lib/validate.cjs');
const { run } = require('./lib/hook-io.cjs');
const tmp = require('./lib/tmp.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'session-start.cjs: SessionStart hook; prints the version, the config status, a reminder about skill ghorc:orc (lead only), ' +
      'pending watchdog alerts, a missing CLAUDE.md ghorc section and a /ghorc:setup hint. ' +
      'Lead: GHORC_ROLE=lead, or GHORC_ROLE unset and lead.remind not false. Workers start with GHORC_ROLE=worker and get no reminder. ' +
      'A lead session also starts scripts/watchdog.cjs detached when watchdog.autostart is true and no live watchdog holds <tmp>/ghorc/watchdog.pid.',
  );
  process.exit(0);
}

// Start the watchdog detached unless the pid lock names a live process. Never throws.
function startWatchdog(cfg) {
  try {
    const w = cfg.watchdog || {};
    if (w.autostart === false) return false;
    const pidFile = tmp.pidFile();
    if (!tmp.shouldStartWatchdog(pidFile)) return false;
    fs.mkdirSync(tmp.tmpDir(), { recursive: true });
    const log = fs.openSync(tmp.logFile(), 'a');
    const args = [
      path.join(__dirname, 'watchdog.cjs'),
      '--interval', String(w.intervalSec ?? 30),
      '--rateMiBPerMin', String(w.rateMiBPerMin ?? 10),
      '--warnMiB', String(w.warnMiB ?? 100),
      '--stopMiB', String(w.stopMiB ?? 250),
      '--notify-file', tmp.alertsFile(),
      '--pid-file', pidFile,
    ];
    if (process.env.GHORC_WATCHDOG_ROOT) args.push('--root', process.env.GHORC_WATCHDOG_ROOT);
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', () => {});
    if (child.pid) fs.writeFileSync(pidFile, String(child.pid)); // close the race before the child writes it itself
    child.unref();
    fs.closeSync(log);
    return true;
  } catch {
    return false;
  }
}

run((input) => {
  let version = '?';
  try {
    version = require(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')).version;
  } catch {
    /* the version is optional */
  }
  const cwd = input.cwd || process.cwd();
  const lines = [`ghorc ${version}`];
  lines.push(found(cwd) ? 'config: ok' : 'config not found: copy templates/ghorc.json to .claude/ghorc.json');
  try {
    const { problems } = check(cwd);
    if (problems.length) lines.push(`config invalid: ${problems[0]}`.slice(0, 150) + ' (node scripts/check-config.cjs)');
  } catch {
    /* the check is optional */
  }

  const role = (process.env.GHORC_ROLE || '').trim();
  const cfg = load(cwd);
  const remind = cfg.lead;
  const isMain = !input.agent_id;
  const isLead = isMain && (role === 'lead' || (role === '' && !(remind && remind.remind === false)));
  if (isLead) lines.push('lead: load skill ghorc:orc');
  if (isMain && (role === 'lead' || role === '')) startWatchdog(cfg);

  try {
    const { lines: unread } = tmp.unreadAlerts();
    if (unread.length) lines.push(`${unread.length} watchdog alerts pending, run ctx.cjs`);
  } catch {
    /* alerts are optional */
  }

  try {
    const mdFile = path.join(projectRoot(cwd), 'CLAUDE.md');
    let md = null;
    try {
      md = fs.readFileSync(mdFile, 'utf8');
    } catch {
      /* missing */
    }
    if (md === null) lines.push('CLAUDE.md is missing, so it has no ghorc section: paste templates/CLAUDE-section.md');
    else if (!md.includes('<!-- ghorc -->')) lines.push('CLAUDE.md has no ghorc section: paste templates/CLAUDE-section.md');
  } catch {
    /* optional */
  }

  try {
    if (isLead) {
      const r = require('./setup.cjs').check(cwd);
      if (r.items.some((i) => !i.ok && !i.owner) || r.settingsError) lines.push('run /ghorc:setup');
    }
  } catch {
    /* optional */
  }
  process.stdout.write(lines.join('\n').slice(0, 299) + '\n');
});
