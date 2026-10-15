'use strict';
// Shared temp locations and the watchdog lock/alert helpers. GHORC_TMP overrides <os.tmpdir()>/ghorc (used by tests).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir() {
  return process.env.GHORC_TMP && process.env.GHORC_TMP.trim() ? process.env.GHORC_TMP : path.join(os.tmpdir(), 'ghorc');
}
const pidFile = () => path.join(tmpDir(), 'watchdog.pid');
const logFile = () => path.join(tmpDir(), 'watchdog.log');
const alertsFile = () => path.join(tmpDir(), 'alerts.log');
const offsetFile = () => path.join(tmpDir(), 'alerts.offset');

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

function readPid(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// The watchdog should be started unless the lock file names a live process.
function shouldStartWatchdog(file = pidFile()) {
  const pid = readPid(file);
  return pid === null || !isAlive(pid);
}

// Unread alert lines: { lines, size } where size is the byte offset to store after reading.
function unreadAlerts() {
  try {
    const buf = fs.readFileSync(alertsFile());
    let off = 0;
    try {
      off = Number(fs.readFileSync(offsetFile(), 'utf8').trim()) || 0;
    } catch {
      /* no offset yet */
    }
    if (off > buf.length) off = 0;
    const lines = buf
      .subarray(off)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    return { lines, size: buf.length };
  } catch {
    return { lines: [], size: 0 };
  }
}

function markAlertsRead(size) {
  try {
    fs.mkdirSync(tmpDir(), { recursive: true });
    fs.writeFileSync(offsetFile(), String(size));
  } catch {
    /* optional */
  }
}

module.exports = { tmpDir, pidFile, logFile, alertsFile, offsetFile, isAlive, readPid, shouldStartWatchdog, unreadAlerts, markAlertsRead };
