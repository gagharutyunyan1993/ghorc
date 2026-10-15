'use strict';
// Transcript watchdog: polls the *.jsonl transcripts (subagents/ included) of ONE project. It only notifies and never kills anything.
// Thresholds per STRATEGY §10: growth >10 MiB/min for two minutes in a row; >100 MiB; >250 MiB and growing; subagents/*.jsonl >500 MiB.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tmp = require('./lib/tmp.cjs');
const watch = require('./lib/watch.cjs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    [
      'watchdog.cjs [--interval <sec, 30>] [--rateMiBPerMin 10] [--streakSec 120] [--warnMiB 100] [--stopMiB 250]',
      '             [--subagentsMiB 500] [--transcript-dir <dir>] [--project-root <dir>] [--version <v>] [--once]',
      '             [--notify "<program and args>"] [--notify-file <path>] [--pid-file <path>] [--heartbeat-file <path>]',
      'One watchdog per project root. It scans only --transcript-dir (default: ~/.claude/projects/<encoded project root>), including subagents/.',
      'pid file: JSON { pid, version, root, startedAt }; the heartbeat file is touched every poll (SessionStart restarts a stale or old-version watchdog).',
      'Alerts: growth above rateMiBPerMin for streakSec seconds (one slow poll lowers the streak by 1, it does not reset it); size above warnMiB',
      '(check the content); above stopMiB and growing, or already above it when first seen; a file under subagents/ above subagentsMiB.',
      '--notify: the string is split into an argv array (double quotes group words) and spawned WITHOUT a shell, with a 10 s timer; the alert text is the last argument (and the GHORC_ALERT variable). For a .cmd/.bat script use: --notify "cmd /c script.cmd".',
      '--notify-file: every alert is also appended as a line "<ISO time> <text>" to this file (scripts/ctx.cjs shows unread lines).',
      'Size alerts are remembered in <tmp>/ghorc-<user>/watchdog-<root hash>.state.json: a restart does not repeat them; one repeats only after the file grew by warnMiB/2 or its level rose.',
      'Unless --once is given, the pid file is written at start and removed on exit.',
      'The watchdog stops nobody.',
    ].join('\n'),
  );
  process.exit(0);
}
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const interval = Number(opt('--interval', 30));
const rateMiB = Number(opt('--rateMiBPerMin', 10));
const streakMs = Number(opt('--streakSec', 120)) * 1000;
const warnMiB = Number(opt('--warnMiB', 100));
const stopMiB = Number(opt('--stopMiB', 250));
const subMiB = Number(opt('--subagentsMiB', 500));
const projectRoot = path.resolve(opt('--project-root', process.cwd()));
const version = opt('--version', null);
// --root is the older name of --transcript-dir
const scanDir = opt('--transcript-dir', opt('--root', path.join(os.homedir(), '.claude', 'projects', projectRoot.replace(/[^A-Za-z0-9]/g, '-'))));
const once = args.includes('--once');
const notify = opt('--notify', null);
const notifyFile = opt('--notify-file', null);
const pidFile = opt('--pid-file', tmp.pidFile(projectRoot));
const beatFile = opt('--heartbeat-file', tmp.heartbeatFile(projectRoot));
const MiB = 1024 * 1024;

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function alert(text) {
  console.log(`[ghorc watchdog] ${text}`);
  if (notifyFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(notifyFile)), { recursive: true });
      fs.appendFileSync(notifyFile, `${new Date().toISOString()} ${text.replace(/\r?\n/g, ' ')}\n`);
    } catch {
      /* the alert file is optional */
    }
  }
  if (!notify) return;
  // argv array, no shell; we do not wait for it and kill it after 10 s.
  try {
    const argv = watch.splitCommand(notify);
    if (!argv.length) return;
    const child = spawn(argv[0], [...argv.slice(1), text], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, GHORC_ALERT: text },
    });
    child.on('error', (e) => console.log(`[ghorc watchdog] notify failed to start: ${e.message}`));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    }, 10000);
    timer.unref();
    child.on('exit', () => clearTimeout(timer));
  } catch {
    /* the notification is optional */
  }
}

const prev = new Map(); // path -> { size, t, streak, streakAlerted }

// Size alerts persist across restarts: path -> { size, level, sizes: { <level>: size at its last alert } }.
// Levels: 1 = over warnMiB, 2 = over stopMiB and growing, 3 = subagent file over subagentsMiB.
// A level alerts again only after the file grew by warnMiB/2 since that level's last alert.
const stateFile = opt('--state-file', tmp.stateFile(projectRoot));
let alerted = {};
try {
  const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (j && typeof j === 'object' && !Array.isArray(j)) alerted = j;
} catch {
  /* no state yet */
}
let stateDirty = false;

function sizeAlertDue(p, level, size) {
  const e = alerted[p];
  const last = e && e.sizes ? e.sizes[level] : undefined;
  if (!Number.isFinite(last)) return true;
  return size - last >= (warnMiB / 2) * MiB;
}

function markSizeAlert(p, level, size) {
  const e = alerted[p] && alerted[p].sizes ? alerted[p] : { sizes: {} };
  e.sizes[level] = size;
  e.size = size;
  e.level = Math.max(Number(e.level) || 0, level);
  alerted[p] = e;
  stateDirty = true;
}

function saveState() {
  if (!stateDirty) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    tmp.atomicWrite(stateFile, JSON.stringify(alerted));
    stateDirty = false;
  } catch {
    /* the state file is optional */
  }
}

function touchBeat() {
  try {
    fs.mkdirSync(path.dirname(beatFile), { recursive: true });
    fs.writeFileSync(beatFile, String(Date.now()));
  } catch {
    /* the heartbeat is optional */
  }
}

function pass() {
  const now = Date.now();
  if (!once) touchBeat();
  const files = walk(scanDir, []);
  const live = new Set(files);
  for (const k of [...prev.keys()]) if (!live.has(k)) prev.delete(k);
  for (const k of Object.keys(alerted)) {
    if (!live.has(k)) {
      delete alerted[k];
      stateDirty = true;
    }
  }

  for (const p of files) {
    let size;
    try {
      size = fs.statSync(p).size;
    } catch {
      continue;
    }
    const first = !prev.has(p);
    const st = prev.get(p) || { size, t: now, streak: 0, streakAlerted: false };
    const dtMin = (now - st.t) / 60000;
    const delta = size - st.size;
    const rate = dtMin > 0 ? delta / MiB / dtMin : 0;
    const info = `${p} size=${(size / MiB).toFixed(1)}MiB rate=${rate.toFixed(1)}MiB/min`;

    if (!first) {
      st.streak = watch.nextStreak(st.streak, rate > rateMiB);
      if (!st.streakAlerted && st.streak >= watch.pollsNeeded(streakMs, interval)) {
        alert(`growth above ${rateMiB} MiB/min for longer than ${streakMs / 1000} s: ${info}`);
        st.streakAlerted = true;
      }
      if (st.streak === 0) st.streakAlerted = false;
    }
    if (watch.stopAlarm(first, size, delta, stopMiB * MiB) && sizeAlertDue(p, 2, size)) {
      alert(`ALARM, over ${stopMiB} MiB${first ? ' (seen for the first time)' : ' and growing'}: ${info}`);
      markSizeAlert(p, 2, size);
    }
    if (size > warnMiB * MiB && sizeAlertDue(p, 1, size)) {
      alert(`over ${warnMiB} MiB, check what the content is: ${info}`);
      markSizeAlert(p, 1, size);
    }
    if (size > subMiB * MiB && /[\\/]subagents[\\/]/.test(p) && sizeAlertDue(p, 3, size)) {
      alert(`ALARM, subagent file over ${subMiB} MiB: ${info}`);
      markSizeAlert(p, 3, size);
    }
    st.size = size;
    st.t = now;
    prev.set(p, st);
  }
  saveState();
}

if (!once) {
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    tmp.atomicWrite(pidFile, JSON.stringify({ pid: process.pid, version, root: projectRoot, startedAt: Date.now() }));
  } catch {
    /* the lock is optional */
  }
  const cleanup = () => {
    try {
      if (tmp.readPid(pidFile) === process.pid) fs.unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}

pass();
if (!once) setInterval(pass, Math.max(1, interval) * 1000);
