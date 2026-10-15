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

// Set by run(fn, hookName): who is denying, for the denial log.
let denyCtx = null;

// Appends "<iso time> <session8> <hook> <reason>" to <tmp>/denials.log. Never throws.
function logDenial(sessionId, hook, reason) {
  try {
    fs.mkdirSync(tmpDir(), { recursive: true });
    const sid8 = safeId(sessionId).slice(0, 8);
    const text = String(reason).replace(/\s+/g, ' ').slice(0, 300);
    fs.appendFileSync(path.join(tmpDir(), 'denials.log'), `${new Date().toISOString()} ${sid8} ${hook} ${text}\n`);
  } catch {
    /* the log is optional */
  }
}

// The only output a hook may write to stdout is the decision JSON.
function deny(reason) {
  if (denyCtx) logDenial(denyCtx.sid, denyCtx.hook, reason);
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
function run(fn, hookName) {
  try {
    const raw = readStdin();
    dumpPayload(raw);
    const input = parseInput(raw);
    if (input) {
      if (hookName) denyCtx = { sid: input.session_id, hook: hookName };
      fn(input);
    }
  } catch {
    /* fail open */
  }
  process.exit(0);
}

module.exports = { readStdin, parseInput, deny, logDenial, safeId, stateDir, readState, writeState, run };
