'use strict';
// Command matching for the heavy-check guard.
// A command is cut into segments on && || ; | and newline (quoted strings are blanked first), and a pattern must match
// at the start of a segment, after optional env assignments (FOO=bar) and an optional `npm run` / `npx` prefix.

// Subagent-only denies, built in (not from config).
const BUILTIN_SUBAGENT_DENY = [/^\s*claude\b.*\s-p\b/i, /^\s*herdr\s+agent\s+start\b/i, /^\s*herdr\s+agent\s+prompt\b/i];

// Used only while the project config is invalid (the owner's heavyCommands cannot be trusted or read).
const DEFAULT_HEAVY = [
  /^npm\s+(?:run\s+)?test\b/i,
  /^npm\s+run\s+(?:test:\S+|wf:check|e2e)\b/i,
  /^npx\s+(?:playwright|vitest|jest)\b/i,
  /^(?:pytest|py\.test)\b/i,
  /^cargo\s+test\b/i,
  /^go\s+test\b/i,
  /^dotnet\s+test\b/i,
  /^make\s+(?:full|test|check)\b/i,
  /^(?:gradlew?|mvn)\s+(?:test|verify)\b/i,
];

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const RUNNER_PREFIX = /^(?:npm\s+run|npx)\s+/i;

function stripQuotes(command) {
  return String(command).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

function segments(command) {
  return stripQuotes(command)
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The forms of one segment a pattern is tried against: as written, and without the npm run / npx runner.
function variants(segment) {
  const a = segment.replace(ENV_PREFIX, '');
  return [a, a.replace(RUNNER_PREFIX, '')];
}

// regexes: RegExp[]. True when any matches at the start of any segment.
function matches(command, regexes) {
  for (const seg of segments(command)) {
    for (const v of variants(seg)) {
      for (const re of regexes) {
        const m = re.exec(v);
        if (m && m.index === 0) return true;
      }
    }
  }
  return false;
}

// Config strings -> compiled regexes; bad ones are dropped (validation reports them separately).
function compile(patterns) {
  const out = [];
  for (const p of patterns || []) {
    if (typeof p !== 'string' || p === '') continue;
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      /* skipped */
    }
  }
  return out;
}

module.exports = { BUILTIN_SUBAGENT_DENY, DEFAULT_HEAVY, segments, stripQuotes, matches, compile };
