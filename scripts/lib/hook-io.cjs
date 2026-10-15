'use strict';
// Shared hook helpers: reading stdin, the deny decision, per-session state in tmpdir.
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, atomicWrite } = require('./tmp.cjs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// The only output a hook may write to stdout is the decision JSON.
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

function safeId(s) {
  return String(s || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

function stateDir(sessionId) {
  return path.join(tmpDir(), safeId(sessionId));
}

function readState(sessionId, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(sessionId), name), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(sessionId, name, data) {
  try {
    const dir = stateDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, name), JSON.stringify(data));
  } catch {
    /* state is optional */
  }
}

// GHORC_HOOK_DUMP=<file>: appends the raw hook stdin JSON (one line per call). Off by default.
function dumpPayload(raw) {
  try {
    const f = process.env.GHORC_HOOK_DUMP;
    if (f && raw && raw.trim()) fs.appendFileSync(f, raw.replace(/\r?\n/g, ' ').trim() + '\n');
  } catch {
    /* the dump is optional */
  }
}

// Wrapper: any failure exits 0 silently (allow).
function run(fn) {
  try {
    const raw = readStdin();
    dumpPayload(raw);
    const input = parseInput(raw);
    if (input) fn(input);
  } catch {
    /* fail open */
  }
  process.exit(0);
}

module.exports = { readStdin, parseInput, deny, safeId, stateDir, readState, writeState, run };
