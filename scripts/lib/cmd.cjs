'use strict';
// Command matching for the heavy-check guard.
// A command is cut into segments on && || ; | & newline ( ) { } $( and backticks (quoted strings are blanked first, but
// the quoted argument of a shell wrapper such as bash -c / cmd /c / powershell -Command is inlined, and $(...) or
// backtick substitutions inside double quotes are kept). A pattern must match at the start of a segment, after optional
// env assignments (FOO=bar), shell wrappers (cmd /c, bash -c, powershell -Command, call, &) and an optional
// `npm run` / `npx` prefix; npm global options (--prefix x, -C x, -w x, --silent) are dropped and run-script reads as run.

// Subagent-only denies, built in (not from config).
const BUILTIN_SUBAGENT_DENY = [/^\s*claude\b.*\s(?:-p|--print)\b/i, /^\s*herdr\s+agent\s+start\b/i, /^\s*herdr\s+agent\s+prompt\b/i];

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
// Shell wrappers that run their argument as a command line.
const SHELLS = String.raw`(?:bash|sh|zsh|dash|cmd|powershell|pwsh)(?:\.exe)?`;
const WRAPPER_PREFIX = new RegExp(
  String.raw`^(?:${SHELLS}(?:\s+(?:[-/][\w:-]+|\w+))*?\s+(?:-l?c|/c|/k|-command)\s+|call\s+|time\s+|exec\s+)`,
  'i',
);
// A shell wrapper followed (after its flags) by a quoted argument: the quotes are dropped so the argument is matched too.
const WRAPPED_QUOTE = new RegExp(String.raw`(^|[\s;&|(\x60{])(${SHELLS}(?:\s+(?:[-/][\w:-]+|\w+))*?\s+)("(?:[^"\\]|\\.)*"|'[^']*')`, 'gi');
// npm global options before the subcommand; the listed ones take a value.
const NPM_OPTS = /^npm((?:\s+(?:(?:--prefix|-C|--workspace|-w)(?:=|\s+)\S+|-{1,2}[\w-]+(?:=\S+)?))+)(?=\s)/i;

function inlineWrapped(command) {
  let s = String(command);
  for (let i = 0; i < 4; i++) {
    const next = s.replace(WRAPPED_QUOTE, (_m, pre, head, q) => `${pre}${head}${q.slice(1, -1)}`);
    if (next === s) break;
    s = next;
  }
  return s;
}

// Quoted text is blanked; inside double quotes $(...) and backtick substitutions run, so they are kept as segments.
function stripQuotes(command) {
  return inlineWrapped(command).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => {
    if (q[0] !== '"') return '""';
    const subs = [];
    q.replace(/\$\(([^)]*)\)|`([^`]*)`/g, (_m, a, b) => subs.push(a !== undefined ? a : b));
    return subs.length ? `"";${subs.join(';')};` : '""';
  });
}

function segments(command) {
  return stripQuotes(command)
    .split(/&&|\|\||\$\(|[;|&\n()`{}]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The forms of one segment a pattern is tried against: as written, and without the npm run / npx runner.
function variants(segment) {
  let a = segment.replace(ENV_PREFIX, '');
  for (let i = 0; i < 4; i++) {
    const b = a.replace(WRAPPER_PREFIX, '').replace(ENV_PREFIX, '');
    if (b === a) break;
    a = b;
  }
  a = a.replace(NPM_OPTS, 'npm').replace(/^npm\s+run-script\b/i, 'npm run');
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
