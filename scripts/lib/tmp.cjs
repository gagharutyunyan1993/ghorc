'use strict';
// Shared temp locations, atomic writes, cleanup, and the watchdog pid/heartbeat/alert helpers.
// Temp dir: <os.tmpdir()>/ghorc-<username>; GHORC_TMP overrides it (used by tests).
// Watchdog files are per project root: their names carry a short hash of the root.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DAY_MS = 24 * 3600 * 1000;

function safeName(s) {
  return String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || 'user';
}

function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || 'user';
  }
}

function tmpDir() {
  const env = process.env.GHORC_TMP;
  return env && env.trim() ? env : path.join(os.tmpdir(), `ghorc-${safeName(userName())}`);
}

function rootHash(root) {
  let r = path.resolve(root || process.cwd());
  if (process.platform === 'win32') r = r.toLowerCase();
  return crypto.createHash('sha1').update(r).digest('hex').slice(0, 8);
}

// Per-session context files written by the status line, one directory per project root, outside the project:
// <tmp>/ghorc-<user>/ctx/<root hash>/ctx-<session>.json (before 0.11 they were <root>/.claude/ctx-<session>.json).
const ctxDir = (root) => path.join(tmpDir(), 'ctx', rootHash(root));
const ctxFile = (root, sid) => path.join(ctxDir(root), `ctx-${String(sid).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
// The ctx directory of a project, made (0700) when missing; null when it, its parent `ctx` or the tmp dir is not a real
// directory owned by this user (POSIX), or not private: another user's planted directory or symlink is never written to.
function ensureCtxDir(root) {
  const dirs = [tmpDir(), path.join(tmpDir(), 'ctx'), ctxDir(root)];
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
    }
    if (!privateDir(d)) return null;
  }
  return dirs[2];
}
// A real directory (not a symlink); on POSIX owned by this uid and not writable by group or others.
function privateDir(d) {
  let st;
  try {
    st = fs.lstatSync(d);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  if (typeof process.getuid === 'function' && (st.uid !== process.getuid() || (st.mode & 0o022) !== 0)) return false;
  return true;
}
const pidFile = (root) => path.join(tmpDir(), `watchdog-${rootHash(root)}.pid`);
const heartbeatFile = (root) => path.join(tmpDir(), `watchdog-${rootHash(root)}.beat`);
const logFile = (root) => path.join(tmpDir(), `watchdog-${rootHash(root)}.log`);
const stateFile = (root) => path.join(tmpDir(), `watchdog-${rootHash(root)}.state.json`);
const alertsFile = (root) => path.join(tmpDir(), `alerts-${rootHash(root)}.log`);
const offsetFile = (root, sid) => path.join(tmpDir(), `alerts-${rootHash(root)}.${safeName(sid || 'nosession')}.offset`);

// Write through a temp file and rename, so a reader never sees a half-written file.
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// True when a process with this pid exists (signal 0 only probes).
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// pid file: JSON { pid, version, root, startedAt }; a bare number (older versions) reads as { pid }.
function readPidInfo(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && Number.isInteger(j.pid)) return j;
      if (Number.isInteger(j)) return { pid: j };
    } catch {
      /* not JSON */
    }
    return null;
  } catch {
    return null;
  }
}

function readPid(file) {
  const i = readPidInfo(file);
  return i ? i.pid : null;
}

// alive = pid alive AND heartbeat younger than 2 intervals AND version equals the running plugin version.
// Returns { alive, reason, pid }.
function watchdogStatus(root, version, intervalSec, now = Date.now()) {
  const info = readPidInfo(pidFile(root));
  if (!info) return { alive: false, reason: 'no pid file', pid: null };
  if (!isAlive(info.pid)) return { alive: false, reason: 'dead pid', pid: info.pid };
  if (version && info.version !== version) return { alive: false, reason: 'version mismatch', pid: info.pid };
  let beat = 0;
  try {
    beat = fs.statSync(heartbeatFile(root)).mtimeMs;
  } catch {
    /* no heartbeat yet: the start time counts */
  }
  const ref = Math.max(beat, Number(info.startedAt) || 0);
  const limit = 2 * Math.max(1, Number(intervalSec) || 30) * 1000;
  if (now - ref > limit) return { alive: false, reason: 'stale heartbeat', pid: info.pid };
  return { alive: true, reason: 'ok', pid: info.pid };
}

// Unread alert lines for one session: { lines, ends, size }. ends[i] is the byte offset just after lines[i].
function unreadAlerts(root, sid) {
  try {
    const buf = fs.readFileSync(alertsFile(root));
    let off = 0;
    try {
      off = Number(fs.readFileSync(offsetFile(root, sid), 'utf8').trim()) || 0;
    } catch {
      /* no offset yet */
    }
    if (off > buf.length) off = 0;
    const lines = [];
    const ends = [];
    let pos = off;
    while (pos < buf.length) {
      const nl = buf.indexOf(10, pos);
      const stop = nl < 0 ? buf.length : nl;
      const next = nl < 0 ? buf.length : nl + 1;
      const text = buf.subarray(pos, stop).toString('utf8').replace(/\r$/, '');
      if (text.trim()) {
        lines.push(text);
        ends.push(next);
      }
      pos = next;
    }
    return { lines, ends, size: buf.length };
  } catch {
    return { lines: [], ends: [], size: 0 };
  }
}

// Marks alerts read up to the byte offset `upTo` (the end of the last line that was shown).
function markAlertsRead(root, sid, upTo) {
  try {
    fs.mkdirSync(tmpDir(), { recursive: true });
    atomicWrite(offsetFile(root, sid), String(upTo));
  } catch {
    /* optional */
  }
}

// Denial log summary: { total, last: string[] (up to n), counts: { <hook>: n } }.
function denials(n = 5) {
  const out = { total: 0, last: [], counts: {} };
  try {
    const lines = fs.readFileSync(path.join(tmpDir(), 'denials.log'), 'utf8').split(/\r?\n/).filter(Boolean);
    out.total = lines.length;
    out.last = lines.slice(-n);
    for (const l of lines) {
      const hook = l.split(' ')[2] || '?';
      out.counts[hook] = (out.counts[hook] || 0) + 1;
    }
  } catch {
    /* no log yet */
  }
  return out;
}

// Deletes every legacy ctx-*.json (and stray temp files) under <root>/.claude whatever its age (the status line no longer
// writes there), ctx files older than maxAgeDays under <tmp>/ctx/<any root>, leftover capacity ledger temp files under
// <root>/.claude/ghorc-out, plus session state dirs, alert offsets and handoff flags (handoff-*.json) in the tmp dir,
// when older than maxAgeDays. Returns the number of removed entries. Never throws.
function cleanup(root, maxAgeDays = 7, now = Date.now()) {
  let n = 0;
  const limit = maxAgeDays * DAY_MS;
  const old = (p) => {
    try {
      return now - fs.statSync(p).mtimeMs > limit;
    } catch {
      return false;
    }
  };
  const rm = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      n++;
    } catch {
      /* ignore */
    }
  };
  try {
    const dir = path.join(root, '.claude');
    for (const f of fs.readdirSync(dir)) {
      if (/^ctx-.*\.json(\..*\.tmp)?$/.test(f)) rm(path.join(dir, f));
    }
  } catch {
    /* no directory */
  }
  try {
    // every project's ctx directory: old files, then a directory left empty
    // only real, private directories and regular files: a symlink is never followed, a file is removed without recursion
    const base = path.join(tmpDir(), 'ctx');
    if (privateDir(base)) {
      for (const h of fs.readdirSync(base, { withFileTypes: true })) {
        const d = path.join(base, h.name);
        if (!h.isDirectory() || !privateDir(d)) continue;
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (!f.isFile() || !old(p)) continue;
          try {
            fs.unlinkSync(p);
            n++;
          } catch {
            /* ignore */
          }
        }
        try {
          fs.rmdirSync(d); // only when empty
          n++;
        } catch {
          /* not empty */
        }
      }
    }
  } catch {
    /* no directory */
  }
  try {
    // temp files of a failed ledger compaction (capacity-ledger.jsonl.<pid>.tmp)
    const dir = path.join(root, '.claude', 'ghorc-out');
    for (const f of fs.readdirSync(dir)) {
      if (/^capacity-ledger\.jsonl\.[^.]*\.tmp$/.test(f) && old(path.join(dir, f))) rm(path.join(dir, f));
    }
  } catch {
    /* no directory */
  }
  try {
    // denials.log keeps maxAgeDays: lines start with an ISO time
    const f = path.join(tmpDir(), 'denials.log');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
    const keep = lines.filter((l) => {
      const t = Date.parse(l.split(' ')[0]);
      return !Number.isFinite(t) || now - t <= limit;
    });
    if (keep.length !== lines.length) {
      atomicWrite(f, keep.length ? `${keep.join('\n')}\n` : '');
      n += lines.length - keep.length;
    }
  } catch {
    /* no log */
  }
  try {
    const dir = tmpDir();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && old(p)) rm(p);
      else if (e.isFile() && (/\.offset$/.test(e.name) || /\.tmp$/.test(e.name) || /^handoff-.*\.json$/.test(e.name)) && old(p)) rm(p);
    }
  } catch {
    /* no directory */
  }
  return n;
}

module.exports = {
  tmpDir,
  safeName,
  rootHash,
  ctxDir,
  ctxFile,
  ensureCtxDir,
  privateDir,
  pidFile,
  heartbeatFile,
  logFile,
  stateFile,
  alertsFile,
  offsetFile,
  atomicWrite,
  isAlive,
  readPid,
  readPidInfo,
  watchdogStatus,
  unreadAlerts,
  markAlertsRead,
  denials,
  cleanup,
};
