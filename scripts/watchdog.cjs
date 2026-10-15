'use strict';
// Transcript watchdog: polls ~/.claude/projects/**/*.jsonl. It only notifies and never kills anything.
// Thresholds per STRATEGY §10: growth >10 MiB/min for two minutes in a row; >100 MiB; >250 MiB and growing; subagents/*.jsonl >500 MiB.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tmp = require('./lib/tmp.cjs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    [
      'watchdog.cjs [--interval <sec, 30>] [--rateMiBPerMin 10] [--streakSec 120] [--warnMiB 100] [--stopMiB 250]',
      '             [--subagentsMiB 500] [--root <dir, default ~/.claude/projects>] [--once] [--notify "<command>"]',
      '             [--notify-file <path>] [--pid-file <path, default <tmp>/ghorc/watchdog.pid>]',
      'Alerts: growth above rateMiBPerMin continuously for streakSec seconds; size above warnMiB (check the content);',
      'above stopMiB and still growing; a file under subagents/ above subagentsMiB.',
      '--notify: the command runs through the shell (.cmd/.bat work) in the background with a 10 s timer; the alert text is ONE quoted argument (and the GHORC_ALERT variable).',
      '--notify-file: every alert is also appended as a line "<ISO time> <text>" to this file (scripts/ctx.cjs shows unread lines).',
      'Size alerts are remembered in <tmp>/ghorc/watchdog-state.json: a restart does not repeat them; one repeats only after the file grew by warnMiB/2 or its level rose.',
      'Unless --once is given, the pid is written to the pid file at start and removed on exit.',
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
const root = opt('--root', path.join(os.homedir(), '.claude', 'projects'));
const once = args.includes('--once');
const notify = opt('--notify', null);
const notifyFile = opt('--notify-file', null);
const pidFile = opt('--pid-file', tmp.pidFile());
const MiB = 1024 * 1024;

// One shell argument: double quotes on Windows, single quotes elsewhere.
function quoteArg(s) {
  if (process.platform === 'win32') return '"' + String(s).replace(/"/g, '\\"') + '"';
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

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
  // Through the shell (.cmd/.bat work); we do not wait for it and kill it after 10 s.
  try {
    const child = spawn(`${notify} ${quoteArg(text)}`, {
      shell: true,
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

const prev = new Map(); // path -> { size, t, fastSince, streakAlerted }

// Size alerts persist across restarts: path -> { size, level, sizes: { <level>: size at its last alert } }.
// Levels: 1 = over warnMiB, 2 = over stopMiB and growing, 3 = subagent file over subagentsMiB.
// A level alerts again only after the file grew by warnMiB/2 since that level's last alert.
const stateFile = path.join(tmp.tmpDir(), 'watchdog-state.json');
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
    fs.writeFileSync(stateFile, JSON.stringify(alerted));
    stateDirty = false;
  } catch {
    /* the state file is optional */
  }
}

function pass() {
  const now = Date.now();
  const files = walk(root, []);
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
    const st = prev.get(p) || { size, t: now, fastSince: null, streakAlerted: false };
    const dtMin = (now - st.t) / 60000;
    const delta = size - st.size;
    const rate = dtMin > 0 ? delta / MiB / dtMin : 0;
    const info = `${p} size=${(size / MiB).toFixed(1)}MiB rate=${rate.toFixed(1)}MiB/min`;

    if (!first) {
      if (rate > rateMiB) {
        if (st.fastSince === null) st.fastSince = st.t;
        if (!st.streakAlerted && now - st.fastSince >= streakMs) {
          alert(`growth above ${rateMiB} MiB/min for longer than ${streakMs / 1000} s: ${info}`);
          st.streakAlerted = true;
        }
      } else {
        st.fastSince = null;
        st.streakAlerted = false;
      }
      if (size > stopMiB * MiB && delta > 0 && sizeAlertDue(p, 2, size)) {
        alert(`ALARM, over ${stopMiB} MiB and growing: ${info}`);
        markSizeAlert(p, 2, size);
      }
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
    fs.writeFileSync(pidFile, String(process.pid));
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
