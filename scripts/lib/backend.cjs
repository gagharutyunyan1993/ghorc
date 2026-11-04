'use strict';
// The terminal backend: which tool opens tabs and runs agents in this session. Two exist and both may be installed:
//   hc    herdr-app / herdr-core. Active when HC_TERMINAL_ID is set (hc gives every terminal its address in it).
//   herdr the older `herdr` CLI. Active when HERDR_ENV=1 and its server answers `herdr agent list`.
//   none  neither: no tab commands may be run (the skills fall back to the Agent tool and /clear).
// One module decides, so hooks, scripts and skills never assume a single backend. Nothing here reads a project file.
const { execFileSync } = require('node:child_process');

const TIMEOUT_MS = 3000;
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
function runTool(spec, args, run = execFileSync) {
  try {
    const stdout = run(spec[0], [...spec.slice(1), ...args], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
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

// { backend: 'hc' | 'herdr' | 'none', reason, terminal?, raw?, failed? }
//   hc: terminal is HC_TERMINAL_ID.
//   herdr: raw is the stdout of `herdr agent list` (the probe itself, so the caller need not ask twice).
//   none: reason says why; failed is true when herdr was expected (HERDR_ENV=1) but the probe failed in an unknown way
//         (timeout, odd exit): a caller that counts things treats that as "unknown", not as "zero".
function detect(opts = {}) {
  const env = opts.env || process.env;
  const run = opts.exec || execFileSync;
  const hcId = String(env.HC_TERMINAL_ID || '').trim();
  if (hcId) return { backend: 'hc', reason: `HC_TERMINAL_ID=${hcId}`, terminal: hcId };
  if (String(env.HERDR_ENV || '').trim() !== '1') return { backend: 'none', reason: 'neither HC_TERMINAL_ID nor HERDR_ENV=1 is set' };
  try {
    const r = runTool(herdrSpec(env), ['agent', 'list'], run);
    if (r.missing) return { backend: 'none', reason: 'HERDR_ENV=1 but herdr is not installed' };
    const body = `${r.stdout}\n${r.stderr}`;
    if (SERVER_DOWN.test(body)) return { backend: 'none', reason: 'HERDR_ENV=1 but the herdr server is not running (server_not_running)' };
    if (r.status !== 0) return { backend: 'none', reason: `herdr agent list exited with ${r.status}`, failed: true };
    return { backend: 'herdr', reason: 'HERDR_ENV=1 and the herdr server answers', raw: r.stdout };
  } catch (e) {
    return { backend: 'none', reason: `herdr agent list: ${e && e.message ? e.message : e}`, failed: true };
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

// Live lead terminals from the text of `hc ls --json`: a live terminal with no parent (a session the owner started) or with a
// name starting with the lead prefix. After a lead handover the workers of the old lead report to the new one, which is not
// their parent. null when the text is not that JSON.
function leadsFromHc(text, leadPrefix = 'lead-') {
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
      if (String(t.state == null ? '' : t.state).toLowerCase() !== 'live') return false;
      if (!t.parent) return true;
      return Boolean(prefix) && String(t.name == null ? '' : t.name).toLowerCase().startsWith(prefix);
    })
    .map((t) => t.address);
}

// The terminals a worker may `hc send` to: its parent (`hc get`) and the live leads (`hc ls`). Empty when this terminal is
// not an hc terminal or neither can be read.
function hcSendTargets(env = process.env, run = execFileSync) {
  if (!String(env.HC_TERMINAL_ID || '').trim()) return [];
  const out = [];
  const parent = hcParent(env, run);
  if (parent) out.push(parent);
  try {
    const text = hcText(env, run);
    for (const a of (text && leadsFromHc(text)) || []) if (!out.includes(a)) out.push(a);
  } catch {
    /* hc ls failed: the parent alone is what is known */
  }
  return out;
}

module.exports = { detect, runTool, binSpec, hcSpec, herdrSpec, workersFromHc, leadsFromHc, hcText, hcParent, hcSendTargets, LIVE_WORKER };
