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
// hc (herdr-app): run and exec start programs and agents, keys and interrupt drive another terminal. `hc send` is not in
// the list: it is the report channel of a worker to its parent, so heavy-check-guard.cjs judges it by its target
// (hcSendTargets below).
const HC = String.raw`^\s*(?:\S*[\\/])?hc(?:\.exe)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+`;
const BUILTIN_SUBAGENT_DENY = [
  /^\s*claude\b.*\s(?:-p|--print)\b/i,
  new RegExp(`${HERDR}(?:agent\\s+(?:start|prompt|send-keys)|pane\\s+(?:run|send-keys|send-text))\\b`, 'i'),
  new RegExp(`${HC}(?:run|exec|keys|interrupt)\\b`, 'i'),
];
// hc and herdr have global options that take a value (--on <machine>, --via ..., --session x), so a regex cannot tell where
// the subcommand starts. canonical() therefore reads the segment as words: the first dangerous verb (hc) or verb pair
// (herdr agent start, ...) anywhere after the program name - else, for hc, the first send - is moved right behind the
// program name, and the patterns above and below are tried against that form too.
const HC_PROGRAM = /^(?:\S*[\\/])?hc(?:\.exe)?$/i;
const HERDR_PROGRAM = /^(?:\S*[\\/])?herdr(?:\.exe)?$/i;
const HC_DANGEROUS = new Set(['run', 'exec', 'keys', 'interrupt']);
const HERDR_DANGEROUS = { agent: new Set(['start', 'prompt', 'send-keys']), pane: new Set(['run', 'send-keys', 'send-text']) };
function canonical(v) {
  const words = v.trim().split(/\s+/);
  const low = words.slice(1).map((w) => w.toLowerCase());
  let i = -1;
  if (HC_PROGRAM.test(words[0])) {
    i = low.findIndex((w) => HC_DANGEROUS.has(w));
    if (i < 0) i = low.indexOf('send');
  } else if (HERDR_PROGRAM.test(words[0])) {
    i = low.findIndex((w, k) => HERDR_DANGEROUS[w] instanceof Set && HERDR_DANGEROUS[w].has(low[k + 1]));
  } else return null;
  return i < 0 ? null : [words[0], ...words.slice(1 + i)].join(' ');
}
const HC_SEND = new RegExp(`${HC}send\\b`, 'i');
// `hc send [--force|--json|--wait|--if S|--timeout N] <target> <text>`: the target is the first word that is not an option.
const HC_SEND_TARGET = new RegExp(`${HC}send((?:\\s+(?:--(?:if|timeout)\\s+\\S+|--[\\w-]+))*)\\s+(\\S+)`, 'i');

// `herdr agent start` alone: launching a candidate lead or a worker (handoff.pushGuard).
const HERDR_AGENT_START = new RegExp(`${HERDR}agent\\s+start\\b`, 'i');
// The hc form: `hc run` of claude (a quoted prompt is blanked before matching, so only the program name counts).
const HC_AGENT_START = new RegExp(`${HC}run\\b.*\\bclaude(?:\\.exe)?\\b`, 'i');

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
const SHELLS = String.raw`(?:\S*[\\/])?(?:bash|sh|zsh|dash|cmd|powershell|pwsh)(?:\.exe)?`;
// env with a path (/usr/bin/env, C:\Git\usr\bin\env.exe) and its options: -i, -u NAME, NAME=value (peel drops those too).
const ENV_WRAPPER = String.raw`(?:\S*[\\/])?env(?:\.exe)?\s+(?:(?:-u\s+\S+|-\w+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*`;
// xargs and its options; the ones that take a separate value are listed (-I x, -n 1, -P 4, -s n, -E x, -d x, -a f, -L n).
const XARGS_WRAPPER = String.raw`(?:\S*[\\/])?xargs(?:\.exe)?\s+(?:(?:-[InPsEdaLJ]\s*\S+|--[\w-]+(?:=\S+)?|-\w+)\s+)*`;
const WRAPPER_PREFIX = new RegExp(
  String.raw`^(?:${SHELLS}(?:\s+(?:[-/][\w:-]+|\w+))*?\s+(?:-l?c|/c|/k|-command)\s+|call\s+|time\s+|exec\s+|${ENV_WRAPPER}|command\s+|nohup\s+)`,
  'i',
);
// The slot wrapper runs its command after `--`. A quoted path to heavy-slot.cjs is unquoted first (see segments); a quoted
// label is blanked to "". Options: --label x, --label=x, --label "x y", --label (no value).
// xargs and the wrappers below are peeled only in an extra form: a pattern on xargs itself (^xargs) keeps matching the unpeeled segment.
// The same for the other wrappers that only run their argument (E408, closes the open forms of E402#1). Each takes its own
// options, the ones with a separate value listed: timeout [-k D] [-s SIG] DURATION, nice [-n N], stdbuf -oL, sudo [-u U],
// setsid [-w], cmd /c start ["title"] [/b]. `timeout -k 1 5 herdr pane run ...` is peeled down to the herdr command.
const WRAPPER_PATH = String.raw`(?:\S*[\\/])?`;
const TIMEOUT_WRAPPER = String.raw`${WRAPPER_PATH}timeout(?:\.exe)?\s+(?:(?:-[A-Za-z]*[ks]\s*\S+|--(?:kill-after|signal)(?:=|\s+)\S+|--[\w-]+|-\w+)\s+)*(?:inf(?:inity)?|[\d.]+[smhd]?)\s+`;
const NICE_WRAPPER = String.raw`${WRAPPER_PATH}nice(?:\.exe)?\s+(?:(?:-n\s*\S+|--adjustment(?:=|\s+)\S+|--?\d+|--?[A-Za-z][\w-]*)\s+)*`;
const STDBUF_WRAPPER = String.raw`${WRAPPER_PATH}stdbuf(?:\.exe)?\s+(?:(?:-[ioe]\s*\S+|--(?:input|output|error)(?:=|\s+)\S+)\s+)+`;
// sudo's options are case-sensitive (-H and -P take no value, -h and -p do), so it is peeled by its own regex without the i flag.
const SUDO_PREFIX = new RegExp(
  String.raw`^${WRAPPER_PATH}[Ss][Uu][Dd][Oo](?:\.[Ee][Xx][Ee])?\s+(?:(?:-[A-Za-z]*[ughpCDRrTU]\s+\S+|--(?:user|group|host|prompt|chdir|role|type|other-user|close-from)(?:=|\s+)\S+|--?[A-Za-z][\w-]*)\s+)*`,
);
const DOAS_WRAPPER = String.raw`${WRAPPER_PATH}doas(?:\.exe)?\s+(?:(?:-[uC]\s*\S+|-\w+)\s+)*`;
const CHROOT_WRAPPER = String.raw`${WRAPPER_PATH}chroot(?:\.exe)?\s+(?:(?:--(?:userspec|groups)(?:=|\s+)\S+|--[\w-]+)\s+)*\S+\s+`;
const WATCH_WRAPPER = String.raw`${WRAPPER_PATH}watch(?:\.exe)?\s+(?:(?:-[ni]\s*\S+|--interval(?:=|\s+)\S+|--?[A-Za-z][\w-]*)\s+)*`;
const PARALLEL_WRAPPER = String.raw`${WRAPPER_PATH}parallel(?:\.exe)?\s+(?:(?:-[jnNSalLsmXC]\s+\S+|--(?:jobs|max-args|max-procs|sshlogin|arg-file|delimiter)(?:=|\s+)\S+|--?[A-Za-z][\w-]*(?:=\S+)?)\s+)*`;
const IONICE_WRAPPER = String.raw`${WRAPPER_PATH}ionice(?:\.exe)?\s+(?:(?:-[cn]\s*\S+|--(?:class|classdata)(?:=|\s+)\S+|--?[A-Za-z][\w-]*)\s+)*`;
const CHRT_WRAPPER = String.raw`${WRAPPER_PATH}chrt(?:\.exe)?\s+(?:--?[A-Za-z][\w-]*\s+)*\d+\s+`;
const TASKSET_WRAPPER = String.raw`${WRAPPER_PATH}taskset(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*(?:(?:-c|--cpu-list)\s+\S+|0x[0-9a-f]+|\d[0-9a-f]*)\s+`;
// flock [-n] [-w S] FILE cmd, and flock FILE -c "cmd" (the quoted command is inlined, see WRAP_HEAD).
const FLOCK_BASE = String.raw`${WRAPPER_PATH}flock(?:\.exe)?\s+(?:(?:-[wE]\s*\S+|--(?:timeout|wait|conflict-exit-code)(?:=|\s+)\S+|--?[A-Za-z][\w-]*)\s+)*\S+\s+`;
const FLOCK_WRAPPER = String.raw`${FLOCK_BASE}(?:-c\s+)?`;
// script [-q] -c "cmd" [file]
const SCRIPT_HEAD = String.raw`${WRAPPER_PATH}script(?:\.exe)?\s+(?:(?:-[IOTEmo]\s+\S+|-[A-Za-z]+|--[\w-]+(?:=\S+)?)\s+)*?-[A-Za-z]*c\s+`;
// find ... -exec cmd {} \;  (the braces and ; cut the segment after cmd's arguments)
const FIND_WRAPPER = String.raw`${WRAPPER_PATH}find(?:\.exe)?\s+(?:\S+\s+)*?-(?:exec|execdir|ok|okdir)\s+`;
// PowerShell Invoke-Expression "cmd" / iex "cmd" (the quoted command is inlined, see WRAP_HEAD).
const IEX_HEAD = String.raw`(?:Invoke-Expression|iex)\s+(?:-Command\s+)?`;
const SETSID_WRAPPER = String.raw`${WRAPPER_PATH}setsid(?:\.exe)?\s+(?:(?:-[wcf]+|--(?:wait|ctty|fork))\s+)*`;
const START_WRAPPER = String.raw`start\s+(?:""\s+|"[^"]*"\s+)?(?:\/[A-Za-z]+\s+)*`;
const EXTRA_PREFIX = new RegExp(
  `^(?:${XARGS_WRAPPER}|${TIMEOUT_WRAPPER}|${NICE_WRAPPER}|${STDBUF_WRAPPER}|${SETSID_WRAPPER}|${START_WRAPPER}|${DOAS_WRAPPER}|${CHROOT_WRAPPER}|${WATCH_WRAPPER}|${PARALLEL_WRAPPER}|${IONICE_WRAPPER}|${CHRT_WRAPPER}|${TASKSET_WRAPPER}|${FLOCK_WRAPPER}|${SCRIPT_HEAD}|${FIND_WRAPPER}|${IEX_HEAD})`,
  'i',
);
const SLOT_WRAPPER_PREFIX = new RegExp(
  String.raw`^node(?:\.exe)?\s+(?:--?[\w-]+(?:=\S+)?\s+)*\S*heavy-slot\.cjs\s+run\s+(?:--[A-Za-z][\w-]*(?:=(?:""|\S*)|\s+(?!--(?:\s|$))(?:""|\S+))?\s+)*--\s+`,
  'i',
);
const QUOTED_SLOT_PATH = /(["'])(?:[^"']*[\\/])?heavy-slot\.cjs\1/g;
const BASH_DQ = String.raw`"(?:[^"\\]|\\.)*"`;
const PS_DQ = String.raw`"(?:[^"\x60]|\x60[\s\S])*"`;
const SQ = "'[^']*'";
// `start` is not a flag word of cmd: in `cmd /c start "title" hc run claude` the quoted title is blanked, not inlined.
// Only for cmd: for bash/powershell the word `start` stays an ordinary flag word, so their quoted argument is still inlined.
const SHELLS_OTHER = String.raw`(?:\S*[\\/])?(?:bash|sh|zsh|dash|powershell|pwsh)(?:\.exe)?`;
const SHELL_CMD = String.raw`(?:\S*[\\/])?cmd(?:\.exe)?`;
const WRAP_HEAD = String.raw`(^|[\s;&|(\x60{])(${SHELLS_OTHER}(?:\s+(?:[-/][\w:-]+|\w+))*?\s+|${SHELL_CMD}(?:\s+(?:[-/][\w:-]+|(?!start\b)\w+))*?\s+|${SCRIPT_HEAD}|${FLOCK_BASE}-c\s+|${IEX_HEAD})`;
// A shell wrapper followed (after its flags) by a quoted argument: the quotes are dropped so the argument is matched too.
const WRAPPED_QUOTE = new RegExp(`${WRAP_HEAD}(${BASH_DQ}|${SQ})`, 'gi');
const WRAPPED_QUOTE_PS = new RegExp(`${WRAP_HEAD}(${PS_DQ}|${SQ})`, 'gi');
const PS_WRAPPER = /(^|[\s;&|(\x60{])(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s/i;
// powershell -Command "..." at the end of the command: everything between the first and the last quote is the script.
const PS_GREEDY = /(^|[\s;&|(\x60{])((?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?(?:\s+(?:[-/][\w:-]+|\w+))*?\s+)"([\s\S]*)"\s*$/i;
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

// A quoted path to a program the guard knows ("C:\Program Files\Git\usr\bin\env.exe" hc run, & "C:\x\hc.exe" run claude):
// the quoted path is replaced by the program name, otherwise the quotes are blanked and the program is not seen.
const QUOTED_PROGRAM = /(["'])(?:[^"'\n;|&]*[\\/])?((?:hc|herdr|env|xargs|bash|sh|zsh|dash|cmd|powershell|pwsh|claude)(?:\.exe)?)\1/gi;
// PowerShell Start-Process <program> -ArgumentList "a b" / 'a','b' / a,b: the program and its arguments are also written out
// as one command (the original stays). Options of Start-Process before the program are skipped (switches such as
// -NoNewWindow, and options with a value such as -WindowStyle Hidden).
const SP_VALUE_OPT = /^-(?:windowstyle|workingdirectory|redirectstandard(?:output|error|input)|credential|verb|argumentlist|args)$/i;
const START_PROCESS = /(^|[\s;&|(\x60{"'])(?:Start-Process|saps)\b([^;|&\n]*)/gi;
function startProcess(text) {
  return text.replace(START_PROCESS, (m, pre, rest) => {
    // the program: -FilePath's value, else the first word that is not an option or an option's value
    let file = null;
    const toks = rest.match(/"[^"]*"|'[^']*'|[^\s"',]+/g) || [];
    for (let i = 0; i < toks.length && !file; i++) {
      const t = toks[i];
      if (/^-filepath$/i.test(t)) file = toks[i + 1] ? [null, toks[i + 1]] : null;
      else if (SP_VALUE_OPT.test(t)) i++;
      else if (!t.startsWith('-')) file = [null, t];
    }
    if (!file) return m;
    const al = /-(?:ArgumentList|Args)\s+(.*)$/i.exec(rest);
    const args = al ? al[1].replace(/["',]/g, ' ') : '';
    return `${pre}${file[1]} ${args};${m}`;
  });
}

// A quoted subcommand right after hc / herdr and their options (hc "run" claude, herdr "agent" "start"): quotes dropped, as
// they are blanked otherwise. Only the words that can start the subcommand are touched, so `hc send t5 "run"` is left alone.
const CLI_OPTS = String.raw`(?:\s+-{1,2}[\w-]+(?:=\S+)?(?:\s+[^\s"'-]\S*)?)*`;
const WORD = String.raw`(?:"[\w-]+"|'[\w-]+'|[\w-]+)`;
const QUOTED_HC_VERB = new RegExp(String.raw`((?:^|[\s;&|(\x60{])(?:\S*[\\/])?hc(?:\.exe)?${CLI_OPTS}\s+)(${WORD})`, 'gi');
const QUOTED_HERDR_VERB = new RegExp(String.raw`((?:^|[\s;&|(\x60{])(?:\S*[\\/])?herdr(?:\.exe)?${CLI_OPTS}\s+)(${WORD}(?:\s+${WORD})?)`, 'gi');
const unquoteVerb = (_m, head, words) => `${head}${words.replace(/["']/g, '')}`;

// opts.powershell: the command comes from the PowerShell tool.
function segments(command, opts = {}) {
  const raw = startProcess(String(command))
    .replace(QUOTED_HC_VERB, unquoteVerb)
    .replace(QUOTED_HERDR_VERB, unquoteVerb)
    .replace(QUOTED_SLOT_PATH, 'heavy-slot.cjs')
    .replace(QUOTED_PROGRAM, '$2');
  const out = cut(stripHeredocs(raw), false);
  if (opts.powershell || PS_WRAPPER.test(raw)) {
    const ps = raw.replace(PS_GREEDY, (_m, pre, head, body) => `${pre}${head}${body}`);
    for (const s of cut(ps, true)) if (!out.includes(s)) out.push(s);
  }
  return out;
}

// The segment with env assignments and the given wrappers peeled off, until nothing changes.
function peel(segment, wrappers, rounds) {
  let a = segment.replace(ENV_PREFIX, '');
  for (let i = 0; i < rounds; i++) {
    let b = a;
    for (const re of wrappers) b = b.replace(re, '');
    b = b.replace(ENV_PREFIX, '');
    if (b === a) break;
    a = b;
  }
  return a;
}

// The forms of one segment a pattern is tried against: with the shell wrappers peeled off (v0.7.0), and with the slot
// wrapper peeled off as well; each also without the npm run / npx runner.
function variants(segment) {
  const forms = [
    ...new Set([peel(segment, [WRAPPER_PREFIX], 4), peel(segment, [WRAPPER_PREFIX, SLOT_WRAPPER_PREFIX], 8), peel(segment, [WRAPPER_PREFIX, SLOT_WRAPPER_PREFIX, EXTRA_PREFIX, SUDO_PREFIX], 8)]),
  ];
  const out = [];
  for (const f of forms) {
    const a = f.replace(NPM_OPTS, 'npm').replace(/^npm\s+run-script\b/i, 'npm run');
    for (const v of [a, a.replace(RUNNER_PREFIX, '')]) {
      if (!out.includes(v)) out.push(v);
      const c = canonical(v);
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
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

// Targets of every `hc send` in a command: an array of strings, null for a send whose target could not be read.
function hcSendTargets(command, opts = {}) {
  const out = [];
  for (const seg of segments(command, opts)) {
    let found = false;
    for (const v of variants(seg)) {
      const m = HC_SEND_TARGET.exec(v);
      if (m && m.index === 0) {
        out.push(m[2]);
        found = true;
        break;
      }
    }
    if (!found && variants(seg).some((v) => HC_SEND.test(v))) out.push(null);
  }
  return out;
}

module.exports = {
  BUILTIN_SUBAGENT_DENY,
  HERDR_AGENT_START,
  HC_AGENT_START,
  AGENT_START: [HERDR_AGENT_START, HC_AGENT_START],
  DEFAULT_HEAVY,
  segments,
  stripQuotes,
  matches,
  compile,
  hcSendTargets,
};
