'use strict';
// Tab policy for the lead: what may be opened (names, role env, model/effort/permission args, limits) and what is reported
// about the worker tabs that are open (blocked, finished but not closed, stalled, overtime, over the limit).
// Used by scripts/tabs-guard.cjs. Pure functions where possible; the only I/O is the list call (hc ls / herdr agent list),
// the report file reads, the state file and the optional notification.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { segments, matches, compile, inlineWrapped, stripHeredocs } = require('./cmd.cjs');
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
const CLAUDE = /^(?:.*[\\/])?claude(?:\.exe|\.cmd)?$/i;
const ENV_BIN = /^(?:.*[\\/])?env(?:\.exe)?$/i;
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

function cliTokens(segment) {
  const w = Array.isArray(segment) ? segment : String(segment).trim().split(/\s+/);
  for (let i = 0; i < w.length; i++) {
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
    if (ENV_BIN.test(t) && envIdx < 0) {
      envIdx = i;
      continue;
    }
    if (envIdx >= 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      assigns.push({ t, i });
      continue;
    }
    break;
  }
  if (opts.some(isHelp)) return null;
  const prog = i < tokens.length ? tokens[i] : null;
  return { type: 'hc-run', tokens, run, opts, envIdx, assigns, progIdx: i, claude: Boolean(prog && CLAUDE.test(prog)), args: tokens.slice(i + 1) };
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

// Every tab command of a shell command line: [{ type, ... }]. Segments come from cmd.cjs (quotes blanked, wrappers inlined).
function parseCommand(command, powershell) {
  const out = [];
  const seen = new Set();
  for (const seg of segments(readable(command), { powershell })) {
    if (!/\b(?:hc|herdr)(?:\.exe)?\b/i.test(seg)) continue;
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
// the call operator). -> [[word, ...], ...]
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
      endSeg();
      if ((c === '&' || c === '|') && s[i + 1] === c) i++;
      continue;
    }
    if (c === '#' && cur === null) {
      // a comment runs to the end of the line (its quotes are not quotes)
      while (i + 1 < s.length && s.charCodeAt(i + 1) !== 10 && s.charCodeAt(i + 1) !== 13) i++;
      continue;
    }
    if (cur === null) cur = '';
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

// Wrappers in front of a decoded command that cliTokens does not know: timeout, nice, stdbuf, setsid, and env, command and
// exec with their options (env -u NAME, exec -a NAME). -> the words from the program on.
const WRAP_VALUE = { timeout: ['-s', '--signal', '-k', '--kill-after'], nice: ['-n', '--adjustment'], stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'], setsid: [], env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], command: [], exec: ['-a'] };
function peelWrappers(words) {
  let i = 0;
  for (let guard = 0; guard < 16 && i < words.length; guard++) {
    const w = String(words[i]).toLowerCase().replace(/\.exe$/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      i++;
      continue;
    }
    if (!(w in WRAP_VALUE)) break;
    i++;
    while (i < words.length && /^-/.test(words[i]) && words[i] !== '--') i += WRAP_VALUE[w].includes(words[i]) ? 2 : 1;
    if (words[i] === '--') i++;
    if (w === 'timeout' && i < words.length && /^\d/.test(words[i])) i++; // the duration
  }
  return words.slice(i);
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

// The --cwd values of every herdr tab create, from one quote-aware tokenizer (rawSegments, for bash or PowerShell) run on the
// text cmd.cjs cuts too (heredocs stripped, bash -c "..." and similar wrappers inlined, $(pwd) and ${PWD} read as $PWD).
// Each tab create keeps its own values (--cwd v and --cwd=v, only before a `--`; null for a --cwd without a value).
// -> { creates: [[value, ...], ...], unreadable } ; unreadable: a quote is not closed in a line that holds "tab create".
function tabCreateCwds(command, powershell) {
  const text = inlineWrapped(stripHeredocs(String(command)).replace(/\$\(pwd\)|\$\{PWD\}/g, '$$PWD'), powershell);
  const segs = rawSegments(text, powershell);
  const creates = [];
  for (const words of segs) {
    const c = cliTokens(words) || cliTokens(peelWrappers(words));
    if (!c || c.prog !== 'herdr') continue;
    const t = c.tokens;
    const dd = t.indexOf('--');
    const end = dd < 0 ? t.length : dd;
    const low = t.map((x) => String(x).toLowerCase());
    const at = low.findIndex((x, i) => i < end - 1 && x === 'tab' && low[i + 1] === 'create');
    if (at < 0 || t.slice(at + 2, end).some((x) => x === '--help' || x === '-h')) continue; // --help creates nothing
    const vals = [];
    for (let i = at + 2; i < end; i++) {
      if (t[i] === '--cwd') vals.push(i + 1 < end ? t[++i] : null);
      else if (t[i].startsWith('--cwd=')) vals.push(t[i].slice(6));
    }
    creates.push(vals);
  }
  return { creates, unreadable: Boolean(segs.unclosed) && /\btab\s+create\b/i.test(text) };
}

// The --cwd lines of a command: every value of every tab create judged by cwdProblem; a tab create without --cwd is reported
// unless the cmd.cjs check already did; an unreadable line is denied.
function cwdLines(command, ctx, missingShown) {
  const out = [];
  const add = (x) => {
    if (x && !out.includes(x)) out.push(x);
  };
  const ask = 'pass a plain absolute or relative path inside the project, or $PWD (a worktree under .claude/worktrees counts)';
  const r = tabCreateCwds(command, ctx.powershell);
  if (r.unreadable) add(`the command has a quote that is not closed, so the guard cannot read the --cwd of its tab create: ${ask}`);
  for (const vals of r.creates) {
    if (!vals.length && !missingShown) add(`--cwd is missing: without it the tab starts in the herdr server's directory, outside the project; ${ask}`);
    for (const v of vals) add(v === null ? `--cwd has no value: ${ask}` : cwdProblem(v, ctx));
  }
  return out;
}
const PWD_REF = /^(?:\$PWD|\$\{PWD\}|\$\(pwd\)|\$env:PWD)(?=$|[\\/])/i;
// -> a deny line for a --cwd value, or '' when it is inside the project
function cwdProblem(val, ctx) {
  const ask = 'pass a plain absolute or relative path inside the project, or $PWD (a worktree under .claude/worktrees counts)';
  if (val === null || val === '') return `--cwd ${val === null ? '(unreadable)' : '""'} cannot be read by the guard: ${ask}`;
  let rel = val;
  let base = /^(?:[A-Za-z]:)?[\\/]/.test(val) ? '' : ctx.cwd || ctx.root;
  const m = PWD_REF.exec(val);
  if (m) {
    rel = val.slice(m[0].length).replace(/^[\\/]+/, '') || '.';
    base = ctx.cwd || ctx.root;
    if (rel.split(/[\\/]/).includes('..')) return `--cwd ${val} leaves the session's directory with "..": ${ask}`;
  }
  if (/^~/.test(rel) || /[$%<>{}`()*?|;&]/.test(rel)) return `--cwd ${val} is a variable, an expansion or ~, so the guard cannot tell where it points: ${ask}`;
  const abs = base ? path.resolve(base, rel) : rel;
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
    // the value is judged in cwdLines (checkCommand), on the decoded words of each tab create
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
    if (!p.claude && known && parsed.kind !== 'runner' && ctx.devRe.length && p.progIdx < p.tokens.length) {
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
    if (v.length) {
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

// -> reason string, or null when the command is fine. Never throws (a parse problem is "fine").
// workspace: the own herdr workspace id, or a function that returns it (asked once, only when a herdr command is judged).
function checkCommand(command, { powershell = false, s, list, root, cwd, self, session, workspace = '', envWorkspace = '' }) {
  try {
    if (!/\b(?:hc|herdr)(?:\.exe)?\b/i.test(command)) return null;
    const cmds = parseCommand(command, powershell);
    let sends = [];
    try {
      sends = sendCommands(command, powershell);
    } catch {
      /* a parse problem is "fine" */
    }
    if (!cmds.length && !sends.length && !/\btab\b/i.test(command)) return null;
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
    // the --cwd values: one decoder for the whole line (allowed: a plain path inside the project, ., $PWD forms; see cwdProblem)
    if (root && /\btab\b/i.test(command)) {
      let v;
      try {
        v = cwdLines(command, ctx, lines.some((l) => l.startsWith('- --cwd is missing')));
      } catch {
        v = [];
      }
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
    return null;
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

// The terminal backend of this session, 'hc' | 'herdr' | 'none' (the test seams count as a backend); asked only after a match.
function backendKind(env = process.env, cwd, session) {
  try {
    if (env.GHORC_CAPACITY_HC_JSON !== undefined) return 'hc';
    if (env.GHORC_CAPACITY_HERDR_JSON !== undefined) return 'herdr';
    return backend.detect({ env, cwd, timeoutMs: 2500, session, verdictOnly: true }).backend;
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
    const d = backend.detect({ env, cwd, prefer, timeoutMs: 2500, session });
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
// Does not touch the disk except for the report files; the caller saves state. A result line counts only when the report is not
// older than the first sighting of the tab (a name is reused across fix rounds, so an old report is normal). stopNew: the
// BLOCKED / FINISHED flags that have not yet blocked Stop (state `sb`); the caller records them with markStopped when it blocks.
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
  for (const e of inv) {
    const key = e.name.toLowerCase();
    const prev = prevState.workers[key];
    const isNew = !(prev && typeof prev === 'object' && typeof prev.firstSeen === 'number');
    const w = isNew ? { firstSeen: now, status: e.status, statusSince: now, notified: false } : { ...prev };
    const res0 = isNew ? resultLine(root, key) : null;
    if (isNew && res0 && e.status !== 'working' && e.status !== 'blocked') w.rq = true; // first seen with a result line: quiet until its status changes
    if (w.status !== e.status) {
      w.status = e.status;
      w.statusSince = now;
      delete w.rq;
    }
    if (e.status !== 'blocked') w.notified = false;
    else if (!w.notified) {
      toNotify.push(e.name);
      w.notified = true;
    }
    const long = e.parsed.long;
    const res = resultLine(root, key);
    const fresh = res && res.mtimeMs >= w.firstSeen ? res : null;
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
    if (isNew && res && e.status !== 'working' && e.status !== 'blocked') {
      const d = new Date(res.mtimeMs);
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      flags.push(['RESULT?', `${e.name} has a result line from ${hhmm}: if it is the current round, accept it and close the tab`]);
    }
    // a status that is none of the four herdr and hc are known to report is shown, so a renamed status cannot hide a dialog
    if (!KNOWN_STATUS.has(e.status)) flags.push(['UNKNOWN', `${e.name} reports status ${JSON.stringify(e.status)}: read its screen`]);
    // a tab that has a result line (old or fresh) is never "stalled without a result line"
    if (!long && !res && idleMin >= s.idleMin) flags.push(['STALLED', `${e.name} has been idle ${idleMin}m without a result line. Read its screen (${readCmd(live, e)}) and decide.`]);
    if (!long && !finished && !w.rq && runMin >= s.overtimeMin) flags.push(['OVERTIME', `${e.name} runs ${runMin}m (tabs.overtimeMin ${s.overtimeMin}). Read its screen (${readCmd(live, e)}) and decide.`]);
    const names = flags.map((f) => f[0]);
    w.sb = (Array.isArray(w.sb) ? w.sb : []).filter((f) => names.includes(f)); // a flag that went away may block Stop again later
    for (const f of ['BLOCKED', 'FINISHED']) if (names.includes(f) && !w.sb.includes(f)) stopNew.push({ key, flag: f });
    state.workers[key] = w;
    rows.push({ e, runMin, flags, long });
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
    if (res && res.mtimeMs >= w.firstSeen) continue;
    state.gone = { ...(state.gone || {}), [key]: w };
    lines.push(`tabs GONE: ${key} left ${live.kind === 'hc' ? 'hc ls' : 'herdr agent list'} without a result line: its tab was closed or its session ended. Read its report file (.claude/ghorc-out/${key}.md) if there is one, then re-brief or drop the package.`);
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
