'use strict';
// Command matching for the heavy-check guard.
// A command is cut into segments on && || ; | & newline ( ) { } $( and backticks (quoted strings are blanked first, but
// the quoted argument of a shell wrapper such as bash -c / cmd /c / powershell -Command is inlined, and $(...) or
// backtick substitutions inside double quotes are kept). A pattern must match at the start of a segment, after optional
// env assignments (FOO=bar), shell wrappers (cmd /c, bash -c, powershell -Command, call, &) and an optional
// `npm run` / `npx` prefix; npm global options (--prefix x, -C x, -w x, --silent) are dropped and run-script reads as run.
// Bash heredoc bodies (<<EOF ... EOF) are not commands and are removed first (an unterminated one is kept). For the
// PowerShell tool and powershell/pwsh wrappers the command is also read with PowerShell quoting (backtick escapes, a
// backslash is plain text, the -Command argument runs to the last quote); a segment found either way counts.

// Subagent-only denies, built in (not from config).
// herdr: starting an agent, and every way to put text or keys into another pane (the lead's prompt channel).
const HERDR = String.raw`^\s*(?:\S*[\\/])?herdr(?:\.exe)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+`;
const BUILTIN_SUBAGENT_DENY = [
  /^\s*claude\b.*\s(?:-p|--print)\b/i,
  new RegExp(`${HERDR}(?:agent\\s+(?:start|prompt|send-keys)|pane\\s+(?:run|send-keys|send-text))\\b`, 'i'),
];

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
  String.raw`^(?:${SHELLS}(?:\s+(?:[-/][\w:-]+|\w+))*?\s+(?:-l?c|/c|/k|-command)\s+|call\s+|time\s+|exec\s+|env\s+(?:-\w+\s+)*|command\s+|nohup\s+)`,
  'i',
);
const BASH_DQ = String.raw`"(?:[^"\\]|\\.)*"`;
const PS_DQ = String.raw`"(?:[^"\x60]|\x60[\s\S])*"`;
const SQ = "'[^']*'";
const WRAP_HEAD = String.raw`(^|[\s;&|(\x60{])(${SHELLS}(?:\s+(?:[-/][\w:-]+|\w+))*?\s+)`;
// A shell wrapper followed (after its flags) by a quoted argument: the quotes are dropped so the argument is matched too.
const WRAPPED_QUOTE = new RegExp(`${WRAP_HEAD}(${BASH_DQ}|${SQ})`, 'gi');
const WRAPPED_QUOTE_PS = new RegExp(`${WRAP_HEAD}(${PS_DQ}|${SQ})`, 'gi');
const PS_WRAPPER = /(^|[\s;&|(\x60{])(?:powershell|pwsh)(?:\.exe)?\s/i;
// powershell -Command "..." at the end of the command: everything between the first and the last quote is the script.
const PS_GREEDY = /(^|[\s;&|(\x60{])((?:powershell|pwsh)(?:\.exe)?(?:\s+(?:[-/][\w:-]+|\w+))*?\s+)"([\s\S]*)"\s*$/i;
// npm global options before the subcommand; the listed ones take a value.
const NPM_OPTS = /^npm((?:\s+(?:(?:--prefix|-C|--workspace|-w)(?:=|\s+)\S+|-{1,2}[\w-]+(?:=\S+)?))+)(?=\s)/i;

function inlineWrapped(command, ps) {
  let s = String(command);
  const re = ps ? WRAPPED_QUOTE_PS : WRAPPED_QUOTE;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(re, (_m, pre, head, q) => `${pre}${head}${q.slice(1, -1)}`);
    if (next === s) break;
    s = next;
  }
  return s;
}

// Quoted text is blanked; inside double quotes $(...) and backtick substitutions run, so they are kept as segments.
function stripQuotes(command, ps = false) {
  const quoted = new RegExp(`${ps ? PS_DQ : BASH_DQ}|${SQ}`, 'g');
  return inlineWrapped(command, ps).replace(quoted, (q) => {
    if (q[0] !== '"') return '""';
    const subs = [];
    q.replace(/\$\(([^)]*)\)|`([^`]*)`/g, (_m, a, b) => subs.push(a !== undefined ? a : b));
    return subs.length ? `"";${subs.join(';')};` : '""';
  });
}

// Heredoc operators on one line, outside quotes: [{ tag, dash }]. <<< (a here-string) is not one.
function heredocTags(line) {
  const masked = line.replace(new RegExp(`${BASH_DQ}|${SQ}`, 'g'), (q) => ' '.repeat(q.length));
  const out = [];
  const re = /<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?(\w+))/g;
  let m;
  while ((m = re.exec(line))) {
    if (masked.slice(m.index, m.index + 2) !== '<<' || line[m.index - 1] === '<') continue;
    out.push({ tag: m[2] || m[3] || m[4], dash: m[1] === '-' });
  }
  return out;
}

// Drops heredoc bodies and their terminator lines; the command line that opens a heredoc stays.
function stripHeredocs(text) {
  if (!text.includes('<<')) return text;
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    for (const { tag, dash } of heredocTags(lines[i])) {
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        let l = lines[j].replace(/\r$/, '');
        if (dash) l = l.replace(/^\t+/, '');
        if (l === tag) {
          end = j;
          break;
        }
      }
      if (end < 0) break; // unterminated: bash would not read a body either, so the lines stay matchable
      i = end;
    }
  }
  return out.join('\n');
}

const cut = (text, ps) =>
  stripQuotes(text, ps)
    .split(/&&|\|\||\$\(|[;|&\n()`{}]/)
    .map((s) => s.trim())
    .filter(Boolean);

// opts.powershell: the command comes from the PowerShell tool.
function segments(command, opts = {}) {
  const raw = String(command);
  const out = cut(stripHeredocs(raw), false);
  if (opts.powershell || PS_WRAPPER.test(raw)) {
    const ps = raw.replace(PS_GREEDY, (_m, pre, head, body) => `${pre}${head}${body}`);
    for (const s of cut(ps, true)) if (!out.includes(s)) out.push(s);
  }
  return out;
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
function matches(command, regexes, opts = {}) {
  for (const seg of segments(command, opts)) {
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
