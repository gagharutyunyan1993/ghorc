'use strict';
// Tab policy for the lead: what may be opened (names, role env, model/effort/permission args, limits) and what is reported
// about the worker tabs that are open (blocked, finished but not closed, stalled, overtime, over the limit).
// Used by scripts/tabs-guard.cjs. Pure functions where possible; the only I/O is the list call (hc ls / herdr agent list),
// the report file reads, the state file and the optional notification.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { segments, matches, compile, stripHeredocs, stdinScripts, encodedScripts } = require('./cmd.cjs');
const backend = require('./backend.cjs');
const { tmpDir, atomicWrite } = require('./tmp.cjs');
const { safeId } = require('./hook-io.cjs');

// ---------------------------------------------------------------------------------------------------------------------
// Names
const AGENT_KINDS = ['implementer', 'reviewer', 'reviewer-critical', 'scout', 'integrator', 'release', 'consult', 'media', 'log-reader'];
const LONG_KINDS = ['full', 'runner', 'train'];
const MAX_NAME = 32; // herdr's agent-name rule: [a-z][a-z0-9_-]{0,31}; the policy is the stricter [a-z][a-z0-9-]{0,31}
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KINDS_BY_LENGTH = [...AGENT_KINDS, ...LONG_KINDS].sort((a, b) => b.length - a.length);
const PKG = /^[a-z0-9][a-z0-9-]*$/;

const POLICY_TEXT =
  `a tab name starts with a lowercase letter, then [a-z0-9-], at most ${MAX_NAME} characters in all: a worker is <pkg>-<kind> (kind: ${AGENT_KINDS.join(', ')}; long-lived: ${LONG_KINDS.join(', ')}), a lead starts with the lead prefix`;

// parseName(name, leadPrefix) -> { ok: true, role: 'lead'|'worker', kind, pkg, long } | { ok: false, why }
function parseName(name, leadPrefix = 'lead-') {
  const n = String(name == null ? '' : name);
  if (!n) return { ok: false, why: 'empty' };
  if (n.length > MAX_NAME) return { ok: false, why: `longer than ${MAX_NAME} characters` };
  if (!/^[a-z0-9-]+$/.test(n)) return { ok: false, why: 'only lowercase letters, digits and "-" are allowed' };
  if (!/^[a-z]/.test(n)) return { ok: false, why: 'must start with a letter' };
  const prefix = String(leadPrefix == null ? '' : leadPrefix).toLowerCase();
  if (prefix && n.startsWith(prefix)) {
    return n.length > prefix.length ? { ok: true, role: 'lead', kind: 'lead', pkg: n.slice(prefix.length), long: true } : { ok: false, why: `nothing after the lead prefix "${prefix}"` };
  }
  for (const kind of KINDS_BY_LENGTH) {
    if (n.endsWith(`-${kind}`)) {
      const pkg = n.slice(0, n.length - kind.length - 1);
      if (PKG.test(pkg)) return { ok: true, role: 'worker', kind, pkg, long: LONG_KINDS.includes(kind) };
    }
  }
  return { ok: false, why: `not <pkg>-<kind> with a kind from ${[...AGENT_KINDS, ...LONG_KINDS].join(', ')}` };
}

// Settings with safe fallbacks (the config is merged over defaults.json, but a wrong type must never break the hook).
function settings(cfg) {
  const t = (cfg && typeof cfg.tabs === 'object' && cfg.tabs) || {};
  const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const strs = (v, d) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : d);
  const lead = (cfg && cfg.capacity && typeof cfg.capacity.leadNamePrefix === 'string' && cfg.capacity.leadNamePrefix) || 'lead-';
  return {
    enabled: bool(t.enabled, true),
    maxWorkers: num(t.maxWorkers, 3, 1, 20),
    idleMin: num(t.idleMin, 10, 1, 1440),
    overtimeMin: num(t.overtimeMin, 45, 1, 1440),
    stopBlock: bool(t.stopBlock, true),
    notify: bool(t.notify, true),
    devCommands: Array.isArray(t.devCommands) ? t.devCommands.filter((x) => typeof x === 'string' && x) : [],
    leadPrefix: lead.toLowerCase(),
    workerPerm: strs(cfg && cfg.worker && cfg.worker.permissionArgs, []),
    leadPerm: strs(cfg && cfg.handoff && cfg.handoff.candidatePermissionArgs, []),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Report files
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanLine = (l) => l.replace(/^[\s>*_`#-]+|[\s*_`]+$/g, '');

function resultRegex(name) {
  const n = esc(name);
  return new RegExp(`^(?:DONE ${n}(?:\\s.*)?|BLOCKED ${n}(?:[:\\s].*)?|HANDOFF ${n}(?:\\s.*)?|VERDICT (?:ACCEPT_WITH_NOTES|ACCEPT|CHANGES_REQUIRED|BLOCKED)(?:\\s.*)?)$`);
}

const reportFile = (root, name) => path.join(root, '.claude', 'ghorc-out', `${name}.md`);

// The result line of a tab's report (its last non-empty line, when it has the result form): { line, mtimeMs } or null.
function resultLine(root, name) {
  try {
    const f = reportFile(root, name);
    const st = fs.statSync(f);
    const fd = fs.openSync(f, 'r');
    let text;
    try {
      const len = Math.min(st.size, 8192);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
    const last = lines[lines.length - 1];
    return last && resultRegex(name).test(last) ? { line: last, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Command parsing
const PROGRAMS = { hc: /^(?:.*[\\/])?hc(?:\.exe)?$/i, herdr: /^(?:.*[\\/])?herdr(?:\.exe)?$/i };
const CLAUDE = /^(?:.*[\\/])?claude(?:\.exe|\.cmd|\.ps1)?$/i;
const ENV_BIN = /^(?:.*[\\/])?env(?:\.exe)?$/i;
// The prefilter for a command that may carry hc or herdr. No \b in front: env -Shc run ... holds hc inside a word of env's option
// (peelWrappers reads it); a word that only ends in hc costs one more parse, nothing else.
const HC_HERDR_WORD = /(?:hc|herdr)(?:\.exe)?\b/i;
// The options of env that parseHc models in front of the program: -i, a lone -, --ignore-environment, -u NAME, --unset=NAME and
// --unset NAME (and `--`, skipped in parseHc). -> the words the option takes, 0 for any other option (-S, -C, -v, -iu ...: not
// modelled, the command is denied)
const envOptWords = (t) => (t === '-i' || t === '-' || t === '--ignore-environment' || /^--unset=/.test(t) ? 1 : t === '-u' || t === '--unset' ? 2 : 0);
// Words that may stand in front of the program of a segment (env assignments, shells and their flags, small wrappers).
const LEADING = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|&|call|start|cmd(?:\.exe)?|\/[ckr]|bash|sh|zsh|dash|-[A-Za-z]*c|sudo|env(?:\.exe)?|time|nohup|exec|command|powershell(?:\.exe)?|pwsh(?:\.exe)?|-command|-noprofile|-noninteractive|-nologo|"")$/i;
const HC_OTHER = new Set(['send', 'exec', 'keys', 'interrupt', 'ls', 'list', 'get', 'kill', 'rm', 'wait', 'read', 'ps', 'attach', 'logs']);
const HC_VALUE_OPTS = new Set(['--name', '-n', '--cwd', '--on', '--via', '--parent', '--session', '--env', '--title', '--cols', '--rows', '--timeout', '--machine']);
const HERDR_VALUE_OPTS = new Set(['--kind', '--pane', '--cwd', '--env', '--tab', '--workspace', '--label', '--session', '--title', '--name', '--focus-pane', '--direction', '--ratio', '--source', '--lines', '--timeout']);
// Other herdr commands the lead may only aim at its own workspace: creating, closing and starting (target in the first positional
// word or --pane / --tab). Operator actions (agent prompt, pane run / send-keys / send-text / read) are the owner's to ask for.
const HERDR_OTHER = {
  pane: new Set(['close', 'split', 'move']),
  tab: new Set(['close']),
  workspace: new Set(['create', 'close']),
  worktree: new Set(['create', 'open', 'remove']), // a worktree workspace is a new workspace
};
// Global flags that aim a command at another herdr session, machine or SSH host: never for the lead's own tabs.
const HERDR_FOREIGN = new Set(['--session', '--machine', '--remote']);
// $HERDR_WORKSPACE_ID in the forms of bash, PowerShell and cmd: the own workspace.
const WS_REF = /^(?:\$(?:env:)?HERDR_WORKSPACE_ID|%HERDR_WORKSPACE_ID%)$/i;
const wsOfPane = (pane) => (String(pane).includes(':') ? String(pane).split(':')[0].toLowerCase() : '');

const unknownValue = (v) => v === undefined || v === '' || /["'$%<>{}`]/.test(v);
const optStr = (t) => t.length > 1 && t[0] === '-' && t !== '--';

function scan(tokens, from, to, valueOpts) {
  const opts = [];
  const pos = [];
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (optStr(t)) {
      const eq = t.indexOf('=');
      if (t.startsWith('--') && eq > 0) opts.push({ name: t.slice(0, eq).toLowerCase(), value: t.slice(eq + 1), i, inline: true });
      else if (valueOpts.has(t.toLowerCase()) && i + 1 < to) {
        opts.push({ name: t.toLowerCase(), value: tokens[i + 1], i, inline: false });
        i++;
      } else opts.push({ name: t.toLowerCase(), value: undefined, i, inline: false });
    } else pos.push({ t, i });
  }
  return { opts, pos };
}
const isHelp = (o) => o.name === '--help' || o.name === '-h';
const optVals = (opts, ...names) => opts.filter((o) => names.includes(o.name));

// A PowerShell assignment in front of the program ($t = herdr tab create ...) is skipped like the other leading words.
function cliTokens(segment) {
  const w = Array.isArray(segment) ? segment : String(segment).trim().split(/\s+/);
  for (let i = 0; i < w.length; i++) {
    if (/^\$[\w:]+$/.test(w[i]) && w[i + 1] === '=') {
      i++;
      continue;
    }
    for (const prog of ['hc', 'herdr']) if (PROGRAMS[prog].test(w[i])) return { prog, tokens: w.slice(i) };
    if (!LEADING.test(w[i])) return null;
  }
  return null;
}

// -> { type: 'tab-create' | 'agent-start' | 'hc-run', tokens, ... } or null
function parseSegment(segment) {
  const c = cliTokens(segment);
  if (!c) return null;
  const { tokens } = c;
  const low = tokens.map((t) => t.toLowerCase());
  if (c.prog === 'herdr') {
    // herdr takes --session in front of the noun and after the verb (`herdr tab list --session x` goes to session x): look at every
    // herdr token, up to the `--` that starts the agent's own argv
    const r = parseHerdr(tokens, low);
    if (r) {
      const end = r.type === 'agent-start' && r.dd >= 0 ? r.dd : low.length;
      r.foreign = low.slice(1, end).find((t) => HERDR_FOREIGN.has(t.split('=')[0])) || null;
    }
    return r;
  }
  return parseHc(tokens, low);
}

function parseHerdr(tokens, low) {
  {
    for (let i = 1; i + 1 < tokens.length; i++) {
      if (low[i] === 'tab' && low[i + 1] === 'create') {
        const { opts } = scan(tokens, i + 2, tokens.length, HERDR_VALUE_OPTS);
        if (opts.some(isHelp)) return null; // `--help` reads, it starts nothing
        return { type: 'tab-create', tokens, at: i + 2, opts };
      }
      if (low[i] === 'agent' && low[i + 1] === 'start') {
        const dd = tokens.indexOf('--', i + 2);
        const end = dd < 0 ? tokens.length : dd;
        const { opts, pos } = scan(tokens, i + 2, end, HERDR_VALUE_OPTS);
        if (opts.some(isHelp)) return null;
        return { type: 'agent-start', tokens, at: i + 2, opts, name: pos.length ? pos[0] : null, dd, args: dd < 0 ? [] : tokens.slice(dd + 1) };
      }
    }
    for (let i = 1; i + 1 < tokens.length; i++) {
      const set = HERDR_OTHER[low[i]];
      if (set && set.has(low[i + 1])) {
        const { opts, pos } = scan(tokens, i + 2, tokens.length, HERDR_VALUE_OPTS);
        if (opts.some(isHelp)) return null;
        return { type: 'herdr-other', noun: low[i], verb: low[i + 1], tokens, at: i + 2, opts, pos };
      }
    }
    return null;
  }
}

function parseHc(tokens, low) {
  let run = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (low[i] === 'run') {
      run = i;
      break;
    }
    if (HC_OTHER.has(low[i])) return null;
  }
  if (run < 0) return null;
  const opts = [];
  let i = run + 1;
  let envIdx = -1;
  let envBad = null;
  const assigns = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') continue;
    if (optStr(t) && envIdx < 0) {
      const eq = t.indexOf('=');
      if (t.startsWith('--') && eq > 0) opts.push({ name: t.slice(0, eq).toLowerCase(), value: t.slice(eq + 1), i, inline: true });
      else if (HC_VALUE_OPTS.has(t.toLowerCase()) && i + 1 < tokens.length) {
        opts.push({ name: t.toLowerCase(), value: tokens[i + 1], i, inline: false });
        i++;
      } else opts.push({ name: t.toLowerCase(), value: undefined, i, inline: false });
      continue;
    }
    if (ENV_BIN.test(t)) {
      // a second env behind the first is read like the first (env -i env GHORC_ROLE=worker claude)
      if (envIdx < 0) envIdx = i;
      continue;
    }
    if (envIdx >= 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      assigns.push({ t, i });
      continue;
    }
    // an option of env in front of the program: skipped when modelled, else the program cannot be told (checkParsed denies)
    if (envIdx >= 0 && (t === '-' || optStr(t))) {
      const n = envOptWords(t);
      if (n) {
        // -i empties the environment, so a GHORC_ROLE set before it is gone; -u NAME / --unset=NAME drops that one name
        const unset = t === '-u' || t === '--unset' ? tokens[i + 1] : t.startsWith('--unset=') ? t.slice(8) : undefined;
        for (let k = assigns.length - 1; k >= 0; k--) {
          if (unset === undefined || assigns[k].t.slice(0, assigns[k].t.indexOf('=')).toLowerCase() === String(unset).toLowerCase()) assigns.splice(k, 1);
        }
        i += n - 1;
        continue;
      }
      envBad = t;
    }
    break;
  }
  if (opts.some(isHelp)) return null;
  const prog = i < tokens.length ? tokens[i] : null;
  return { type: 'hc-run', tokens, run, opts, envIdx, envBad, assigns, progIdx: i, claude: Boolean(prog && CLAUDE.test(prog)), args: tokens.slice(i + 1) };
}

// cmd.cjs blanks quoted text and cuts at braces, so the values this guard judges are made readable first: ${HERDR_WORKSPACE_ID}
// becomes $HERDR_WORKSPACE_ID, and a quoted word without spaces after --workspace, --label, --pane, --tab, --name or --kind is unquoted.
function readable(command) {
  return String(command)
    .replace(/(--workspace(?:=|\s+))'([^']*[$%][^']*)'/g, '$1__SQ__$2')
    .replace(/\$\{(env:)?HERDR_WORKSPACE_ID\}/gi, '$$$1HERDR_WORKSPACE_ID')
    .replace(/\$\(pwd\)|\$\{PWD\}/g, '$$PWD') // the session's directory; parentheses and braces would cut the segment
    .replace(/(--(?:workspace|label|pane|tab|name|kind)(?:=|\s+))(["'])([\w:.$%/-]*)\2/g, '$1$3');
}

// bash: a command substitution inside double quotes ("$(herdr tab create ... --cwd "$PWD" | jq .id)", "`...`") is taken out of
// the quotes ("a$(X)b" -> "a"$(X)"b"), so the quotes inside it are its own and the command is seen. Unchanged when a quote or
// a parenthesis does not close; nesting deeper than MAX_NEST throws (the caller denies).
const MAX_NEST = 32;
const tooDeep = (d) => {
  if (d > MAX_NEST) throw new Error('nesting too deep');
};
function closeSub(s, k, tick, d = 0) {
  tooDeep(d);
  let depth = 1;
  for (let i = k; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (tick) {
      if (c === '`') return i;
    } else if (c === "'" || c === '"') {
      const e = c === "'" ? s.indexOf("'", i + 1) : closeDq(s, i + 1, d + 1);
      if (e < 0) return -1;
      i = e;
    } else if (c === '(') tooDeep(++depth);
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}
function closeDq(s, k, d) {
  tooDeep(d);
  for (let i = k; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
    else if (s[i] === '$' && s[i + 1] === '(') {
      const e = closeSub(s, i + 2, false, d + 1);
      if (e < 0) return -1;
      i = e;
    } else if (s[i] === '`') {
      const e = closeSub(s, i + 1, true, d + 1);
      if (e < 0) return -1;
      i = e;
    }
  }
  return -1;
}
function splitSubs(s, d = 0) {
  tooDeep(d);
  if (!/"[^"]*(?:\$\(|`)/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      out += s.slice(i, i + 2);
      i++;
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) return s;
      out += s.slice(i, e + 1);
      i = e;
    } else if (c === '"') {
      out += '"';
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\') {
          out += s.slice(j, j + 2);
          j++;
        } else if ((s[j] === '$' && s[j + 1] === '(') || s[j] === '`') {
          const tick = s[j] === '`';
          const e = closeSub(s, j + (tick ? 1 : 2), tick, d + 1);
          if (e < 0) return s;
          out += `"${tick ? s.slice(j, e + 1) : `$(${splitSubs(s.slice(j + 2, e), d + 1)})`}"`;
          j = e;
        } else out += s[j];
      }
      if (j >= s.length) return s;
      out += '"';
      i = j;
    } else out += c;
  }
  return out;
}

// Every tab command of a shell command line: [{ type, ... }]. Segments come from cmd.cjs (quotes blanked, wrappers inlined).
function parseCommand(command, powershell) {
  const out = [];
  const seen = new Set();
  const text = readable(command);
  for (const seg of segments(powershell ? text : splitSubs(text), { powershell })) {
    if (!HC_HERDR_WORD.test(seg)) continue;
    // a wrapper cmd.cjs leaves in place (timeout 5, nice -n 5, env -u X ...) is peeled as in the send checks
    const p = parseSegment(seg) || parseSegment(peelWrappers(String(seg).trim().split(/\s+/)));
    if (!p) continue;
    const key = p.tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// The words of a command line with their quotes decoded, for the send checks (cmd.cjs blanks quoted text, but the payload of
// `herdr pane run` is what is judged there). bash: '...' literal, "..." with \" \\ \$ \` escapes, $'...' with \n \t, a
// backslash outside quotes escapes. PowerShell: '...' with '' for ', "..." with `x escapes (`n is a newline) and "" for ", a
// backtick outside quotes escapes too. Cut into segments at unquoted ; | & ( ) and newlines (PowerShell: && only, a lone & is
// the call operator). A PowerShell here-string (@'/@" at the end of a line up to a line that starts with '@/"@) is one word and
// <# ... #> a comment. -> [[word, ...], ...]; .unclosed when a quote never closes
const PS_ESC = { 0: '\0', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const C_ESC = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
function rawSegments(command, powershell) {
  const s = String(command);
  const segs = [];
  let words = [];
  let cur = null;
  const endWord = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segs.push(words);
    words = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '(' || c === ')' || (c === '&' && (!powershell || s[i + 1] === '&'))) {
      endWord();
      if (words.length && c === '|' && s[i + 1] !== '|') words.pipe = true; // its output feeds the next segment
      endSeg();
      if ((c === '&' || c === '|') && s[i + 1] === c) i++;
      continue;
    }
    if (powershell && c === '<' && s[i + 1] === '#') {
      // a PowerShell block comment <# ... #> ends at its #>, not at the end of the line
      const e = s.indexOf('#>', i + 2);
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    if (c === '#' && cur === null) {
      // a comment runs to the end of the line (its quotes are not quotes)
      while (i + 1 < s.length && s.charCodeAt(i + 1) !== 10 && s.charCodeAt(i + 1) !== 13) i++;
      continue;
    }
    if (cur === null) cur = '';
    if (powershell && c === '@' && (s[i + 1] === "'" || s[i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(i + 2))) {
      const q = s[i + 1];
      const nl = s.indexOf('\n', i + 2);
      const e = s.indexOf(`\n${q}@`, nl);
      if (e < 0) {
        cur += s.slice(nl + 1);
        segs.unclosed = true;
        i = s.length;
      } else {
        cur += s.slice(nl + 1, e).replace(/\r$/, '');
        i = e + 2;
      }
      continue;
    }
    if (!powershell && c === '$' && s[i + 1] === "'") {
      for (i += 2; i < s.length && s[i] !== "'"; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const e = s[++i];
          cur += e in C_ESC ? C_ESC[e] : `\\${e}`;
        } else cur += s[i];
      }
      if (i >= s.length) segs.unclosed = true;
      continue;
    }
    if (c === "'") {
      for (i++; i < s.length; i++) {
        if (s[i] === "'") {
          if (powershell && s[i + 1] === "'") {
            cur += "'";
            i++;
            continue;
          }
          break;
        }
        cur += s[i];
      }
      if (i >= s.length) segs.unclosed = true;
      continue;
    }
    if (c === '"') {
      for (i++; i < s.length; i++) {
        const d = s[i];
        if (d === '"') {
          if (powershell && s[i + 1] === '"') {
            cur += '"';
            i++;
            continue;
          }
          break;
        }
        if (powershell && d === '`' && i + 1 < s.length) {
          const e = s[++i];
          cur += e in PS_ESC ? PS_ESC[e] : e;
        } else if (!powershell && d === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) {
          const e = s[++i];
          if (e !== '\n') cur += e;
        } else cur += d;
      }
      if (i >= s.length) segs.unclosed = true;
      continue;
    }
    if ((powershell ? c === '`' : c === '\\') && i + 1 < s.length) {
      const e = s[++i];
      if (e !== '\n') cur += powershell && e in PS_ESC ? PS_ESC[e] : e;
      continue;
    }
    cur += c;
  }
  endSeg();
  return segs;
}

// Wrappers in front of a decoded command that cliTokens does not know: timeout, nice, stdbuf, setsid, nohup, time, and env, command
// and exec with their options (env -u NAME, exec -a NAME). -> the words from the program on. A path in front of one is dropped.
const WRAP_VALUE = { timeout: ['-s', '--signal', '-k', '--kill-after'], nice: ['-n', '--adjustment'], stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'], ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'], chrt: [], setsid: [], nohup: [], time: [], env: [], command: [], exec: ['-a'] };
// Programs that run another program, for the "claude behind a program" rule (RUNNERS): the wrappers above and the ones cmd.cjs
// peels. Package runners (npx, pnpx, bunx) take arbitrary arguments, so only the program they run counts (PKG_RUNNERS).
const RUNNER_VALUE = {
  ...WRAP_VALUE,
  gtimeout: WRAP_VALUE.timeout,
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-r', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type'],
  doas: ['-u', '-C'],
  xargs: ['-I', '-n', '-P', '-s', '-E', '-d', '-a', '-L'],
  taskset: ['-c', '--cpu-list'],
  flock: ['-w', '-E', '--timeout', '--wait'],
  watch: ['-n', '--interval'],
  winpty: [],
  start: [],
  call: [],
  builtin: [],
  'cross-env': [],
  npx: ['-p', '--package', '-c', '--call'],
  pnpx: ['-p', '--package', '-c', '--call'],
  bunx: [],
};
const PKG_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const RUNNERS = new Set(Object.keys(RUNNER_VALUE).filter((n) => !PKG_RUNNERS.has(n)));
// The words one option of env takes at ws[i]. u, C, S and a take a value: the rest of the word (-uNAME, -iuNAME, --unset=NAME), else
// the next word (-iu NAME, --unset NAME). The value of S is a string env splits into words: they stay in the command (ws is
// spliced), so `env -S "herdr pane run ..."` is still seen.
function envOptLen(ws, i) {
  const t = ws[i];
  const long = /^--(unset|chdir|split-string|argv0)(?:=([\s\S]*))?$/.exec(t);
  const k = long || !/^-[0-9A-Za-z]/.test(t) ? -1 : t.search(/[uCSa]/); // -S'hc run' is the word -Shc run: only its start is a cluster
  if (!long && k < 0) return 1;
  const own = long ? long[2] : k < t.length - 1 ? t.slice(k + 1) : undefined;
  const n = own === undefined ? 2 : 1;
  const val = own === undefined ? ws[i + 1] : own;
  if ((long ? long[1] === 'split-string' : t[k] === 'S') && val !== undefined) ws.splice(i + n, 0, ...String(val).split(/\s+/).filter(Boolean));
  return n;
}
function peelWrappers(words, table = WRAP_VALUE) {
  const ws = words.slice();
  let i = 0;
  for (let guard = 0; guard < 16 && i < ws.length; guard++) {
    const w = String(ws[i]).toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i])) {
      i++;
      continue;
    }
    if (!Object.hasOwn(table, w)) break;
    i++;
    while (i < ws.length && /^-/.test(ws[i]) && ws[i] !== '--') i += w === 'env' ? envOptLen(ws, i) : table[w].includes(ws[i]) ? 2 : 1;
    if (ws[i] === '--') i++;
    if ((w === 'timeout' || w === 'gtimeout' || w === 'chrt') && i < ws.length && /^\d/.test(ws[i])) i++; // the duration, the priority
  }
  return ws.slice(i);
}

// The lead's sends into a pane: `herdr pane run|send-text|send-keys <pane> <payload...>` -> [{ verb, target, payload }],
// payload decoded (rawSegments). The target is the first positional word, or --pane.
const SEND_VERBS = new Set(['run', 'send-text', 'send-keys']);
function sendCommands(command, powershell) {
  const out = [];
  for (const words of rawSegments(command, powershell)) {
    const c = cliTokens(words) || cliTokens(peelWrappers(words));
    if (!c || c.prog !== 'herdr') continue;
    const t = c.tokens;
    const low = t.map((x) => x.toLowerCase());
    for (let i = 1; i + 1 < t.length; i++) {
      if (low[i] !== 'pane' || !SEND_VERBS.has(low[i + 1])) continue;
      const { opts, pos } = scan(t, i + 2, t.length, HERDR_VALUE_OPTS);
      if (!opts.some(isHelp)) {
        const paneOpt = optVals(opts, '--pane')[0];
        out.push({ verb: low[i + 1], target: paneOpt ? paneOpt.value : pos.length ? pos[0].t : null, payload: (paneOpt ? pos : pos.slice(1)).map((x) => x.t) });
      }
      break;
    }
  }
  return out;
}

// A herdr tab create is allowed only in one shape: a one-line command of its own, `herdr tab create <plain flags>`, with an
// optional MSYS_NO_PATHCONV=1 in front (bash), an optional capture ($t = ... in PowerShell; VAR=$(...) or VAR="$(...)" in bash,
// with an optional `| jq ...` / `| ConvertFrom-Json` inside) and an optional trailing # comment. Fail-closed: a command whose
// text has herdr as a word and tab next to create must be that shape, unless the words sit only in the arguments of a text
// program (git commit/tag/log, gh, echo, grep and the like: a commit message, a search).
const TAB_FORM = 'herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus --label <name> --cwd <dir> --env GHORC_ROLE=worker (PowerShell: --workspace $env:HERDR_WORKSPACE_ID)';
const TAB_SHAPE = `herdr tab create is allowed only as a one-line command of its own: ${TAB_FORM}; optional: MSYS_NO_PATHCONV=1 in front (bash), a capture ($t = ... in PowerShell, VAR=$(...) or VAR="$(...)" in bash, with | jq ... or | ConvertFrom-Json inside) and a trailing # comment. No ;, &&, |, newline, redirect, block, loop, wrapper (sh -c, Start-Process, xargs, eval, heredoc) or cd around it; values are plain words or quoted text, and the only variables are $PWD after --cwd and $HERDR_WORKSPACE_ID after --workspace`;
const MENTION = /\bherdr(?:\.exe)?\b[\s\S]*?\btab\s+create\b/i;
const HERDR_WORD = /^(?:.*[`({\\/])?herdr(?:\.exe)?$/i;
// herdr as a word: not part of a longer name (herdr-fixes.test.cjs) or a directory (.../herdr/x); a path to it counts
const HERDR_RAW = /(?<![\w.-])herdr(?:\.exe)?(?![\w.\\/-])/i;
const TAB_NEXT_CREATE = /\btab['"\s,@()]*create\b/i;
const failClosed = (t) => HERDR_RAW.test(t) && TAB_NEXT_CREATE.test(t);
const TEXT_PROGS = new Set(['gh', 'glab', 'echo', 'printf', 'write-output', 'write-host', 'grep', 'egrep', 'fgrep', 'rg', 'select-string', 'sls', 'findstr']);
const progName = (w) => String(w || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
// git options that run a program or read one from config (a pager, a diff driver, a remote helper) or write a file (--output)
const GIT_RUNS = /^(?:-c|-O|--open-files-in-pager|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--config-env|--exec-path|--output)/;
// A segment of a text program: its arguments are text, not commands. Only a bare program: no VAR=value or wrapper in front;
// git only as `git commit|tag|log|grep|show|notes` with no global option before the subcommand and no option that runs a
// program; gh/glab not for alias, extension or --shell. A redirect or a pipe into a shell is judged in usesTabCreate.
function isTextSegment(words) {
  let w = words;
  while (w.length && /^(?:time|nohup)$/i.test(w[0])) w = w.slice(1);
  if (!w.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) return false;
  const prog = progName(w[0]);
  if (prog === 'gh' || prog === 'glab') return !/^(?:alias|extension|ext)$/.test(w[1] || '') && !w.some((x) => /^--shell\b/.test(x));
  if (prog !== 'git') return TEXT_PROGS.has(prog);
  return /^(?:commit|tag|log|grep|show|notes)$/.test(w[1] || '') && !w.some((x) => GIT_RUNS.test(x));
}
// Programs that run their text: shells, eval, xargs, PowerShell's Invoke-Expression and Start-Process, an interpreter with -e/-c.
const RUNS_TEXT = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'busybox', 'wsl', 'cmd', 'pwsh', 'powershell', 'eval', 'exec', 'source', '.', 'xargs', 'parallel', 'iex', 'invoke-expression', 'invoke-command', 'icm', 'start-process', 'saps', 'start']);
const INTERPRETERS = /^(?:node|deno|bun|python[\d.]*|py|perl|ruby|php|osascript)$/;
function runsText(words) {
  let w = words;
  while (w.length && (/^(?:time|nohup|&)$/i.test(w[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(1);
  for (const p of [progName(w[0]), progName(peelWrappers(w)[0])]) {
    if (RUNS_TEXT.has(p)) return true;
    if (INTERPRETERS.test(p) && w.some((x) => /^(?:-[ecrpE]|--eval|--print|eval|-command)$/i.test(x))) return true;
  }
  return false;
}
// What a text program may pipe into without running the text or writing a file (no less: -o/--log-file write one; sort and
// uniq only without -o/--output and with at most one positional, uniq's second one is its output file).
const PIPE_SINKS = new Set(['head', 'tail', 'more', 'wc', 'sort', 'uniq', 'cat', 'cut', 'tr', 'column', 'nl', 'fold', 'jq', 'select-object', 'select', 'out-string', 'out-host', 'out-null', 'measure-object', 'format-table', 'format-list', 'ft', 'fl']);
function isSink(words) {
  const prog = progName(words[0]);
  if (!PIPE_SINKS.has(prog)) return false;
  if (prog !== 'sort' && prog !== 'uniq') return true;
  const args = words.slice(1);
  return !args.some((x) => /^(?:-[A-Za-z]*o|--output)/.test(x)) && args.filter((x) => x === '-' || !/^-/.test(x)).length <= 1;
}
// An unquoted output redirect to anything but the null device or another stream (> run.sh, >> x, 2> x, &> x); the target
// must be exactly that (> nul.ps1 and > /dev/null.sh write files); $null and nul are the null device only in PowerShell, and
// bash paths are case-sensitive.
const NULL_TARGET = { sh: /^>?\s*(?:&\d+|\/dev\/null)(?=\s|$|[;|&)])/, ps: /^>?\s*(?:&\d+|\/dev\/null|\$null|nul)(?=\s|$|[;|&)])/i };
function writesFile(t, ps) {
  let s = t;
  for (let guard = 0; guard < 10000 && s; guard++) {
    const sc = scanLine(s, ps);
    if (!sc) return false;
    for (const { i, c } of sc.specials) if (c === '>' && s[i + 1] !== '>' && !NULL_TARGET[ps ? 'ps' : 'sh'].test(s.slice(i + 1))) return true;
    if (sc.comment < 0) return false;
    const nl = s.indexOf('\n', sc.comment);
    if (nl < 0) return false;
    s = s.slice(nl + 1);
  }
  return true;
}
// PowerShell: the bodies of $( ) subexpressions, also inside "..." and @"..."@ (they run there too), nested ones included.
function psCloseParen(s, k, d) {
  tooDeep(d);
  let depth = 1;
  for (let i = k; i < s.length; i++) {
    const c = s[i];
    if (c === '`') i++;
    else if (c === "'") {
      for (i++; i < s.length && s[i] !== "'"; i++);
      if (i >= s.length) return -1;
    } else if (c === '"') {
      for (i++; i < s.length; i++) {
        if (s[i] === '`' || (s[i] === '"' && s[i + 1] === '"')) i++;
        else if (s[i] === '"') break;
        else if (s[i] === '$' && s[i + 1] === '(') {
          const e = psCloseParen(s, i + 2, d + 1);
          if (e < 0) return -1;
          i = e;
        }
      }
      if (i >= s.length) return -1;
    } else if (c === '(') tooDeep(++depth);
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}
function psSubs(s, d = 0) {
  tooDeep(d);
  const out = [];
  // -> the index after the subexpression at i, or -1 when it does not close
  const sub = (i) => {
    const e = psCloseParen(s, i + 2, d + 1);
    if (e < 0) return -1;
    const body = s.slice(i + 2, e);
    out.push(body, ...psSubs(body, d + 1));
    return e;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const here = s[i - 1] === '@' && /^[ \t]*\r?\n/.test(s.slice(i + 1));
    if (c === '`') i++;
    else if (c === "'") {
      const e = here ? s.indexOf("\n'@", i) : s.indexOf("'", i + 1);
      if (e < 0) break;
      i = here ? e + 2 : e;
    } else if (c === '"') {
      const end = here ? s.indexOf('\n"@', i) : -1;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (here ? j === end : s[j] === '"' && s[j + 1] !== '"') break;
        if (s[j] === '`' || (!here && s[j] === '"')) j++;
        else if (s[j] === '$' && s[j + 1] === '(') {
          const e = sub(j);
          if (e < 0) return out;
          j = e;
        }
      }
      i = here ? j + 2 : j;
    } else if (c === '$' && s[i + 1] === '(') {
      const e = sub(i);
      if (e < 0) return out;
      i = e;
    }
  }
  return out;
}
// The texts the shell runs: bash with heredoc bodies dropped (they are data unless fed to a shell: those are added) and with a
// substitution inside double quotes taken out of them; PowerShell with its subexpressions; encoded PowerShell.
function commandTexts(command, ps) {
  const raw = String(command);
  const texts = (ps ? [raw, ...psSubs(raw)] : [splitSubs(stripHeredocs(raw)), ...stdinScripts(raw)]).map((t) => ({ t, ps }));
  for (const t of encodedScripts(raw)) texts.push({ t, ps: true });
  return texts;
}
// Does the command run a herdr tab create? herdr as a command word with tab create after it, or the fail-closed words outside
// the arguments of a text program. A quote that does not close next to a mention counts. Backstop when the fail-closed words
// are in the text at all: a program that runs text (sh, eval, xargs, iex, node -e), a text program piped into anything but a
// text program or a plain sink (head, jq, Select-Object), or an output redirect to a file count as running it.
function usesTabCreate(command, ps) {
  const fc = failClosed(String(command));
  const residual = [];
  for (const { t, ps: p } of commandTexts(command, ps)) {
    const segs = rawSegments(t, p);
    if (segs.unclosed && MENTION.test(t)) return true;
    if (fc && writesFile(t, p)) return true;
    for (let k = 0; k < segs.length; k++) {
      const words = segs[k];
      for (let j = 0; j < words.length; j++) if (HERDR_WORD.test(words[j]) && /\btab\s+create\b/i.test(words.slice(j + 1).join(' '))) return true;
      const text = isTextSegment(words);
      // also without a short option glued to its value (-O'herdr ...' is the word -Oherdr ...)
      if (!text) residual.push(words.join(' '), words.map((x) => x.replace(/^-[A-Za-z]/, '')).join(' '));
      if (!fc) continue;
      if (runsText(words)) return true;
      const next = segs[k + 1];
      if (text && words.pipe && next && !isTextSegment(next) && !isSink(next)) return true;
    }
  }
  return fc && failClosed(residual.join('\n'));
}
// Unquoted characters that make a command more than one plain command: -> { specials: [{ i, c }], comment } or null (a quote
// does not close). bash: \ escapes, '...' literal, "..." with \ escapes; PowerShell: ` escapes, '...' with '', "..." with ` and "".
// $( and backticks count also inside double quotes.
function scanLine(s, ps) {
  const specials = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === (ps ? '`' : '\\')) i++;
    else if (c === "'") {
      for (i++; i < s.length; i++) {
        if (ps && s[i] === "'" && s[i + 1] === "'") i++;
        else if (s[i] === "'") break;
      }
      if (i >= s.length) return null;
    } else if (c === '"') {
      for (i++; i < s.length; i++) {
        if (s[i] === (ps ? '`' : '\\')) i++;
        else if (ps && s[i] === '"' && s[i + 1] === '"') i++;
        else if (s[i] === '"') break;
        else if ((s[i] === '$' && s[i + 1] === '(') || (!ps && s[i] === '`')) specials.push({ i, c: '$(' });
      }
      if (i >= s.length) return null;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return { specials, comment: i };
    else if (c === '$' && s[i + 1] === '(') specials.push({ i, c: '$(' });
    else if (';&|<>(){}`'.includes(c) || (ps && c === ',')) specials.push({ i, c });
  }
  return { specials, comment: -1 };
}
// Every word of the canonical line with a $ outside single quotes (or a PowerShell @ splat) must be $PWD after --cwd or
// $HERDR_WORKSPACE_ID after --workspace.
const RAW_TOKEN = /(?:[^\s"']+|"(?:[^"\\`]|[\\`][\s\S])*"|'[^']*')+/g;
function plainVariables(body, ps) {
  const toks = body.match(RAW_TOKEN) || [];
  const pwd = ps ? /^"?\$PWD(?:[\\/][^"$`]*)?"?$/i : /^"?\$PWD(?:[\\/][^"$`]*)?"?$/;
  const ws = ps ? /^"?\$(?:env:)?HERDR_WORKSPACE_ID"?$/i : /^"?\$(?:env:)?HERDR_WORKSPACE_ID"?$/;
  const unquoted = (t) => {
    let out = '';
    let dq = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '"') dq = !dq;
      if (!dq && t[i] === "'") {
        const e = t.indexOf("'", i + 1);
        i = e < 0 ? t.length : e;
      } else out += t[i];
    }
    return out;
  };
  return toks.every((t, k) => {
    if (!unquoted(t).includes('$') && !(ps && t.startsWith('@'))) return true;
    const m = /^(--cwd|--workspace)=(.*)$/.exec(t);
    const [opt, val] = m ? [m[1], m[2]] : [toks[k - 1], t];
    return (opt === '--cwd' && pwd.test(val)) || (opt === '--workspace' && ws.test(val));
  });
}
const PIPE_TAIL = { sh: /^jq(?:\s+(?:'[^']*'|"[^"$`\\]*"|[\w.[\]-]+))*$/, ps: /^ConvertFrom-Json$/i };
// -> { words, msys } of the canonical form, or null
function canonicalTabCreate(command, ps) {
  let s = String(command).trim();
  if (/[\r\n]/.test(s)) return null;
  s = s.replace(/\$\{((?:env:)?\w+)\}/gi, (_m, v) => `$${v}`).replace(/\$\(pwd\)/g, '$PWD');
  let sc = scanLine(s, ps);
  if (!sc) return null;
  if (sc.comment >= 0) s = s.slice(0, sc.comment).trimEnd();
  let body = s;
  let capture = false;
  const m = ps ? /^\$[A-Za-z_]\w*\s*=\s*([\s\S]+)$/.exec(s) : /^[A-Za-z_]\w*=(?:\$\(([\s\S]*)\)|"\$\(([\s\S]*)\)")$/.exec(s);
  if (m) {
    body = (m[1] !== undefined ? m[1] : m[2]).trim();
    capture = true;
  }
  sc = scanLine(body, ps);
  if (!sc || sc.comment >= 0) return null;
  if (capture && sc.specials.length === 1 && sc.specials[0].c === '|') {
    const at = sc.specials[0].i;
    if (!PIPE_TAIL[ps ? 'ps' : 'sh'].test(body.slice(at + 1).trim())) return null;
    body = body.slice(0, at).trim();
    sc = scanLine(body, ps);
  }
  if (!sc || sc.specials.length || !plainVariables(body, ps)) return null;
  const segs = rawSegments(body, ps);
  if (segs.unclosed || segs.length !== 1) return null;
  let w = segs[0];
  let msys = false;
  if (!ps && w[0] === 'MSYS_NO_PATHCONV=1') {
    msys = true;
    w = w.slice(1);
  }
  if (w.length < 3 || !PROGRAMS.herdr.test(w[0]) || w[1] !== 'tab' || w[2] !== 'create') return null;
  return { words: w, msys };
}

// The tab-create lines of a command: the shape deny, or the --cwd values of the canonical form judged by cwdProblem (a tab
// create without --cwd is reported unless the cmd.cjs check already did).
const CWD_ASK = 'pass a plain absolute or relative path inside the project, or $PWD (a worktree under .claude/worktrees counts)';
function tabCreateLines(command, ctx, missingShown) {
  if (!usesTabCreate(command, ctx.powershell)) return [];
  const c = canonicalTabCreate(command, ctx.powershell);
  if (!c) return [TAB_SHAPE];
  const t = c.words;
  const dd = t.indexOf('--');
  const end = dd < 0 ? t.length : dd;
  if (t.slice(3, end).some((x) => x === '--help' || x === '-h') || !ctx.root) return []; // --help creates nothing
  const vals = [];
  for (let i = 3; i < end; i++) {
    if (t[i] === '--cwd') vals.push(i + 1 < end ? t[++i] : null);
    else if (t[i].startsWith('--cwd=')) vals.push(t[i].slice(6));
  }
  const out = [];
  const add = (x) => {
    if (x && !out.includes(x)) out.push(x);
  };
  if (!vals.length && !missingShown) add(`--cwd is missing: without it the tab starts in the herdr server's directory, outside the project; ${CWD_ASK}`);
  for (const v of vals) add(v === null ? `--cwd has no value: ${CWD_ASK}` : cwdProblem(v, ctx, c.msys));
  return out;
}
// The session's directory: bash $PWD, ${PWD} and $(pwd) (case matters there: $pwd is another, unset variable); PowerShell
// reads $PWD in any case. PowerShell's $env:PWD is not it: that is the environment the client was started with.
const PWD_REF = /^(?:\$PWD|\$\{PWD\}|\$\(pwd\))(?=$|[\\/])/;
const PWD_REF_PS = /^(?:\$PWD|\$\{PWD\}|\$\(pwd\))(?=$|[\\/])/i;
// -> a deny line for a --cwd value, or '' when it is inside the project. msys: bash with MSYS_NO_PATHCONV=1 (no /d/x rewrite).
function cwdProblem(val, ctx, msys = false) {
  const ask = CWD_ASK;
  if (val === null || val === '') return `--cwd ${val === null ? '(unreadable)' : '""'} cannot be read by the guard: ${ask}`;
  let rel = val;
  let base = /^(?:[A-Za-z]:)?[\\/]/.test(val) ? '' : ctx.cwd || ctx.root;
  const m = (ctx.powershell ? PWD_REF_PS : PWD_REF).exec(val);
  if (m) {
    rel = val.slice(m[0].length).replace(/^[\\/]+/, '') || '.';
    base = ctx.cwd || ctx.root;
    if (rel.split(/[\\/]/).includes('..')) return `--cwd ${val} leaves the session's directory with "..": ${ask}`;
  }
  if (/^~/.test(rel) || /[$%<>{}`()*?|;&"']/.test(rel)) return `--cwd ${val} is a variable, an expansion or ~, so the guard cannot tell where it points: ${ask}`;
  // an absolute value is normalized before the compare. Git Bash rewrites /d/x to d:/x (not with MSYS_NO_PATHCONV=1); otherwise
  // a rooted path without a drive is on the drive of the session's directory, as Windows reads it.
  let abs;
  if (base) abs = path.resolve(base, rel);
  else {
    let p = !ctx.powershell && !msys ? rel.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:') : rel;
    const drive = /^([a-z]:)/.exec(projectKey(ctx.cwd || ctx.root));
    if (/^[\\/](?![\\/])/.test(p) && (ctx.powershell || msys) && drive) p = drive[1] + p;
    abs = /^[A-Za-z]:/.test(p) ? path.win32.normalize(p) : path.posix.normalize(p.replace(/\\/g, '/'));
  }
  if (!inside(abs, ctx.root)) return `--cwd ${val} is outside the project (${ctx.root}): the guard would neither count nor watch the tab; start it in the project or a worktree under .claude/worktrees`;
  return '';
}

// The names an hc close aims at: `hc kill <name>` and `hc rm <name>` (lowercase).
function hcCloseNames(command, powershell) {
  const out = [];
  if (!/\bhc(?:\.exe)?\b/i.test(String(command))) return out;
  for (const seg of segments(readable(command), { powershell })) {
    const c = cliTokens(seg);
    if (!c || c.prog !== 'hc') continue;
    const { pos } = scan(c.tokens, 1, c.tokens.length, HC_VALUE_OPTS);
    if (pos.length > 1 && /^(?:kill|rm)$/i.test(pos[0].t) && !unknownValue(pos[1].t) && !out.includes(pos[1].t.toLowerCase())) out.push(pos[1].t.toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lists (hc ls / herdr agent list) as entries { name, status, cwd, pane, tab, address, parent }
function parseHerdrList(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j && j.error && j.error.code === 'server_not_running') return [];
  const list = j && j.result && j.result.agents;
  if (!Array.isArray(list)) return null;
  return list
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      name: String(a.name == null ? '' : a.name),
      status: String(a.agent_status == null ? '' : a.agent_status).toLowerCase(),
      cwd: String(a.cwd == null ? '' : a.cwd),
      pane: String(a.pane_id == null ? '' : a.pane_id),
      tab: String(a.tab_id == null ? '' : a.tab_id),
      workspace: String(a.workspace_id == null ? '' : a.workspace_id).toLowerCase(),
      address: '',
      parent: '',
      session: a.agent_session && a.agent_session.value ? String(a.agent_session.value) : '',
    }));
}

function parseHcList(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const list = j && j.terminals;
  if (!Array.isArray(list)) return null;
  return list
    .filter((t) => t && typeof t === 'object' && String(t.state == null ? '' : t.state).toLowerCase() === 'live')
    .map((t) => ({
      name: String(t.name == null ? '' : t.name),
      status: String(t.status == null ? '' : t.status).toLowerCase(),
      cwd: String(t.cwd == null ? '' : t.cwd),
      pane: '',
      tab: '',
      address: String(t.address == null ? '' : t.address),
      parent: String(t.parent == null ? '' : t.parent),
      agent: String(t.agent == null ? '' : t.agent),
      session: '',
    }));
}

// A directory in one comparable form: separators as "/", a \\?\ or //?/ prefix dropped, a Git-Bash /c/x as c:/x, no trailing "/",
// lower case, a worktree under <root>/.claude/worktrees read as <root>.
const projectKey = (d) =>
  String(d || '')
    .replace(/\\/g, '/')
    .replace(/^\/\/[?.]\/(?:UNC\/)?/i, '')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/\/+$/, '')
    .replace(/\/\.claude\/worktrees\/.*$/i, '')
    .toLowerCase();
function inside(cwd, root) {
  const c = projectKey(cwd);
  const r = projectKey(root);
  return Boolean(c) && Boolean(r) && (c === r || c.startsWith(`${r}/`));
}

// An entry of herdr's list belongs to its workspace_id, else to the workspace in front of the ":" of its pane id; unknown counts as inside.
const inWorkspace = (e, workspace) => {
  if (!workspace) return true;
  if (e.workspace) return e.workspace === workspace;
  return !e.pane || !String(e.pane).includes(':') || wsOfPane(e.pane) === workspace;
};

// The project's worker tabs: entries with a policy-valid worker name; herdr by workspace (when known) and cwd, hc by parent or cwd.
function inventory(entries, kind, { root, self, leadPrefix, workspace }) {
  return entries
    .filter((e) => kind !== 'herdr' || inWorkspace(e, workspace))
    .map((e) => ({ ...e, parsed: parseName(String(e.name).toLowerCase(), leadPrefix) })) // names compare case-insensitively here; the policy is for new starts
    .filter((e) => e.parsed.ok && e.parsed.role === 'worker')
    .filter((e) => (kind === 'hc' ? Boolean(self && e.parent === self) || inside(e.cwd, root) : inside(e.cwd, root)));
}

// Live agents in this workspace and project whose names are not valid for the policy (this session's own tab is never one).
function badNames(entries, kind, { root, self, session, leadPrefix, workspace }) {
  return entries
    .filter((e) => (kind === 'hc' ? Boolean(e.agent) && e.address !== self && ((Boolean(self) && e.parent === self) || inside(e.cwd, root)) : inWorkspace(e, workspace) && inside(e.cwd, root) && !(session && e.session === session)))
    .filter((e) => !parseName(String(e.name).toLowerCase(), leadPrefix).ok);
}

// The own herdr workspace. First the row of this session in the live list (entries, matched by session id): a pane the owner
// moved gets a new id in another workspace, while this process keeps the old ids in its env. Else the env: the prefix of
// HERDR_PANE_ID ("w4:p1" -> "w4"); HERDR_WORKSPACE_ID alone is taken as it is; when both are set and disagree, or neither
// is, it is unknown ('') and only the presence checks apply (herdr documents the ids as w1 and w1:p1).
function ownWorkspace(env = process.env, entries = null, session = '') {
  if (session && Array.isArray(entries)) {
    const me = entries.find((e) => e && e.session && e.session === session);
    const w = me ? me.workspace || wsOfPane(me.pane) : '';
    if (w) return String(w).toLowerCase();
  }
  const ws = String(env.HERDR_WORKSPACE_ID || '').trim().toLowerCase();
  const pane = wsOfPane(String(env.HERDR_PANE_ID || '').trim());
  if (pane) return ws && ws !== pane ? '' : pane;
  return ws;
}

// ---------------------------------------------------------------------------------------------------------------------
// PreToolUse: the rules
const alias = (m) => MODELS.find((x) => String(m).toLowerCase().includes(x)) || null;
const ENV_EXAMPLE = process.platform === 'win32' ? '"C:\\Program Files\\Git\\usr\\bin\\env.exe"' : 'env';
// a blanked quoted value is shown as "...", the blanked prompt (the last word) as "<task>"
const show = (tokens) => tokens.map((t, i) => (t === '""' ? (i === tokens.length - 1 ? '"<task>"' : '"..."') : t)).join(' ');

function suggestName(label, role) {
  const s = String(label == null ? '' : label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_NAME);
  return s && parseName(s, role === 'lead' ? 'lead-' : '').ok ? s : role === 'lead' ? 'lead-<name>' : '<pkg>-<kind>';
}

// Violations of the claude arguments (model alias, effort, -n equal to the tab name, permission args) and the fixed list.
// name: the tab name (a suggestion when it is not valid); cmp: whether -n is compared with it.
// The start row of the Routing table (skill ghorc:lead) by the role a tab name carries: the corrected form of a start
// that misses --model or --effort uses it, so a pasted fix never puts a Sonnet role on Opus.
const ROLE_ROW = {
  lead: ['opus', 'medium'],
  implementer: ['sonnet', 'medium'],
  reviewer: ['sonnet', 'medium'],
  'reviewer-critical': ['opus', 'high'],
  scout: ['sonnet', 'medium'],
  integrator: ['sonnet', 'medium'],
  release: ['sonnet', 'medium'],
  consult: ['sonnet', 'low'],
  media: ['sonnet', 'medium'],
  'log-reader': ['haiku', 'medium'],
};
function roleRow(name, leadPrefix) {
  const p = name ? parseName(String(name).toLowerCase(), leadPrefix) : null;
  if (!p || !p.ok) return ['sonnet', 'medium'];
  return ROLE_ROW[p.role === 'lead' ? 'lead' : p.kind] || ['sonnet', 'medium'];
}

function checkClaudeArgs(args, name, cmp, permArgs, v, leadPrefix = 'lead-') {
  const fixed = args.slice();
  const [rowModel, rowEffort] = roleRow(name, leadPrefix);
  const val = (names) => {
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      for (const n of names) {
        if (t === n) return { v: args[i + 1], at: i + 1, inline: false };
        if (t.startsWith(`${n}=`)) return { v: t.slice(n.length + 1), at: i, inline: true, n };
      }
    }
    return null;
  };
  const set = (hit, value) => {
    if (hit.inline) fixed[hit.at] = `${hit.n}=${value}`;
    else fixed[hit.at] = value;
  };

  const model = val(['--model']);
  if (!model) {
    v.push('--model is missing: pass --model <opus|sonnet|haiku|fable> (an alias follows the newest model)');
    fixed.unshift('--model', rowModel);
  } else if (!unknownValue(model.v) && !new RegExp(`^(?:${MODELS.join('|')})(?:\\[1m\\])?$`, 'i').test(model.v)) {
    const a = alias(model.v);
    v.push(`--model ${model.v} is not an alias: use ${a || 'opus, sonnet, haiku or fable'} (the alias follows the newest model; a full or versioned id does not)`);
    set(model, a || rowModel);
  }
  const effort = val(['--effort']);
  if (!effort) {
    v.push('--effort is missing: pass --effort <low|medium|high|xhigh|max>');
    fixed.push('--effort', rowEffort);
  } else if (!unknownValue(effort.v) && !EFFORTS.includes(effort.v.toLowerCase())) {
    v.push(`--effort ${effort.v} is not one of ${EFFORTS.join(', ')}`);
    set(effort, rowEffort);
  }
  const nm = val(['-n', '--name']);
  if (!nm) {
    v.push(`-n ${name || '<pkg>-<kind>'} is missing: the session name must equal the tab name, so /resume and the terminal title show it`);
    fixed.push('-n', name || '<pkg>-<kind>');
  } else if (cmp && name && !unknownValue(nm.v) && nm.v !== name) {
    v.push(`-n ${nm.v} differs from the tab name ${name}: use -n ${name}`);
    set(nm, name);
  }
  const have = new Set(args.flatMap((t) => (t.startsWith('--') && t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t])));
  const missing = permArgs.filter((a) => !have.has(a));
  if (missing.length) {
    v.push(`permission arguments are missing: ${missing.join(' ')}`);
    fixed.push(...missing);
  }
  // a blanked prompt ("") stays last
  const prompt = fixed.filter((t) => t === '""');
  return [...fixed.filter((t) => t !== '""'), ...prompt];
}

function nameViolation(name, leadPrefix, what) {
  const p = parseName(name, leadPrefix);
  return p.ok ? null : `${what} "${name}" is not allowed (${p.why}); ${POLICY_TEXT} (${leadPrefix}<name>)`;
}

// A claude program word (claude, claude.exe, .cmd, .ps1, with or without a path) behind a program of an hc run that is not claude:
// nothing in front of it is checked (GHORC_ROLE, --model, --effort, -n, the permission args). It is judged only where claude can be
// the program of what runs: behind a program that runs another program (RUNNERS: nohup, timeout, sudo, xargs ... and a NAME=value
// word, which needs env in front), behind a package runner (npx claude: the program it runs), inside the command string of a shell
// (claude as the program of a command of the string), and as a substitution or variable whose text says claude. Behind any other
// program claude is an argument (grep claude x, node claude, docker run --name claude img).
const SHELL_PROGS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'cmd', 'pwsh', 'powershell']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time', '!', '{']);
const SHELL_CMD =/^(?:-[A-Za-z]*c|\/[ckr]|-command)$/i; // the option that takes the command string; sh ./claude has none
const QUOTED_AFTER_ENV = 'a quoted word after env cannot be read (it may be an env option, a NAME=value word or the program): write the env options and NAME=value words unquoted';
const SPLIT_QUOTED = 'a quoted env -S string in front of hc or herdr cannot be read: write the hc or herdr command without env -S';
const TAIL = 'start claude directly or behind env with plain NAME=value words';
const runName = (w) => progName(w).replace(/\.(?:cmd|bat)$/, '');
// the words of a command string (decoded, after the -c / /c / -Command option): does claude run as the program of one of its commands?
function stringRunsClaude(words) {
  const k = words.findIndex((w) => SHELL_CMD.test(w));
  if (k < 0) return false;
  return words
    .slice(k + 1)
    .join(' ')
    .replace(/["']/g, '')
    .split(/[;&|()`\n]+/)
    .some((seg) => {
      let w = seg.trim().split(/\s+/);
      if (w[0] === '&') w = w.slice(1);
      // shell keywords and grouping words in front of the program (if, then, do, while, !, {, ...) are skipped, before and after the wrappers
      const skip = () => {
        while (w.length && SHELL_KEYWORDS.has(w[0])) w = w.slice(1);
      };
      skip();
      w = peelWrappers(w, RUNNER_VALUE);
      skip();
      return w.length > 0 && CLAUDE.test(w[0]);
    });
}
// An env -S string with a space in it in front of the program: the string was quoted, cmd.cjs blanked it, so the hc or herdr
// inside it is not seen as a start. The words up to the first hc / herdr word are looked at; the string has to say hc or herdr.
function envSplitQuoted(words) {
  for (let i = 0; i < words.length; i++) {
    if (PROGRAMS.hc.test(words[i]) || PROGRAMS.herdr.test(words[i])) return false;
    const m = /^(?:-[iv0]*S|--split-string=?)([\s\S]*)$/.exec(words[i]);
    const val = m ? (m[1] !== '' ? m[1] : words[i + 1]) : undefined;
    if (val !== undefined && /\s/.test(val) && HC_HERDR_WORD.test(val)) return true;
  }
  return false;
}
const hiddenSplit = (command, powershell) => rawSegments(command, powershell).some(envSplitQuoted);
// What the decoded words of an hc run show and the blanked segment does not: a quoted word that hides the start (env "-i" ...,
// env "GHORC_ROLE=worker" claude), a quoted env -S string, and a claude program behind a program (see above). Only when a blanked
// hc run was found at all (cmds), so text that merely contains the words (a heredoc) is not judged. -> reasons
const AMP_AFTER_RUN = '`&` ends the hc run there, so the program after it would run in the lead\'s own shell and not in the tab: write the program (env GHORC_ROLE=worker claude ...) directly after the hc run options';
// PowerShell: a mid-line `&` (a word `&`, or `&` glued to the next word) ends the statement, so the words after it are a command of
// their own (rawSegments keeps a lone & inside the segment: the call operator). A leading `&` stays the call operator.
function splitAmp(segs) {
  const out = [];
  for (const words of segs) {
    let cur = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (i > 0 && /^&(?:[^\s&]+)?$/.test(w)) { // not a quoted string that starts with `& ` (powershell -Command "& claude ...")
        cur.ampNext = w.length > 1 ? w.slice(1) : words[i + 1] || ''; // the first word of what follows the `&`
        out.push(cur);
        cur = w.length > 1 ? [w.slice(1)] : [];
      } else cur.push(w);
    }
    out.push(cur);
    if (words.pipe) out[out.length - 1].pipe = true;
  }
  return out.filter((w) => w.length);
}
// A decoded token against a blanked one: the same word, the same word behind a quoted program path, or a blanked quoted word.
const sameWord = (d, b) => d === b || b.includes('""') || d.replace(/^.*[\\/]/, '').toLowerCase() === b.toLowerCase();
const sameRun = (d, b) => d.length === b.length && d.every((t, i) => i === 0 || sameWord(t, b[i]));
// The blanked hc run (hcs, parseCommand) that a decoded hc run is the same text as, or null when that cannot be told for certain.
// A run whose words are the same in both readings, or a command with one run in each reading, pairs at once; with more runs they are
// paired by position when both readings found the same number and every word agrees, else by the one blanked run whose words agree.
// Never by "some other run is a claude start": a correct start next to a hidden one must not switch the check off for it.
function blankedPartner(r, key, decoded, hcs) {
  const same = hcs.find((p) => p.tokens.join(' ') === key);
  if (same) return same;
  if (decoded.length === 1 && hcs.length === 1) return hcs[0];
  const at = decoded.indexOf(key);
  if (decoded.length === hcs.length && at >= 0 && sameRun(r.tokens, hcs[at].tokens)) return hcs[at];
  const cand = hcs.filter((p) => sameRun(r.tokens, p.tokens));
  return cand.length === 1 ? cand[0] : null;
}
function rawRunReasons(command, powershell, cmds) {
  const hcs = cmds.filter((p) => p.type === 'hc-run');
  const out = [];
  const raw = rawSegments(command, powershell);
  const segs = powershell ? splitAmp(raw) : raw;
  // the decoded hc runs, one per distinct text and in order, as parseCommand lists the blanked ones
  const decoded = [];
  if (hcs.length) {
    for (const words of segs) {
      const c = cliTokens(words) || cliTokens(peelWrappers(words));
      if (!c || c.prog !== 'hc') continue;
      const r = parseHc(c.tokens, c.tokens.map((t) => t.toLowerCase()));
      if (r && !decoded.includes(r.tokens.join(' '))) decoded.push(r.tokens.join(' '));
    }
  }
  for (let n = 0; n < segs.length; n++) {
    const words = segs[n];
    if (envSplitQuoted(words)) out.push(SPLIT_QUOTED);
    const c = cliTokens(words) || cliTokens(peelWrappers(words));
    if (!c) continue;
    if (c.prog !== 'hc' || !hcs.length) continue;
    const r = parseHc(c.tokens, c.tokens.map((t) => t.toLowerCase()));
    if (!r) continue;
    if (words.ampNext !== undefined && (ENV_BIN.test(words.ampNext) || CLAUDE.test(words.ampNext))) out.push(AMP_AFTER_RUN);
    const key = r.tokens.join(' ');
    if (r.claude || r.envBad) {
      const partner = blankedPartner(r, key, decoded, hcs);
      if ((r.claude && !(partner && partner.claude)) || (r.envBad && !(partner && partner.envBad))) out.push(QUOTED_AFTER_ENV);
      continue;
    }
    if (r.progIdx >= r.tokens.length) continue;
    let k = r.progIdx;
    if (r.tokens[k] === '&' && k + 1 < r.tokens.length) k++; // PowerShell call operator
    const prog = r.tokens[k];
    const rest = r.tokens.slice(k + 1);
    const name = runName(prog);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prog)) {
      if (rest.some((w) => CLAUDE.test(w))) out.push(`${prog} in front of claude needs env: write env ${prog} claude ...`);
    } else if (prog[0] === '$' || prog[0] === '`') {
      // a substitution (the segmenter cuts $( ... ) into the next segment) or a variable that says claude
      const text = prog === '$' ? (segs[n + 1] || []).join(' ') : prog[0] === '`' ? r.tokens.slice(k).join(' ') : prog;
      if (/claude/i.test(text)) out.push(`the program is a substitution or variable that says claude: ${TAIL}`);
    } else if (RUNNERS.has(name)) {
      if (rest.some((w) => CLAUDE.test(w))) out.push(`claude behind ${name} cannot be checked: ${TAIL}`);
    } else if (PKG_RUNNERS.has(name)) {
      const w = peelWrappers(r.tokens.slice(k), RUNNER_VALUE);
      if (w.length && CLAUDE.test(w[0])) out.push(`claude behind ${name} cannot be checked: ${TAIL}`);
    } else if (SHELL_PROGS.has(name) && stringRunsClaude(rest)) {
      out.push(`claude inside the command string of ${name} cannot be checked: ${TAIL}`);
    }
  }
  return out;
}

// ctx: { s: settings, list: (kind) => entries|null (memoised), root, self, session, workspace (own herdr workspace id or ''), powershell,
//        devRe (compiled tabs.devCommands), pending: [{ name, agent }] }.
// -> { violations: string[], fixed: string|null }
function checkParsed(p, ctx) {
  const { s } = ctx;
  const v = [];
  let fixed = null;
  const kind = p.type === 'hc-run' ? 'hc' : 'herdr';
  const closeHint = kind === 'hc' ? 'hc kill <name>; hc rm <name>' : 'herdr tab close <tab_id> (tab_id from its herdr agent list row)';
  const roleOf = (name) => {
    const parsed = parseName(name, s.leadPrefix);
    return parsed.ok ? parsed.role : 'worker';
  };
  const ownWs = String(ctx.workspace || '').toLowerCase();
  const wsToken = ctx.powershell ? '$env:HERDR_WORKSPACE_ID' : '"$HERDR_WORKSPACE_ID"';
  const otherWs = (what, w) => `${what} is in workspace ${w}, this pane is in ${ownWs}: the lead acts in its own workspace only (ask the owner)`;
  if (kind === 'herdr' && p.foreign) {
    v.push(`${p.foreign.split('=')[0]} aims the command at another herdr session, machine or host: the lead starts and closes tabs only in its own session and workspace (ask the owner)`);
  }

  // a valid name: not used by a live tab, and room for one more agent worker
  const dupAndLimit = (name) => {
    const parsed = parseName(name, s.leadPrefix);
    // this session's own tab is neither a duplicate nor a worker (the second handoff of a lead named lead-next starts lead-next again)
    const own = (e) => (kind === 'hc' ? Boolean(ctx.self) && e.address === ctx.self : Boolean(ctx.session) && e.session === ctx.session);
    const all = ctx.list(kind);
    const scoped = (e) => (kind === 'hc' ? (Boolean(ctx.self) && e.parent === ctx.self) || inside(e.cwd, ctx.root) : inWorkspace(e, ownWs));
    const entries = all && all.filter((e) => !own(e) && scoped(e));
    const low = name.toLowerCase();
    const dup = entries && entries.find((e) => e.name.toLowerCase() === low);
    if (ctx.pending.some((x) => x.name === name) || dup) {
      v.push(`name ${name} is already used by a live tab: pick another name, or close the old tab first (${kind === 'hc' ? `hc kill ${name}; hc rm ${name}` : `herdr tab close ${(dup && dup.tab) || '<tab_id>'}`})`);
    } else if (parsed.role === 'worker' && !parsed.long && entries) {
      const inv = inventory(entries, kind, { root: ctx.root, self: ctx.self, leadPrefix: s.leadPrefix, workspace: ownWs }).filter((e) => !e.parsed.long);
      const n = inv.length + ctx.pending.filter((x) => x.agent).length;
      if (n >= s.maxWorkers) {
        v.push(`${n} agent workers are already live (tabs.maxWorkers is ${s.maxWorkers}${inv.length ? `: ${inv.map((e) => e.name).join(', ')}` : ''}): accept and close a finished one first (${closeHint}), or raise tabs.maxWorkers`);
      }
    }
    ctx.pending.push({ name, agent: parsed.role === 'worker' && !parsed.long });
  };

  if (p.type === 'tab-create') {
    const tk = p.tokens.slice();
    const tail = []; // appended to the corrected form
    const labels = optVals(p.opts, '--label');
    const label = labels.length ? labels[0] : null;
    const envs = optVals(p.opts, '--env');
    let valid = false;
    if (!label) {
      v.push('--label is missing: every tab is named, --label <pkg>-<kind> for a worker or --label <lead prefix><name> for a lead');
      tk.splice(p.at, 0, '--label', '<pkg>-<kind>');
      if (!envs.some((o) => /^GHORC_ROLE=/i.test(o.value || ''))) tail.push('--env', 'GHORC_ROLE=worker');
    } else if (!unknownValue(label.value)) {
      const bad = nameViolation(label.value, s.leadPrefix, '--label');
      const role = roleOf(label.value);
      if (bad) {
        v.push(bad);
        const sug = suggestName(label.value, role);
        if (label.inline) tk[label.i] = `--label=${sug}`;
        else tk[label.i + 1] = sug;
      }
      // a long-lived command tab (full, runner, train) runs a command, not a Claude session: it needs no role
      const pn = parseName(label.value, s.leadPrefix);
      const needsRole = !(pn.ok && pn.role === 'worker' && pn.long);
      const hasRole = !needsRole || envs.some((o) => /^GHORC_ROLE=/i.test(o.value || '') && o.value.slice(11).toLowerCase() === role);
      if (!bad && !hasRole && !envs.some((o) => unknownValue(o.value))) {
        v.push(`a ${role} tab needs --env GHORC_ROLE=${role} on herdr tab create (a variable set in front of herdr agent start never reaches the session)`);
      }
      if (v.length && !hasRole) tail.push('--env', `GHORC_ROLE=${role}`);
      valid = !bad;
    }
    // the own workspace and the owner's focus
    const wsOpt = optVals(p.opts, '--workspace')[0];
    if (!wsOpt) {
      v.push('--workspace is missing: without it herdr creates the tab in the UI-focused workspace, which may belong to another project; pass --workspace ' + wsToken);
      tail.push('--workspace', wsToken);
    } else if (String(wsOpt.value || '').startsWith('__SQ__') || (/[$%]/.test(wsOpt.value || '') && !WS_REF.test(wsOpt.value || ''))) {
      // only the exact variable (bash $HERDR_WORKSPACE_ID, PowerShell $env:HERDR_WORKSPACE_ID, cmd %HERDR_WORKSPACE_ID%) expands to the own workspace
      v.push(`--workspace ${String(wsOpt.value).replace('__SQ__', "'") + (String(wsOpt.value).startsWith('__SQ__') ? "'" : '')} does not name the own workspace: a single-quoted reference is not expanded and only the exact variable counts; pass --workspace ${wsToken}`);
      if (wsOpt.inline) tk[wsOpt.i] = `--workspace=${wsToken}`;
      else tk[wsOpt.i + 1] = wsToken;
    } else if (ownWs && ctx.envWorkspace && ctx.envWorkspace !== ownWs && WS_REF.test(wsOpt.value || '')) {
      // the pane was moved: its list row is in ownWs, while HERDR_WORKSPACE_ID of this process still holds the old workspace
      v.push(`--workspace ${wsOpt.value} still expands to ${ctx.envWorkspace}, but this pane is now in ${ownWs} (its herdr agent list row; the pane was moved): pass --workspace ${ownWs}`);
      if (wsOpt.inline) tk[wsOpt.i] = `--workspace=${ownWs}`;
      else tk[wsOpt.i + 1] = ownWs;
    } else if (ownWs && !WS_REF.test(wsOpt.value || '') && !unknownValue(wsOpt.value) && wsOpt.value.toLowerCase() !== ownWs) {
      v.push(`--workspace ${wsOpt.value} is not this pane's workspace (${ownWs}): the lead creates tabs in its own workspace only; pass --workspace ${wsToken}`);
      if (wsOpt.inline) tk[wsOpt.i] = `--workspace=${wsToken}`;
      else tk[wsOpt.i + 1] = wsToken;
    }
    if (!p.opts.some((o) => o.name === '--no-focus')) {
      v.push("--no-focus is missing: without it the new tab takes the owner's focus");
      tail.push('--no-focus');
    }
    // a tab outside the project is neither counted nor watched (the inventory needs its cwd inside the root)
    const cwdOpt = optVals(p.opts, '--cwd')[0];
    if (!cwdOpt) {
      v.push("--cwd is missing: without it the tab starts in the herdr server's directory, outside the project, and the guard neither counts nor watches it; pass --cwd <dir> inside the project (a worktree under .claude/worktrees counts)");
      tail.push('--cwd', '<dir>');
    }
    // the shape and the value are judged in tabCreateLines (checkCommand)
    if (v.length) fixed = [...tk, ...tail];
    if (valid) dupAndLimit(label.value);
  } else if (p.type === 'agent-start') {
    const tk = p.tokens.slice();
    const kinds = optVals(p.opts, '--kind');
    const isClaude = kinds.length > 0 && String(kinds[0].value).toLowerCase() === 'claude';
    let name = null;
    let known = false;
    if (!p.name) v.push('the agent name is missing: herdr agent start <pkg>-<kind> --kind claude --pane <pane> -- <claude args>');
    else if (!unknownValue(p.name.t)) {
      name = p.name.t;
      const bad = nameViolation(name, s.leadPrefix, 'agent name');
      if (bad) {
        v.push(bad);
        name = suggestName(name, 'worker');
        tk[p.name.i] = name;
      } else known = true;
    }
    const paneOpt = optVals(p.opts, '--pane')[0];
    if (ownWs && paneOpt && !unknownValue(paneOpt.value)) {
      const w = wsOfPane(paneOpt.value);
      if (w && w !== ownWs) v.push(otherWs(`--pane ${paneOpt.value}`, w));
    }
    if (isClaude) {
      const before = v.length;
      const fixedArgs = checkClaudeArgs(p.args, name, known, known ? (roleOf(name) === 'lead' ? s.leadPerm : s.workerPerm) : s.workerPerm, v, s.leadPrefix);
      if (v.length > before || v.length) fixed = [...(p.dd >= 0 ? tk.slice(0, p.dd + 1) : [...tk, '--']), ...fixedArgs];
    } else if (v.length) fixed = tk;
  } else if (p.type === 'herdr-other') {
    if (p.noun === 'workspace') {
      v.push(`herdr workspace ${p.verb} is the owner's: the lead works in its own workspace${ownWs ? ` (${ownWs})` : ''} and never creates or closes one`);
    } else if (p.noun === 'worktree') {
      v.push(`herdr worktree ${p.verb} is the owner's: a worktree workspace is a separate workspace; the lead keeps its tabs in its own workspace${ownWs ? ` (${ownWs})` : ''} and makes git worktrees with git`);
    } else if (p.noun === 'pane' && p.verb === 'move') {
      v.push(`herdr pane move is the owner's: a moved pane may leave this workspace${ownWs ? ` (${ownWs})` : ''} and gets a new pane id`);
    } else {
      if (p.noun === 'pane' && p.verb === 'split' && !p.opts.some((o) => o.name === '--no-focus')) {
        v.push("herdr pane split needs --no-focus: without it the new pane takes the owner's focus");
        fixed = [...p.tokens, '--no-focus'];
      }
      const tgt = optVals(p.opts, '--pane', '--tab')[0];
      const raw = tgt ? tgt.value : p.pos[0] && p.pos[0].t;
      if (ownWs && raw && !unknownValue(raw)) {
        const w = wsOfPane(raw); // the part of the id before ":" (an unqualified id is not judged)
        if (w && w !== ownWs) v.push(otherWs(`herdr ${p.noun} ${p.verb} target ${raw}`, w));
      }
    }
  } else {
    // hc run
    const tk = p.tokens.slice();
    const names = optVals(p.opts, '--name');
    const nm = names.length ? names[0] : null;
    const inserts = []; // right after `run`
    let name = null;
    let known = false;
    if (!nm) {
      v.push('--name is missing: every tab is named, --name <pkg>-<kind> for a worker or --name <lead prefix><name> for a lead');
      inserts.push('--name', '<pkg>-<kind>');
    } else if (!unknownValue(nm.value)) {
      name = nm.value;
      const bad = nameViolation(name, s.leadPrefix, '--name');
      if (bad) {
        v.push(bad);
        name = suggestName(name, 'worker');
        if (nm.inline) tk[nm.i] = `--name=${name}`;
        else tk[nm.i + 1] = name;
      } else known = true;
    }
    const parsed = known ? parseName(name, s.leadPrefix) : null;
    const role = parsed ? parsed.role : 'worker';
    if (parsed && parsed.long && parsed.role === 'worker' && !p.opts.some((o) => o.name === '--outlive-parent')) {
      v.push(`${name} is a long-lived tab (kind ${parsed.kind}): start it with --outlive-parent, otherwise closing the lead kills it`);
      inserts.push('--outlive-parent');
    }
    if (p.envBad) {
      v.push(`the env option ${p.envBad} cannot be checked: the guard cannot tell which program it starts, so a claude start could hide behind it (understood: -i, -, --ignore-environment, -u NAME, --unset NAME, --unset=NAME, --); pass plain NAME=value words after env instead`);
    }
    if (!p.claude && !p.envBad && known && parsed.kind !== 'runner' && ctx.devRe.length && p.progIdx < p.tokens.length) {
      const payload = p.tokens.slice(p.progIdx).join(' ');
      if (matches(payload, ctx.devRe, { powershell: ctx.powershell })) {
        v.push(`"${payload}" is a long-running process (tabs.devCommands): it runs only in a runner tab, hc run --bg --outlive-parent --name <pkg>-runner --cwd <dir> <cmd>`);
      }
    }
    let envRole = null;
    let fixedArgs = null;
    if (p.claude) {
      // also when the name is missing or invalid: the corrected form carries a worker name, so it must carry the worker role too
      if ((name !== null || !nm) && !p.assigns.some((a) => /^GHORC_ROLE=/i.test(a.t) && a.t.slice(11).toLowerCase() === role)) {
        v.push(`GHORC_ROLE=${role} is missing in front of claude (hc run has no --env): env GHORC_ROLE=${role} claude ...`);
        envRole = role;
      }
      fixedArgs = checkClaudeArgs(p.args, name, known, role === 'lead' ? s.leadPerm : s.workerPerm, v, s.leadPrefix);
    }
    if (v.length && !p.envBad) { // with an env option that cannot be read a corrected form would only echo it
      let head = tk.slice(0, p.progIdx);
      if (envRole) {
        if (p.envIdx >= 0) head.splice(p.envIdx + 1, 0, `GHORC_ROLE=${envRole}`);
        else head = [...head, ENV_EXAMPLE, `GHORC_ROLE=${envRole}`];
      }
      head.splice(p.run + 1, 0, ...inserts);
      fixed = fixedArgs ? [...head, tk[p.progIdx], ...fixedArgs] : [...head, ...tk.slice(p.progIdx)];
    }
    if (known) dupAndLimit(name);
  }
  return { violations: v, fixed: fixed ? show(fixed) : null };
}


// Git Bash turns an argument that starts with "/" into a path; PowerShell converts nothing, so its forms carry no prefix.
const msys = (powershell) => (powershell ? '' : 'MSYS_NO_PATHCONV=1 ');

// A send into a pane by the lead: the payload is one line without " or a backtick (it may be cut or submitted early, and
// PowerShell drops quotes in a native argument), and nothing goes to a pane whose fresh list row is `blocked` (the text plus
// Enter would answer its dialog). `send-keys` of single keys only (a digit, a letter, enter, escape, an arrow) stays allowed to a
// blocked pane: that is how a dialog is answered when the owner says so. `unknown` is not denied: a freshly started session may
// show it before its first prompt.
const KEY_NAMES = /^(?:.|enter|return|escape|esc|tab|space|backspace|bspace|delete|del|up|down|left|right|home|end|pageup|pagedown|pgup|pgdn|(?:c|ctrl|m|alt|s|shift)[-+].|f\d{1,2})$/i;
const onlyKeys = (x) => x.verb === 'send-keys' && x.payload.length > 0 && x.payload.every((k) => KEY_NAMES.test(k));
function checkSend(x, ctx) {
  const v = [];
  const pfx = msys(ctx.powershell);
  if (x.verb !== 'send-keys') {
    const text = x.payload.join(' ');
    const bad = [/[\r\n]/.test(text) && 'a newline', text.includes('"') && 'a double quote', text.includes('`') && 'a backtick'].filter(Boolean);
    if (bad.length) {
      v.push(`the text carries ${bad.join(', ')}: a pane send must be one line without " or backticks, or it may be cut, submitted early or lose its quotes. Write the text to a file and send one line that points to it: ${pfx}herdr pane run <pane_id> "Read <file> and follow it."`);
    }
  }
  const tgt = x.target;
  if (tgt && !unknownValue(tgt) && !onlyKeys(x)) {
    const all = ctx.list('herdr');
    const low = tgt.toLowerCase();
    const e = all && all.find((a) => (a.pane && a.pane.toLowerCase() === low) || (a.name && a.name.toLowerCase() === low));
    if (e && e.status === 'blocked') {
      v.push(`${tgt} is blocked on a dialog (herdr agent list): text sent now would answer it. Read its screen (herdr pane read ${e.pane || tgt} --source recent --lines 40) and tell the owner; never answer a permission prompt yourself. When the owner tells you the answer, send it as single keys: ${pfx}herdr pane send-keys ${e.pane || tgt} <key> enter (a digit, y/n, enter, escape or an arrow).`);
    }
  }
  return v;
}

// -> reason string, or null when the command is fine. Never throws: a command with an hc or herdr word that the guard cannot
// parse (an error, nesting deeper than MAX_NEST) is denied; any other command never gets here.
const UNREADABLE = 'the guard could not parse this command (nesting too deep or an internal error): write it as plain one-line commands';
// workspace: the own herdr workspace id, or a function that returns it (asked once, only when a herdr command is judged).
function checkCommand(command, { powershell = false, s, list, root, cwd, self, session, workspace = '', envWorkspace = '' }) {
  try {
    if (!HC_HERDR_WORD.test(command)) return null;
    const cmds = parseCommand(command, powershell);
    const sends = sendCommands(command, powershell);
    if (!cmds.length && !sends.length && !/\btab\b/i.test(command) && !hiddenSplit(command, powershell)) return null;
    const cache = {};
    const needWs = sends.length > 0 || cmds.some((p) => p.type !== 'hc-run');
    let ws = workspace;
    if (typeof workspace === 'function') {
      try {
        ws = needWs ? workspace() : '';
      } catch {
        ws = '';
      }
    }
    const ctx = { s, root, cwd, self, session, workspace: ws, envWorkspace: String(envWorkspace || '').toLowerCase(), powershell, devRe: compile(s.devCommands), pending: [], list: (kind) => (kind in cache ? cache[kind] : (cache[kind] = list(kind))) };
    const lines = [];
    for (const p of cmds) {
      let r;
      try {
        r = checkParsed(p, ctx);
      } catch {
        continue;
      }
      if (!r.violations.length) continue;
      const head = p.type === 'tab-create' ? 'herdr tab create' : p.type === 'agent-start' ? 'herdr agent start' : p.type === 'herdr-other' ? `herdr ${p.noun} ${p.verb}` : 'hc run';
      lines.push(`${head}:`);
      for (const x of r.violations) lines.push(`- ${x}`);
      if (r.fixed) lines.push(`Corrected form: ${r.fixed}`);
    }
    try {
      const extra = rawRunReasons(command, powershell, cmds).filter((x) => !lines.includes(`- ${x}`));
      if (extra.length) lines.push('hc run:', ...[...new Set(extra)].map((x) => `- ${x}`));
    } catch {
      /* the blanked reading above stands */
    }
    // the shape of a tab create (see TAB_SHAPE) and the --cwd values of the canonical form
    if (/\btab\b/i.test(command)) {
      const v = tabCreateLines(command, ctx, lines.some((l) => l.startsWith('- --cwd is missing')));
      if (v.length) {
        lines.push('herdr tab create --cwd:');
        for (const t of v) lines.push(`- ${t}`);
      }
    }
    for (const x of sends) {
      let v = [];
      try {
        v = checkSend(x, ctx);
      } catch {
        continue;
      }
      if (!v.length) continue;
      lines.push(`herdr pane ${x.verb}:`);
      for (const t of v) lines.push(`- ${t}`);
    }
    if (!lines.length) return null;
    return `tabs-guard: tab command refused (config tabs, docs/hooks.md#tabs-guardcjs; tabs.enabled=false turns the guard off).\n${lines.join('\n')}`;
  } catch {
    return `tabs-guard: tab command refused (config tabs, docs/hooks.md#tabs-guardcjs; tabs.enabled=false turns the guard off).\n- ${UNREADABLE}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Long-running processes (tabs.devCommands): only in a runner tab
// The first segment of a command line that matches a pattern of tabs.devCommands, or null. A quoted payload (`herdr pane run <pane> "<cmd>"`)
// is blanked by cmd.cjs, so a launch in a tab does not match; the `hc run ... <cmd>` payload is judged in checkParsed.
// pnpm exec / pnpm dlx / yarn dlx|exec / bunx / bun x run a tool of the project: read as the tool itself (npx is peeled by cmd.cjs).
const TOOL_RUNNER = /^(?:(?:pnpm|yarn)\s+(?:exec|dlx)|pnpm\s+x|bunx|bun\s+x)\s+(?:--?[\w-]+(?:=\S+)?\s+)*/i;
function devMatch(command, patterns, powershell) {
  try {
    const res = compile(patterns); // a pattern that does not compile is dropped, the others stay
    if (!res.length) return null;
    for (const seg of segments(String(command), { powershell })) {
      if (matches(seg, res, { powershell })) return seg;
      if (TOOL_RUNNER.test(seg) && matches(seg.replace(TOOL_RUNNER, ''), res, { powershell })) return seg;
    }
  } catch {
    /* never throws: a parse problem is "no match" */
  }
  return null;
}

// The bound of a `herdr agent list` read of the guard: 2500 ms, or GHORC_TOOL_TIMEOUT_MS when it is a positive number (tests on a loaded machine).
const listMs = (env = process.env) => {
  const n = Number(env.GHORC_TOOL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2500;
};

// The terminal backend of this session, 'hc' | 'herdr' | 'none' (the test seams count as a backend); asked only after a match.
function backendKind(env = process.env, cwd, session) {
  try {
    if (env.GHORC_CAPACITY_HC_JSON !== undefined) return 'hc';
    if (env.GHORC_CAPACITY_HERDR_JSON !== undefined) return 'herdr';
    return backend.detect({ env, cwd, timeoutMs: listMs(env), session, verdictOnly: true }).backend;
  } catch {
    return 'none';
  }
}

// The deny reason for a dev command: the lead gets the runner form, a subagent or worker the instruction to report BLOCKED.
function devReason(seg, command, { kind, lead, background, powershell }) {
  const shown = seg.replace(/""/g, '"..."');
  const bg = background ? ' A background task (run_in_background) hides it just the same.' : '';
  const head = `tabs-guard: "${shown}" is a long-running process (matches tabs.devCommands): it runs only in a <pkg>-runner tab, never in a shell or a background task.${bg}`;
  if (!lead) {
    const exact = String(command).replace(/\s+/g, ' ').trim().slice(0, 300);
    return `${head} A subagent or worker does not start it: end your report with BLOCKED <name>: <why>, with the exact command \`${exact}\` and its directory, and the lead starts it in a runner tab.`;
  }
  const ws = powershell ? '$env:HERDR_WORKSPACE_ID' : '"$HERDR_WORKSPACE_ID"';
  const herdr = `herdr tab create --workspace ${ws} --no-focus --label <pkg>-runner --cwd <dir>, then ${msys(powershell)}herdr pane run <pane_id> "${shown}"`;
  const hc = `hc run --bg --outlive-parent --name <pkg>-runner --cwd <dir> ${shown}`;
  return `${head} Runner form (${kind}): ${kind === 'hc' ? hc : herdr}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Monitoring
const IDLE = new Set(['idle', 'done']);
const KNOWN_STATUS = new Set(['working', 'idle', 'done', 'blocked']);
const STATE_KEEP_MS = 7 * 24 * 3600 * 1000;
const stateFile = (session) => path.join(tmpDir(), `tabs-${safeId(session).slice(0, 16)}.json`);

function readTabState(session) {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(session), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) && j.workers && typeof j.workers === 'object' && !Array.isArray(j.workers) ? j : { workers: {} };
  } catch {
    return { workers: {} };
  }
}
// Writes the state and drops the state files of other sessions that are older than 7 days.
function writeTabState(session, state, now = Date.now()) {
  try {
    fs.mkdirSync(tmpDir(), { recursive: true });
    atomicWrite(stateFile(session), JSON.stringify(state));
    for (const f of fs.readdirSync(tmpDir())) {
      if (!/^(?:tabs|backend)-.*\.json$/.test(f)) continue; // backend-*: the verdict cache of lib/backend.cjs
      try {
        const p = path.join(tmpDir(), f);
        if (p !== stateFile(session) && now - fs.statSync(p).mtimeMs > STATE_KEEP_MS) fs.rmSync(p, { force: true });
      } catch {
        /* a file that cannot be removed stays */
      }
    }
  } catch {
    /* the state is optional: without it the runtime restarts at every run */
  }
}

// The live list of the active backend, read once: { kind, entries, self } or null (no backend, tool missing, unreadable).
// prefer ('hc' | 'herdr'): which backend to take when both are present (the PreToolUse check passes the backend of the command; the
// caller compares kind). Seams like capacity.liveWorkers: GHORC_CAPACITY_HC_JSON and GHORC_CAPACITY_HERDR_JSON (prefer picks
// which is read first). Otherwise backend.detect decides, honouring GHORC_HC_BIN / GHORC_HERDR_BIN; its herdr probe is the list.
function readLive(env = process.env, cwd, prefer, session) {
  try {
    const seams = {
      hc: () => (env.GHORC_CAPACITY_HC_JSON !== undefined ? { kind: 'hc', entries: parseHcList(env.GHORC_CAPACITY_HC_JSON), self: String(env.HC_TERMINAL_ID || '').trim() } : null),
      herdr: () => (env.GHORC_CAPACITY_HERDR_JSON !== undefined ? { kind: 'herdr', entries: parseHerdrList(env.GHORC_CAPACITY_HERDR_JSON), self: '' } : null),
    };
    for (const k of prefer === 'herdr' ? ['herdr', 'hc'] : ['hc', 'herdr']) {
      const r = seams[k]();
      if (r) return r.entries ? r : null;
    }
    // the verdict may come from the 30 s cache, the list never does: the probe below is a fresh `herdr agent list`
    const d = backend.detect({ env, cwd, prefer, timeoutMs: listMs(env), session });
    if (d.backend === 'hc') {
      const raw = backend.hcText(env);
      const entries = raw === null ? null : parseHcList(raw);
      return entries ? { kind: 'hc', entries, self: d.terminal } : null;
    }
    if (d.backend === 'herdr' && !d.failed) {
      const entries = parseHerdrList(d.raw);
      return entries ? { kind: 'herdr', entries, self: '' } : null;
    }
  } catch {
    /* unreadable: no report */
  }
  return null;
}

const readCmd = (live, e) => (live.kind === 'hc' ? `hc read ${e.name}` : `herdr pane read ${e.pane || '<pane>'} --source recent --lines 40`);
const closeCmd = (live, e) => (live.kind === 'hc' ? `hc kill ${e.name}; hc rm ${e.name}` : `herdr tab close ${e.tab || '<tab_id>'}`);
const BLOCKED_RESULT = /^(?:BLOCKED\s|VERDICT BLOCKED(?:\s|$))/;

// evaluate(live, state, now, { root, s }) -> { live: n, lines: [], blocked: [names], finished: [names], stopNew: [{ key, flag }], state, toNotify: [names] }
// Does not touch the disk except for the report files; the caller saves state. A result line counts only when the report was written
// at or after the last recorded task send to that worker, else (no send recorded) at or after the first sighting of the tab (a name is
// reused across fix rounds, so an old report is normal; see freshSince). stopNew: the
// BLOCKED / FINISHED / NORESULT flags that have not yet blocked Stop (state `sb`); the caller records them with markStopped when it blocks.
// Whether the Stop input shows no live background wait: true only when background_tasks is a list and none of its in-flight
// entries is a shell or monitor task (the form a background `hc wait` / `herdr agent wait` takes). Unknown input: false.
const WAIT_TYPE = /^(shell|bash|local_bash|monitor|monitor_mcp)$/i;
const TASK_DONE = /^(completed|failed|killed)$/i;
function noLiveWait(tasks) {
  if (!Array.isArray(tasks)) return false;
  return !tasks.some((t) => t && WAIT_TYPE.test(String(t.type == null ? '' : t.type)) && !TASK_DONE.test(String(t.status == null ? '' : t.status)));
}
const NOWAIT_REPEAT_MS = 10 * 60 * 1000;
const CLOSE_CHECK_MS = 60 * 60 * 1000;
// NORESULT: a worker that was just sent a task turns `working` a moment later, so the flag waits this long after the send; a send
// whose tab has not shown up in the list yet is remembered this long
const NORESULT_GRACE_MS = 60 * 1000;
const TASK_KEEP_MS = 60 * 60 * 1000;

// A text that only drives the session (/exit, /clear, /compact ...) is not a task: the closing sequence (result accepted, `/exit`)
// must not make the delivered result stale. Judged on the decoded text of the send, before quotes are blanked.
const SESSION_COMMAND = /^\/(?:exit|quit|clear|compact|resume|rewind|help|status|cost|context|usage|model|config|doctor|memory|login|logout)(?:\s.*)?$/i;
const isTaskText = (words) => {
  const t = words.join(' ').trim();
  return t !== '' && !SESSION_COMMAND.test(t);
};
const PROMPT_OPTS = new Set([...HERDR_VALUE_OPTS, '--until']);

// Whether the claude arguments of an hc run carry a prompt: a positional word (a quoted word is blanked to "" by cmd.cjs), not the
// value of an option. An option that takes exactly one value consumes the next word; a flag takes none; a variadic option (--allowedTools
// ...) or one this list does not know may take the next words, so a word after it is not taken for the prompt. Where it cannot tell
// it answers false: the start then records nothing (the seen-working signal still covers the worker).
const CLAUDE_VALUE_OPTS = new Set(['--model', '--effort', '-n', '--name', '--permission-mode', '--append-system-prompt', '--system-prompt', '--append-system-prompt-file', '--system-prompt-file', '--settings', '--session-id', '--agent', '--agents', '--fallback-model', '--output-format', '--input-format', '--max-turns', '--max-budget-usd', '--setting-sources', '--permission-prompt-tool']);
const CLAUDE_FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--continue', '-c', '--print', '-p', '--strict-mcp-config', '--fork-session', '--bare', '--include-partial-messages', '--no-session-persistence', '--chrome', '--no-chrome']);
function claudeHasPrompt(args) {
  let unsure = false; // after an option that may take several or unknown values: until the next option word
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') return i + 1 < args.length; // everything after is positional
    if (t.startsWith('-') && t !== '-' && t !== '""') {
      unsure = false;
      if (t.includes('=') || CLAUDE_FLAGS.has(t)) continue;
      if (CLAUDE_VALUE_OPTS.has(t)) i++;
      else unsure = true;
      continue;
    }
    if (!unsure) return true; // a positional word that no option takes
  }
  return false;
}

// The workers a command hands a task to (lowercase names): `hc run ... claude ... "<task>"`, `hc send <name> "<text>"`, the text
// sends `herdr pane run|send-text <pane or name> "<text>"` and `herdr agent prompt <name or pane> "<text>"` (a pane id is resolved by
// the herdr list, read only when needed). A send whose decoded text is only a session command (SESSION_COMMAND) is not a task.
// Recorded by the PreToolUse check for NORESULT; what it cannot read records nothing. A herdr send counts only for a pane of this
// lead's own inventory (the workspace and project test of the worker list; ctx = { root, self, leadPrefix, workspace: () => id });
// a name that is not listed at all is taken as a tab that has not shown up yet.
function taskNames(command, powershell, list, ctx = {}) {
  const out = [];
  const add = (n) => {
    if (typeof n === 'string' && !unknownValue(n) && !out.includes(n.toLowerCase())) out.push(n.toLowerCase());
  };
  const herdrWorker = (target) => {
    if (!target || unknownValue(target)) return;
    const low = target.toLowerCase();
    const all = list('herdr');
    const same = (a) => (a.pane && a.pane.toLowerCase() === low) || (a.name && a.name.toLowerCase() === low);
    const ws = String(typeof ctx.workspace === 'function' ? ctx.workspace() : ctx.workspace || '').toLowerCase();
    const mine = all ? inventory(all, 'herdr', { root: ctx.root, self: ctx.self, leadPrefix: ctx.leadPrefix, workspace: ws }).find(same) : null;
    if (mine) add(mine.name);
    else if (!target.includes(':') && !(all && all.some(same))) add(target);
  };
  if (!HC_HERDR_WORD.test(String(command))) return out; // the prefilter of parseCommand: every form the start checks see is seen here
  for (const p of parseCommand(command, powershell)) {
    if (p.type !== 'hc-run' || !p.claude || !claudeHasPrompt(p.args)) continue;
    const nm = optVals(p.opts, '--name')[0];
    if (nm) add(nm.value);
  }
  for (const words of rawSegments(command, powershell)) {
    const c = cliTokens(words) || cliTokens(peelWrappers(words));
    if (!c) continue;
    const t = c.tokens;
    if (c.prog === 'hc') {
      const { pos } = scan(t, 1, t.length, HC_VALUE_OPTS);
      if (pos.length > 1 && pos[0].t.toLowerCase() === 'send' && isTaskText(t.slice(pos[1].i + 1))) add(pos[1].t);
      continue;
    }
    for (let i = 1; i + 1 < t.length; i++) {
      if (t[i].toLowerCase() !== 'agent' || t[i + 1].toLowerCase() !== 'prompt') continue;
      const { opts, pos } = scan(t, i + 2, t.length, PROMPT_OPTS);
      if (!opts.some(isHelp) && pos.length > 1 && isTaskText(pos.slice(1).map((x) => x.t))) herdrWorker(pos[0].t);
      break;
    }
  }
  for (const x of sendCommands(command, powershell)) {
    if (x.verb !== 'send-keys' && isTaskText(x.payload)) herdrWorker(x.target);
  }
  return out;
}

// One definition of "fresh" for FINISHED, NORESULT, STALLED and GONE: a result line counts when its report was written at or after the
// last recorded task send to that worker; only when no send is recorded (0) the tab's first sighting is the bound. A report written
// after the send is fresh whenever the guard first saw the tab (the lead often starts a worker and sees the tab only after it finished),
// and a second task in the same tab is not answered by the first task's line.
const freshSince = (firstSeen, taskAt) => (taskAt > 0 ? taskAt : firstSeen);
const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// " (its report still ends with a result line from 07:14, written before the task sent at 07:20)": the note of NORESULT and STALLED
// when the report has a result line that is not fresh; empty without one
const staleNote = (res, since, sent) => (res ? ` (its report still ends with a result line from ${clock(res.mtimeMs)}, written before ${sent ? 'the task sent' : 'this tab was first seen'} at ${clock(since)})` : '');

// Records in the state of this session that these workers were handed a task now, for the NORESULT flag.
function recordTasks(session, names, now = Date.now()) {
  if (!names.length) return;
  const st = readTabState(session);
  st.tasked = { ...(st.tasked && typeof st.tasked === 'object' && !Array.isArray(st.tasked) ? st.tasked : {}) };
  for (const n of names) st.tasked[n] = now;
  writeTabState(session, st, now);
}

// Records the names of an hc close in the state of this session, for the CLOSE? check of the next report.
function recordClose(session, names, now = Date.now()) {
  if (!names.length) return;
  const st = readTabState(session);
  st.closing = { ...(st.closing && typeof st.closing === 'object' ? st.closing : {}) };
  for (const n of names) st.closing[n] = now;
  writeTabState(session, st, now);
}

function evaluate(live, prevState, now, { root, s, workspace = '', session = '' }) {
  const ws = String(workspace || '').toLowerCase();
  const inv = inventory(live.entries, live.kind, { root, self: live.self, leadPrefix: s.leadPrefix, workspace: ws });
  const state = { workers: {} };
  const rows = [];
  const toNotify = [];
  const stopNew = [];
  const taskedOld = prevState.tasked && typeof prevState.tasked === 'object' && !Array.isArray(prevState.tasked) ? prevState.tasked : {};
  for (const e of inv) {
    const key = e.name.toLowerCase();
    const prev = prevState.workers[key];
    const isNew = !(prev && typeof prev === 'object' && typeof prev.firstSeen === 'number');
    const w = isNew ? { firstSeen: now, status: e.status, statusSince: now, notified: false } : { ...prev };
    const taskAt = typeof taskedOld[key] === 'number' ? taskedOld[key] : 0; // the last recorded task send to this worker
    const res0 = isNew ? resultLine(root, key) : null;
    if (isNew && res0 && !taskAt && e.status !== 'working' && e.status !== 'blocked') w.rq = true; // first seen with a result line of an unplaced round (no recorded send): quiet until its status changes
    if (w.status !== e.status) {
      w.status = e.status;
      w.statusSince = now;
      delete w.rq;
    }
    if (e.status === 'working') {
      w.worked = true; // the guard saw it work: it was given a task
      w.wAt = now; // when: a sighting after a recorded send ends that send's grace period
    }
    if (e.status !== 'blocked') w.notified = false;
    else if (!w.notified) {
      toNotify.push(e.name);
      w.notified = true;
    }
    const long = e.parsed.long;
    const res = resultLine(root, key);
    const since = freshSince(w.firstSeen, taskAt);
    const fresh = res && res.mtimeMs >= since ? res : null;
    const stale = res && !fresh ? staleNote(res, since, taskAt > 0) : ''; // a result line that is there but not fresh, said in the NORESULT and STALLED texts
    const runMin = Math.max(0, Math.floor((now - w.firstSeen) / 60000));
    const idleMin = IDLE.has(e.status) ? Math.max(0, Math.floor((now - w.statusSince) / 60000)) : 0;
    const flags = [];
    const finished = Boolean(fresh) && (e.status === 'working' ? fresh.mtimeMs >= w.statusSince : e.status !== 'blocked');
    if (e.status === 'blocked') flags.push(['BLOCKED', `${e.name} waits on a dialog. Read its screen (${readCmd(live, e)}) and tell the owner; never answer a permission prompt yourself.`]);
    if (finished && BLOCKED_RESULT.test(fresh.line)) {
      flags.push(['FINISHED', `${e.name} reported ${JSON.stringify(fresh.line)}: BLOCKED by the worker. Bring it to the owner; close the tab (${closeCmd(live, e)}) after the owner decides.`]);
    } else if (finished) {
      flags.push(['FINISHED', `${e.name} wrote ${JSON.stringify(fresh.line)} but its tab is still open. Accept the report and close the tab now: ${closeCmd(live, e)}.`]);
    }
    // a result line already there at the first sighting (a worker that finished before this lead saw it, e.g. after a restart): a soft
    // question, never a Stop block; a tab that is working or blocked has not finished
    // (only when no send is recorded for the worker: with a recorded send the line is placed, fresh (FINISHED) or the previous task's
    // (NORESULT), so there is nothing to ask)
    const soft = isNew && res && !taskAt;
    if (soft && e.status !== 'working' && e.status !== 'blocked') {
      flags.push(['RESULT?', `${e.name} has a result line from ${clock(res.mtimeMs)}: if it is the current round, accept it and close the tab`]);
    }
    // NORESULT: a tasked worker (seen working, or sent a task by a command this guard recorded) is idle or done and its report has no
    // fresh result line, so its package is not delivered. Not within NORESULT_GRACE_MS of the send unless the guard has seen the worker
    // work since the send, and not for a tab that RESULT? asks about
    const grace = taskAt > 0 && now - taskAt < NORESULT_GRACE_MS && !(typeof w.wAt === 'number' && w.wAt > taskAt);
    const noResult = !long && !fresh && IDLE.has(e.status) && (w.worked === true || taskAt > 0) && !soft && !grace;
    if (noResult) {
      flags.push(['NORESULT', `${e.name} is ${e.status} and has no fresh result line${stale}, so its package is NOT delivered. Expected report: ${path.resolve(reportFile(root, key))}. Read its screen (${readCmd(live, e)}), ask the same worker once to write the file with the result line last, and do not continue without it.`]);
    }
    // a status that is none of the four herdr and hc are known to report is shown, so a renamed status cannot hide a dialog
    if (!KNOWN_STATUS.has(e.status)) flags.push(['UNKNOWN', `${e.name} reports status ${JSON.stringify(e.status)}: read its screen`]);
    // a tab without a fresh result line (a stale one from an earlier round does not count) is "stalled"; NORESULT already says it
    if (!long && !fresh && !noResult && idleMin >= s.idleMin) flags.push(['STALLED', `${e.name} has been idle ${idleMin}m without ${stale ? `a fresh result line${stale}` : 'a result line'}. Read its screen (${readCmd(live, e)}) and decide.`]);
    if (!long && !finished && !w.rq && runMin >= s.overtimeMin) flags.push(['OVERTIME', `${e.name} runs ${runMin}m (tabs.overtimeMin ${s.overtimeMin}). Read its screen (${readCmd(live, e)}) and decide.`]);
    const names = flags.map((f) => f[0]);
    w.sb = (Array.isArray(w.sb) ? w.sb : []).filter((f) => names.includes(f)); // a flag that went away may block Stop again later
    for (const f of ['BLOCKED', 'FINISHED', 'NORESULT']) if (names.includes(f) && !w.sb.includes(f)) stopNew.push({ key, flag: f });
    state.workers[key] = w;
    rows.push({ e, runMin, flags, long });
  }
  // a recorded send is kept while the worker is in the inventory, or while its tab has not shown up yet (never seen, not listed, under
  // TASK_KEEP_MS); a worker that left the inventory is forgotten, so a later tab of the same name starts clean
  const listedNames = new Set(live.entries.map((e) => String(e.name).toLowerCase()));
  for (const [key, at] of Object.entries(taskedOld)) {
    if (typeof at !== 'number') continue;
    if (state.workers[key] || (!prevState.workers[key] && !listedNames.has(key) && now - at < TASK_KEEP_MS)) state.tasked = { ...(state.tasked || {}), [key]: at };
  }
  const agentCount = rows.filter((r) => !r.long).length;
  const lines = [];
  const blocked = [];
  const finishedNames = [];
  if (rows.length) {
    const shown = rows.slice(0, 12).map((r) => `${r.e.name} ${r.e.status || '?'} ${r.runMin}m`);
    lines.push(`tabs: ${rows.length} live (${shown.join(', ')}${rows.length > 12 ? ', ...' : ''})`);
    for (const r of rows) for (const [f, text] of r.flags) lines.push(`tabs ${f}: ${text}`);
    if (agentCount > s.maxWorkers) lines.push(`tabs OVER_LIMIT: ${agentCount} agent workers are live, tabs.maxWorkers is ${s.maxWorkers}. Close finished ones before opening more.`);
    for (const r of rows) {
      if (r.flags.some((f) => f[0] === 'BLOCKED')) blocked.push(r.e.name);
      if (r.flags.some((f) => f[0] === 'FINISHED')) finishedNames.push(r.e.name);
    }
  }
  // live agents of this workspace and project whose names break the policy are not workers to the guard; say so
  for (const e of badNames(live.entries, live.kind, { root, self: live.self, session, leadPrefix: s.leadPrefix, workspace: ws })) {
    const why = parseName(String(e.name).toLowerCase(), s.leadPrefix).why;
    lines.push(`tabs BADNAME: ${e.name ? JSON.stringify(e.name) : '(no name)'} (${e.status || '?'}) breaks the tab naming policy (${why}), so it is neither counted nor watched: rename it or close it`);
  }
  // a worker seen before that left the list without a fresh result line: its tab was closed or its session ended. Only a name
  // gone from the whole list counts (not one that merely left the inventory: another cwd, a workspace verdict that flipped), and
  // never a long-lived tab (a runner has no result line). Kept in state.gone until a run shows it (markShown): a Stop that does
  // not block shows nothing.
  const listed = new Set(live.entries.map((e) => String(e.name).toLowerCase()));
  const goneOld = prevState.gone && typeof prevState.gone === 'object' && !Array.isArray(prevState.gone) ? prevState.gone : {};
  for (const [key, w] of Object.entries({ ...goneOld, ...(prevState.workers || {}) })) {
    if (listed.has(key) || !w || typeof w !== 'object' || typeof w.firstSeen !== 'number') continue;
    if (parseName(key, s.leadPrefix).long) continue;
    const res = resultLine(root, key);
    if (res && res.mtimeMs >= freshSince(w.firstSeen, typeof taskedOld[key] === 'number' ? taskedOld[key] : 0)) continue;
    state.gone = { ...(state.gone || {}), [key]: w };
    lines.push(`tabs GONE: ${key} left ${live.kind === 'hc' ? 'hc ls' : 'herdr agent list'} without a result line: its tab was closed or its session ended. Read its report file (${path.resolve(reportFile(root, key))}) if there is one, then re-brief or drop the package.`);
  }
  // an hc close (hc kill / hc rm, recorded by the PreToolUse check) whose name is still listed: these hc forms are not verified
  // against a live hc, so the close is checked here once and reported, never repeated
  const closing = prevState.closing && typeof prevState.closing === 'object' ? prevState.closing : {};
  for (const [name, at] of Object.entries(closing)) {
    if (live.kind !== 'hc' || typeof at !== 'number' || now - at > CLOSE_CHECK_MS) continue;
    if (live.entries.some((e) => String(e.name).toLowerCase() === name)) {
      state.closing = { ...(state.closing || {}), [name]: at }; // kept until a run shows it (markShown)
      lines.push(`tabs CLOSE?: ${name} is still listed by hc ls after hc kill / hc rm: the close did not take (these hc forms are unverified). Close it by hand or tell the owner.`);
    }
  }
  const working = rows.filter((r) => !r.long && r.e.status === 'working').map((r) => r.e.name);
  return { live: rows.length, lines, blocked, finished: finishedNames, stopNew, state, toNotify, working };
}

// The lines of this run reached the lead (a prompt, a session start or a blocking Stop): GONE and CLOSE? are not repeated.
function markShown(state) {
  delete state.gone;
  delete state.closing;
}

// Records in the state that these (name, flag) pairs have blocked Stop.
function markStopped(state, stopNew) {
  for (const { key, flag } of stopNew) {
    const w = state.workers[key];
    if (w && !w.sb.includes(flag)) w.sb.push(flag);
  }
}

// --- handoff in progress ---------------------------------------------------------------------------------------------
const CANDIDATE_WINDOW_MS = 2 * 3600 * 1000;
const plain = (text) => text.replace(/^﻿/, '').replace(/[*`]/g, '');

// Is this session a candidate lead that has not been activated yet? The candidate starts from a HANDOFF.md written by the old lead
// (skills/handoff/SKILL.md): its header names an old_session_id that is not this session, and the candidate must not change
// anything, STATE.md included, before ACTIVATE. After ACTIVATE the new lead rewrites STATE.md, whose first lines carry
// `Session: <session_id>` (templates/STATE.md). So: HANDOFF.md written within 2 hours with another old_session_id, and the `Session:`
// of STATE.md is not this session (a missing STATE.md or an unreadable file is "no"). Fail-open: false.
function candidateBeforeActivation(handoffPath, statePath, session, now = Date.now()) {
  try {
    const st = fs.statSync(handoffPath);
    if (now - st.mtimeMs > CANDIDATE_WINDOW_MS) return false;
    const head = plain(fs.readFileSync(handoffPath, 'utf8')).split(/\r?\n/).slice(0, 30).join('\n');
    const old = /(^|\s)old_session_id:\s*(\S+)/i.exec(head);
    if (!old || old[2].replace(/[,;.]+$/, '') === String(session)) return false;
    const stateHead = plain(fs.readFileSync(statePath, 'utf8')).split(/\r?\n/).slice(0, 10).join('\n');
    const me = /(^|\s)Session:\s*(\S+)/i.exec(stateHead);
    return !me || me[2].replace(/[,;.]+$/, '') !== String(session);
  } catch {
    return false;
  }
}

// herdr notification: GHORC_TABS_NOTIFY_LOG=<file> appends the argv (program included) as one JSON line instead of running it.
function notify(name, env = process.env) {
  const argv = [...backend.herdrSpec(env), 'notification', 'show', `ghorc: ${name} waits`, '--body', `${name} is blocked on a dialog: read its screen and tell the owner`, '--sound', 'request'];
  try {
    if (env.GHORC_TABS_NOTIFY_LOG) {
      fs.appendFileSync(env.GHORC_TABS_NOTIFY_LOG, `${JSON.stringify(argv)}\n`);
      return;
    }
    const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch {
    /* a notification is a courtesy */
  }
}

module.exports = {
  noLiveWait,
  NOWAIT_REPEAT_MS,
  AGENT_KINDS,
  LONG_KINDS,
  MAX_NAME,
  MODELS,
  EFFORTS,
  POLICY_TEXT,
  parseName,
  settings,
  resultLine,
  reportFile,
  parseCommand,
  parseSegment,
  rawSegments,
  sendCommands,
  hcCloseNames,
  recordClose,
  taskNames,
  recordTasks,
  NORESULT_GRACE_MS,
  parseHerdrList,
  parseHcList,
  inside,
  inventory,
  checkCommand,
  devMatch,
  ownWorkspace,
  devReason,
  backendKind,
  readLive,
  evaluate,
  markStopped,
  markShown,
  peelWrappers,
  candidateBeforeActivation,
  readTabState,
  writeTabState,
  stateFile,
  notify,
};
