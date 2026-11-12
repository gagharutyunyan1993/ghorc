'use strict';
// The terminal backend: which tool opens tabs and runs agents in this session. Two exist and both may be installed:
//   hc    herdr-app / herdr-core. Active when HC_TERMINAL_ID is set (hc gives every terminal its address in it).
//   herdr the older `herdr` CLI. Active when HERDR_ENV=1 and its server answers `herdr agent list`.
//   none  neither: no tab commands may be run (the skills fall back to the Agent tool and /clear).
// One module decides, so hooks, scripts and skills never assume a single backend. When both are present the answer is
// the backend of `backend.prefer` (hc by default); the config is read only then, and only if the caller did not pass
// `prefer`. Nothing else here reads a project file.
const { execFileSync } = require('node:child_process');

// GHORC_TOOL_TIMEOUT_MS: for tests on a loaded machine (a fake program started twice can exceed 3 s)
const timeoutMs = () => Number(process.env.GHORC_TOOL_TIMEOUT_MS) || 3000;
const LIVE_WORKER = new Set(['working', 'blocked']);

// A program to run. An env override (tests, or a program outside PATH) is one path or a JSON array [program, ...args].
function binSpec(envName, name, env = process.env) {
  const v = env[envName];
  if (v === undefined || String(v).trim() === '') return [name];
  const s = String(v).trim();
  if (s[0] === '[') {
    try {
      const a = JSON.parse(s);
      if (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string')) return a;
    } catch {
      /* falls through to a plain path */
    }
  }
  return [s];
}
const hcSpec = (env) => binSpec('GHORC_HC_BIN', 'hc', env);
const herdrSpec = (env) => binSpec('GHORC_HERDR_BIN', 'herdr', env);

// Runs a program and returns { stdout, stderr, status } even for a non-zero exit; { missing: true } when it is not
// installed. stderr is piped (never inherited) so a message of the tool cannot reach the hook output. Other failures
// (timeout, a signal) throw.
function runTool(spec, args, run = execFileSync, timeout = timeoutMs()) {
  try {
    const stdout = run(spec[0], [...spec.slice(1), ...args], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: String(stdout), stderr: '', status: 0 };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { missing: true, stdout: '', stderr: '', status: null };
    if (e && typeof e.status === 'number') return { stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), status: e.status };
    throw e;
  }
}

const SERVER_DOWN = /"server_not_running"/;

// backend.prefer of the project config ('hc' | 'herdr'); 'hc' when the config cannot be read or has another value.
function configuredPrefer(cwd) {
  try {
    const v = ((require('./config.cjs').load(cwd) || {}).backend || {}).prefer;
    return v === 'herdr' ? 'herdr' : 'hc';
  } catch {
    return 'hc';
  }
}

// { backend: 'hc' | 'herdr' | 'none', reason, terminal?, raw?, failed? }
//   hc: terminal is HC_TERMINAL_ID.
//   herdr: raw is the stdout of `herdr agent list` (the probe itself, so the caller need not ask twice).
//   none: reason says why; failed is true when herdr was expected (HERDR_ENV=1) but the probe failed in an unknown way
//         (timeout, odd exit): a caller that counts things treats that as "unknown", not as "zero".
// Both present (HC_TERMINAL_ID set and HERDR_ENV=1): opts.prefer ('hc' | 'herdr'; else backend.prefer of the project config
// found from opts.cwd) decides; with 'herdr' the server must answer, otherwise hc stays. One present: that one, always.
// opts.timeoutMs bounds the herdr probe (default: GHORC_TOOL_TIMEOUT_MS or 3 s).
function detect(opts = {}) {
  const env = opts.env || process.env;
  const run = opts.exec || execFileSync;
  const hcId = String(env.HC_TERMINAL_ID || '').trim();
  const herdrEnv = String(env.HERDR_ENV || '').trim() === '1';
  const hc = hcId ? { backend: 'hc', reason: `HC_TERMINAL_ID=${hcId}`, terminal: hcId } : null;
  if (hc && !herdrEnv) return hc;
  if (!herdrEnv) return { backend: 'none', reason: 'neither HC_TERMINAL_ID nor HERDR_ENV=1 is set' };
  if (hc) {
    const prefer = opts.prefer === 'herdr' || opts.prefer === 'hc' ? opts.prefer : configuredPrefer(opts.cwd || process.cwd());
    if (prefer !== 'herdr') return hc;
  }
  try {
    const r = runTool(herdrSpec(env), ['agent', 'list'], run, opts.timeoutMs || timeoutMs());
    if (r.missing) return hc || { backend: 'none', reason: 'HERDR_ENV=1 but herdr is not installed' };
    const body = `${r.stdout}
${r.stderr}`;
    if (SERVER_DOWN.test(body)) return hc || { backend: 'none', reason: 'HERDR_ENV=1 but the herdr server is not running (server_not_running)' };
    if (r.status !== 0) return hc || { backend: 'none', reason: `herdr agent list exited with ${r.status}`, failed: true };
    return { backend: 'herdr', reason: 'HERDR_ENV=1 and the herdr server answers', raw: r.stdout };
  } catch (e) {
    return hc || { backend: 'none', reason: `herdr agent list: ${e && e.message ? e.message : e}`, failed: true };
  }
}

// --- workers --------------------------------------------------------------------------------------------------------
// hc: `hc ls` (JSON when piped) lists { terminals: [{ address, name?, parent?, state, status?, ... }] }. A worker is a live
// terminal that reports working or blocked, has a parent (a top-level terminal is a session the owner started: a lead),
// has a name not starting with the lead prefix and is not this terminal. null when the text is not that JSON.
function workersFromHc(text, self, leadPrefix = 'lead-') {
  let list;
  try {
    list = JSON.parse(text).terminals;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const prefix = String(leadPrefix || '').toLowerCase();
  const me = String(self || '').trim();
  return list.filter((t) => {
    if (!t || typeof t !== 'object') return false;
    if (String(t.state == null ? '' : t.state).toLowerCase() !== 'live') return false;
    if (!LIVE_WORKER.has(String(t.status == null ? '' : t.status).toLowerCase())) return false;
    if (!t.parent) return false;
    if (prefix && String(t.name == null ? '' : t.name).toLowerCase().startsWith(prefix)) return false;
    return !(me && t.address === me);
  }).length;
}

// Output of `hc ls`; null when hc is not installed. Other failures throw.
function hcText(env = process.env, run = execFileSync) {
  const fake = env.GHORC_CAPACITY_HC_JSON;
  if (fake !== undefined) return fake;
  const r = runTool(hcSpec(env), ['ls', '--json'], run);
  if (r.missing) return null;
  if (r.status !== 0) throw new Error(`hc ls exited with ${r.status}: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

// The parent terminal of this terminal (`hc get <own id>`), or null when unknown: the one terminal a worker may `hc send`.
function hcParent(env = process.env, run = execFileSync) {
  const id = String(env.HC_TERMINAL_ID || '').trim();
  if (!id) return null;
  try {
    const r = runTool(hcSpec(env), ['get', id], run);
    if (r.missing || r.status !== 0) return null;
    const p = JSON.parse(r.stdout).parent;
    return typeof p === 'string' && p ? p : null;
  } catch {
    return null;
  }
}

// Live lead terminals from the text of `hc ls --json`: a live claude-code terminal with no parent (a session the owner started) or with a
// name starting with the lead prefix. After a lead handover the workers of the old lead report to the new one, which is not
// their parent. null when the text is not that JSON.
//
// roots (optional): project directories. A lead then counts only when its cwd is one of them or inside one (a worktree under
// <root>/.claude/worktrees counts as <root>): the lead of another project is not a channel for a worker's text.
function projectKey(dir) {
  return String(dir || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\/\.claude\/worktrees\/.*$/i, '')
    .toLowerCase();
}
function inProject(cwd, roots) {
  const c = projectKey(cwd);
  return Boolean(c) && roots.some((r) => {
    const k = projectKey(r);
    return Boolean(k) && (c === k || c.startsWith(`${k}/`));
  });
}
function leadsFromHc(text, leadPrefix = 'lead-', roots = null) {
  let list;
  try {
    list = JSON.parse(text).terminals;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const prefix = String(leadPrefix || '').toLowerCase();
  return list
    .filter((t) => {
      if (!t || typeof t !== 'object' || typeof t.address !== 'string' || !t.address) return false;
      if (t.agent !== 'claude-code') return false; // a shell (cmd.exe, pwsh) is no lead: text sent there would be run
      if (String(t.state == null ? '' : t.state).toLowerCase() !== 'live') return false;
      if (roots && !inProject(t.cwd, roots)) return false;
      if (!t.parent) return true;
      return Boolean(prefix) && String(t.name == null ? '' : t.name).toLowerCase().startsWith(prefix);
    })
    .map((t) => t.address);
}

// The terminals a worker may `hc send` to: its parent (`hc get`) and the live leads (`hc ls`). Empty when this terminal is
// not an hc terminal or neither can be read.
// projectDirs: the directories of this project (the hook passes its project root); the cwd of the parent terminal is added.
function hcSendTargets(env = process.env, run = execFileSync, projectDirs = null) {
  if (!String(env.HC_TERMINAL_ID || '').trim()) return [];
  const out = [];
  const parent = hcParent(env, run);
  if (parent) out.push(parent);
  try {
    const text = hcText(env, run);
    let roots = null;
    if (projectDirs) {
      roots = [...projectDirs];
      try {
        const p = JSON.parse(text).terminals.find((t) => t && t.address === parent);
        if (p && p.cwd) roots.push(p.cwd);
      } catch {
        /* no parent entry: the project dirs alone */
      }
    }
    for (const a of (text && leadsFromHc(text, 'lead-', roots)) || []) if (!out.includes(a)) out.push(a);
  } catch {
    /* hc ls failed: the parent alone is what is known */
  }
  return out;
}


// --- is this terminal a lead? -------------------------------------------------------------------------------------------
// Only a positive answer counts; anything else (no backend, tool missing, a timeout, an odd answer) is "not proven".
const LOOKUP_MS = 1500; // a hook has 5 s: the lookup may not eat them
const lookupMs = (env) => Number(env.GHORC_TOOL_TIMEOUT_MS) || LOOKUP_MS;

// hc: the answer of `hc get <own id>` is an object; the terminal is a lead when its name starts with the lead prefix or
// it has no parent (the owner started it). The object must look like a terminal (an address, name, state or agent field)
// and, if it has an address, that is this terminal: an answer in another shape is not read as "no parent".
function hcIsLead(env, run, leadPrefix, ms) {
  const id = String(env.HC_TERMINAL_ID || '').trim();
  if (!id) return false;
  const r = runTool(hcSpec(env), ['get', id], run, ms);
  if (r.missing || r.status !== 0) return false;
  const t = JSON.parse(r.stdout);
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (!['address', 'name', 'state', 'agent'].some((k) => k in t)) return false;
  if ('address' in t && t.address !== id) return false;
  const prefix = String(leadPrefix == null ? 'lead-' : leadPrefix).toLowerCase();
  if (prefix && String(t.name == null ? '' : t.name).toLowerCase().startsWith(prefix)) return true;
  return !t.parent;
}

// herdr: the agent of this session in the text of `herdr agent list` has a name (the tab label) that starts with the lead
// prefix without its trailing dash (`lead-` -> `lead`).
function herdrIsLead(raw, session, leadPrefix) {
  const prefix = String(leadPrefix == null ? 'lead-' : leadPrefix).toLowerCase().replace(/-+$/, '');
  if (!prefix || !session) return false;
  const list = JSON.parse(raw).result.agents;
  return (
    Array.isArray(list) &&
    list.some((a) => a && typeof a === 'object' && a.agent_session && a.agent_session.value === session && String(a.name == null ? '' : a.name).toLowerCase().startsWith(prefix))
  );
}

// opts: { env, exec, session (herdr), leadPrefix (capacity.leadNamePrefix), prefer, cwd }. Never throws.
function terminalIsLead(opts = {}) {
  try {
    const env = opts.env || process.env;
    const run = opts.exec || execFileSync;
    const ms = lookupMs(env);
    const d = detect({ env, exec: run, prefer: opts.prefer, cwd: opts.cwd, timeoutMs: ms });
    if (d.backend === 'hc') return hcIsLead(env, run, opts.leadPrefix, ms) === true;
    if (d.backend === 'herdr') return herdrIsLead(d.raw, opts.session, opts.leadPrefix) === true;
    return false;
  } catch {
    return false;
  }
}

module.exports = { detect, terminalIsLead, runTool, binSpec, hcSpec, herdrSpec, workersFromHc, leadsFromHc, hcText, hcParent, hcSendTargets, LIVE_WORKER };
