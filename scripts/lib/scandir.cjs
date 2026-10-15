'use strict';
// Transcript dir helpers shared by session-start and the watchdog.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function strip(p) {
  return String(p).replace(/[\\/]+$/, '');
}

// Drive root ("C:", "C:\", also the drive-relative "C:"), "/", or the home dir.
function rootReason(dir) {
  const s = strip(dir);
  if (s === '' || /^[A-Za-z]:$/.test(s)) return 'drive root or filesystem root';
  const norm = (p) => (process.platform === 'win32' ? strip(path.resolve(p)).toLowerCase() : strip(path.resolve(p)));
  try {
    if (norm(dir) === norm(os.homedir())) return 'home dir';
    const r = path.parse(path.resolve(dir)).root;
    if (norm(dir) === norm(r)) return 'drive root or filesystem root';
  } catch {
    /* fall through */
  }
  return null;
}

// null when the dir is fine to scan, otherwise a short reason.
function refuseReason(dir) {
  if (!dir || typeof dir !== 'string') return 'no transcript dir';
  const r = rootReason(dir);
  if (r) return `${r}: ${dir}`;
  try {
    if (!fs.statSync(dir).isDirectory()) return `not a directory: ${dir}`;
  } catch {
    return `dir does not exist: ${dir}`;
  }
  return null;
}

// dirname of a transcript path with either slash style, whatever the platform.
function dirnameAny(p) {
  const lib = /^[A-Za-z]:|[\\]/.test(p) ? path.win32 : path.posix;
  return lib.dirname(p);
}

// Claude Code's project dir name: every non-alphanumeric char becomes "-".
function encodeCwd(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function deriveTranscriptDir(input, cwd) {
  if (process.env.GHORC_WATCHDOG_ROOT) return process.env.GHORC_WATCHDOG_ROOT;
  if (input && typeof input.transcript_path === 'string' && input.transcript_path) return dirnameAny(input.transcript_path);
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

module.exports = { rootReason, refuseReason, dirnameAny, encodeCwd, deriveTranscriptDir };
