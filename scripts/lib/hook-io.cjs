'use strict';
// Общие помощники хуков: чтение stdin, решение deny, состояние в tmpdir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

// Единственный разрешённый вывод хука в stdout - JSON решения.
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
  return path.join(os.tmpdir(), 'ghorc', safeId(sessionId));
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
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  } catch {
    /* состояние необязательно */
  }
}

// Обёртка: любой сбой - тихий выход 0 (разрешить).
function run(fn) {
  try {
    const input = parseInput(readStdin());
    if (input) fn(input);
  } catch {
    /* fail open */
  }
  process.exit(0);
}

module.exports = { readStdin, parseInput, deny, safeId, stateDir, readState, writeState, run };
