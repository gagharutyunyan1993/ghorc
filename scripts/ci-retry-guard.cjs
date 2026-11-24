'use strict';
// PreToolUse(Bash|PowerShell and MCP retry tools): a CI job is not restarted blindly. Opt-in: ciRetry.enabled (default false).
// Every allowed restart is one line in <project root>/.claude/ghorc-out/ci-retry-ledger.jsonl. Within ciRetry.windowHours the
// first ciRetry.freeRetries restarts pass; after that a restart needs a fresh reason file (written within 30 minutes and
// after the last restart); from ciRetry.hardCap restarts every restart is denied. The ledger is a plain file: nothing
// protects it from being edited or deleted (docs/hooks.md).
const fs = require('node:fs');
const path = require('node:path');
const { deny, run } = require('./lib/hook-io.cjs');
const { load, optedIn } = require('./lib/config.cjs');
const { matches } = require('./lib/cmd.cjs');
const { projectRoot } = require('./lib/root.cjs');

const LEDGER_REL = path.join('.claude', 'ghorc-out', 'ci-retry-ledger.jsonl');
const REASON_REL = path.join('.claude', 'ghorc-out', 'ci-retry-reason.md');
const REASON_FRESH_MS = 30 * 60 * 1000;
const DEFAULTS = { freeRetries: 1, hardCap: 3, windowHours: 24 };

if (process.argv.includes('--help')) {
  console.log(
    'ci-retry-guard.cjs: PreToolUse hook on Bash|PowerShell and on MCP tools named mcp__*retry_pipeline|retry_job|play_job|rerun|retry*, ' +
      'opt-in (ciRetry.enabled, default false; silent in a project without .claude/ghorc.json). Commands that restart CI: ' +
      'glab ci|pipe|pipeline retry|run|trigger, gh run rerun, gh workflow run, and glab api / gh api calls to a ' +
      '.../pipelines|jobs|runs/<id>/retry|play|rerun|rerun-failed-jobs endpoint (--help passes). Every allowed restart is appended to ' +
      '<project root>/.claude/ghorc-out/ci-retry-ledger.jsonl ({ts, command, session, tool}). Within ciRetry.windowHours (24): ' +
      'the first ciRetry.freeRetries (1) restarts are allowed; after that a restart is allowed only when ' +
      '<project root>/.claude/ghorc-out/ci-retry-reason.md was written within the last 30 minutes and after the last restart ' +
      '(what failed, the error signature, why a retry and not a fix); from ciRetry.hardCap (3) restarts every restart is denied ' +
      '(report to the owner). The ledger is not protected from edits. Every deny is appended to <tmp>/ghorc-<user>/denials.log. ' +
      'Any internal error allows the call.',
  );
  process.exit(0);
}

const NO_HELP = String.raw`(?!.*\s(?:--help|-h)(?=\s|$))`;
// options before the subcommand, with or without a value: glab -R group/project ci retry
const OPTS = String.raw`(?:\s+--?[\w-]+(?:=\S+|\s+[^\s-]\S*)?)*`;
const RESTART = [
  new RegExp(String.raw`^${NO_HELP}glab${OPTS}\s+(?:ci|pipe|pipeline)${OPTS}\s+(?:retry|run|trigger)(?=\s|$)`, 'i'),
  new RegExp(String.raw`^${NO_HELP}gh${OPTS}\s+(?:run${OPTS}\s+rerun|workflow${OPTS}\s+run)(?=\s|$)`, 'i'),
  // the REST endpoints behind them: GitLab pipelines/:id/retry, jobs/:id/retry|play; GitHub actions runs/:id/rerun(-failed-jobs)
  new RegExp(String.raw`^${NO_HELP}(?:glab|gh)${OPTS}\s+api\s.*?\/(?:pipelines|jobs|runs)\/\S+?\/(?:retry|play|rerun|rerun-failed-jobs)(?=[\s?]|$)`, 'i'),
];
const MCP_RESTART = /^mcp__.*(?:retry_pipeline|retry_job|play_job|rerun|retry)/i;

function isRestart(input) {
  const name = String(input.tool_name || '');
  if (name === 'Bash' || name === 'PowerShell') {
    const command = input.tool_input && input.tool_input.command;
    return typeof command === 'string' && matches(command, RESTART, { powershell: name === 'PowerShell' });
  }
  return MCP_RESTART.test(name);
}

const whole = (v, d, min) => (typeof v === 'number' && Number.isInteger(v) && v >= min ? v : d);

function limits(cfg) {
  const c = cfg.ciRetry && typeof cfg.ciRetry === 'object' ? cfg.ciRetry : {};
  const hours = typeof c.windowHours === 'number' && Number.isFinite(c.windowHours) && c.windowHours > 0 ? c.windowHours : DEFAULTS.windowHours;
  return {
    enabled: c.enabled === true,
    freeRetries: whole(c.freeRetries, DEFAULTS.freeRetries, 0),
    hardCap: whole(c.hardCap, DEFAULTS.hardCap, 1),
    windowHours: hours,
  };
}

// Timestamps (ms) of the ledger lines inside the window, oldest first; an unreadable ledger or line counts as none.
function recent(file, since) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = Date.parse(JSON.parse(line).ts);
      if (Number.isFinite(t) && t > since) out.push(t);
    } catch {
      /* a broken line is skipped */
    }
  }
  return out.sort((a, b) => a - b);
}

function record(file, input, reason) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : input.tool_name;
    const line = { ts: new Date().toISOString(), command: String(command).replace(/\s+/g, ' ').slice(0, 300), session: input.session_id || null, tool: input.tool_name };
    if (reason) line.reason = true;
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {
    /* fail open: the restart is allowed even when it cannot be recorded */
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

if (require.main === module) {
  run((input) => {
    if (!isRestart(input)) return;
    const cwd = input.cwd || process.cwd();
    if (!optedIn(cwd)) return; // a project without .claude/ghorc.json never opted in
    const lim = limits(load(cwd));
    if (!lim.enabled) return;

    const root = projectRoot(cwd);
    const ledger = path.join(root, LEDGER_REL);
    const reasonFile = path.join(root, REASON_REL);
    const now = Date.now();
    const windowMs = lim.windowHours * 3600 * 1000;
    const times = recent(ledger, now - windowMs);
    const n = times.length;
    const head = `ci-retry-guard: ${n} CI restart(s) in the last ${lim.windowHours} h (free ${lim.freeRetries}, hard cap ${lim.hardCap}).`;

    if (n >= lim.hardCap) {
      const frees = new Date(times[n - lim.hardCap] + windowMs).toISOString();
      return deny(
        `${head} The hard cap is reached: do not restart again. Report to the owner what failed and the error signature, and fix ` +
          `the cause instead. The window frees a restart at ${frees}.`,
      );
    }
    if (n < lim.freeRetries) return record(ledger, input, false);

    const m = mtime(reasonFile);
    const last = n ? times[n - 1] : 0;
    if (m !== null && m >= now - REASON_FRESH_MS && m > last) return record(ledger, input, true);
    return deny(
      `${head} Another restart needs a reason first: write ${reasonFile} with what failed, the error signature (the failing ` +
        'log line, quoted) and why a retry and not a fix, then run the command again. The file counts for 30 minutes and only ' +
        'when written after the last restart.',
    );
  }, 'ci-retry-guard');
}

module.exports = { isRestart, limits, recent };
