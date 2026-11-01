'use strict';
// Capacity guard logic, shared by scripts/capacity-guard.cjs and the tests: the idle line, the agent count
// (Stop input, ledger, herdr), the CPU and RAM measurements, the weekly cap and the Stop decision.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeId } = require('./ctxguard.cjs');

const LEDGER_STALE_MS = 3 * 3600 * 1000; // a start older than this is an agent killed without SubagentStop
const COMPACT_BYTES = 256 * 1024;
const WEEK_S = 604800;
const MAX_SAMPLE_MS = 500; // one CPU interval; three intervals at most 1.5 s in Stop
const TERMINAL = /^(completed|failed|killed)$/i;
const KNOWN_STATUS = /^(pending|running|paused|completed|failed|killed)$/i;
const LIVE_WORKER = new Set(['working', 'blocked']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, def) => (finite(v) ? v : def);

// The capacity section of the config with defaults applied to bad values (a wrong type never throws).
function settings(cfg) {
  const c = (cfg && cfg.capacity) || {};
  const text = (v, def) => (typeof v === 'string' ? v : def);
  return {
    enabled: c.enabled === true,
    agents: num(c.agents, 3),
    cpuStartPct: num(c.cpuStartPct, 60),
    minFreeRamGb: num(c.minFreeRamGb, 4),
    weeklyCapPct: num(c.weeklyCapPct, 0),
    agentsOverPace: num(c.agentsOverPace, 0),
    idleMarker: text(c.idleMarker, 'Idle:').trim() || 'Idle:',
    leadNamePrefix: text(c.leadNamePrefix, 'lead-'),
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when the text has a line that starts with the marker and carries a real reason: at least 4 letters or digits,
// at least 2 distinct ones, and not the placeholder <reason> of the hint. The line may start with a list marker, a
// number, a quote or markdown emphasis; the marker is matched case-insensitively.
function idleReasonGiven(text, marker = 'Idle:') {
  // allow "Idle :" and "**Idle**:" (emphasis closed before the colon)
  // The prefix classes hold no newline and never overlap (the emphasis after a number is part of the number group), so a
  // failed match backtracks in linear time: 100 KB of blank lines or 50 KB of "*" cost milliseconds.
  const body = escapeRe(String(marker).trim()).replace(/\\?:$/, '[*_`]*[ \\t]*:');
  const lineRe = new RegExp('^[ \\t>*_#`"\'-]*(?:\\d+[.)][ \\t]*[*_`"\']*)?' + body + '[*_`]*[ \\t]*(.*)$', 'gimu');
  for (const m of String(text == null ? '' : text).matchAll(lineRe)) {
    const reason = (m[1] || '').replace(/^["'`\s]+|["'`\s]+$/gu, '');
    if (/<\s*reason\s*>/iu.test(reason)) continue;
    const signs = reason.toLowerCase().match(/[\p{L}\p{N}]/gu) || [];
    if (signs.length >= 4 && new Set(signs).size >= 2) return true;
  }
  return false;
}

// Task types that never carry an agent; every other in-flight type (workflow, cloud session, unknown) may.
const NON_AGENT_TYPE = /^(shell|bash|local_bash|monitor|monitor_mcp)$/i;

// True when the Stop input lists an in-flight task that may carry agents (subagent, teammate, workflow, cloud session,
// any type not known to be agent-free). Only when this is false is it safe to say that the session has no agent left.
function anyAgentTaskInFlight(tasks) {
  if (!Array.isArray(tasks)) return true;
  return tasks.some((t) => t && !NON_AGENT_TYPE.test(String(t.type == null ? '' : t.type)) && !TERMINAL.test(String(t.status == null ? '' : t.status)));
}

// True when an in-flight task other than a subagent or teammate may carry agents (workflow, cloud session, unknown type).
// Such agents are not listed in the Stop input, so the ledger is the only place that knows them.
function otherAgentTaskInFlight(tasks) {
  if (!Array.isArray(tasks)) return false;
  return tasks.some(
    (t) =>
      t &&
      t.type !== 'subagent' &&
      t.type !== 'teammate' &&
      !NON_AGENT_TYPE.test(String(t.type == null ? '' : t.type)) &&
      !TERMINAL.test(String(t.status == null ? '' : t.status)),
  );
}

// Running subagents and teammates from the Stop input; null when the field is absent.
function agentsFromTasks(tasks, log = () => {}) {
  if (!Array.isArray(tasks)) return null;
  for (const t of tasks) {
    if (t && !KNOWN_STATUS.test(String((t && t.status) == null ? '' : t.status))) {
      log(`unknown task status ${JSON.stringify(t.status)} (type ${String(t.type)})`);
    }
  }
  return tasks.filter(
    (t) => t && (t.type === 'subagent' || t.type === 'teammate') && !TERMINAL.test(String(t.status == null ? '' : t.status)),
  ).length;
}

// --- herdr workers ------------------------------------------------------------------------------------------------
// Live workers in the text of `herdr agent list`: status working or blocked, name not starting with the lead prefix,
// session not this one. null when the text is not the expected JSON.
function workersFromHerdr(text, session, leadPrefix = 'lead-') {
  let list;
  try {
    const j = JSON.parse(text);
    if (j && j.error && j.error.code === 'server_not_running') return 0; // no herdr server, so no workers
    list = j && j.result && j.result.agents;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const prefix = String(leadPrefix || '').toLowerCase();
  return list.filter((a) => {
    if (!a || typeof a !== 'object') return false;
    if (!LIVE_WORKER.has(String(a.agent_status == null ? '' : a.agent_status).toLowerCase())) return false;
    if (prefix && String(a.name == null ? '' : a.name).toLowerCase().startsWith(prefix)) return false;
    return !(a.agent_session && a.agent_session.value === session);
  }).length;
}

// Output of `herdr agent list`; null when herdr is not installed. The error JSON of a stopped herdr server (exit 1, code
// server_not_running) is returned as text: that means 0 workers. herdr 0.9.5 prints it on stderr with an empty stdout, so
// stderr is piped (never inherited: it must not reach the hook output) and both streams are read. Other failures throw.
function herdrText(exec = execFileSync) {
  const fake = process.env.GHORC_CAPACITY_HERDR_JSON;
  if (fake !== undefined) return fake;
  try {
    return exec('herdr', ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    for (const stream of [e && e.stdout, e && e.stderr]) {
      if (stream && /"server_not_running"/.test(String(stream))) return String(stream);
    }
    throw e;
  }
}

// Live herdr workers: 0 when herdr is not installed, null (unknown, the cause is logged) on any other failure.
function herdrWorkers(session, leadPrefix, log = () => {}, text = herdrText) {
  try {
    const raw = text();
    if (raw === null) return 0;
    const n = workersFromHerdr(raw, session, leadPrefix);
    if (n === null) {
      log('herdr agent list: not the expected JSON');
      return null;
    }
    return n;
  } catch (e) {
    log(`herdr agent list: ${e && e.message ? e.message : e}`);
    return null;
  }
}

// --- measurements -------------------------------------------------------------------------------------------------
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function cpuTimes(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

// Average CPU load, %, over `samples` intervals (3 for Stop, 1 for UserPromptSubmit); null when it cannot be measured.
// GHORC_CAPACITY_CPU_PCT replaces the measurement, GHORC_CAPACITY_SAMPLE_MS sets one interval (default 400 ms, at most
// MAX_SAMPLE_MS, so Stop waits 1.5 s at most). `cpus` and `wait` are injectable for tests.
function measureCpu({ samples = 3, cpus = os.cpus, wait = sleep } = {}) {
  const fake = process.env.GHORC_CAPACITY_CPU_PCT;
  if (fake !== undefined && fake !== '') {
    const v = Number(fake);
    return Number.isFinite(v) ? v : null;
  }
  try {
    if (!cpus().length) return null;
    const gap = Math.min(MAX_SAMPLE_MS, Math.max(0, num(Number(process.env.GHORC_CAPACITY_SAMPLE_MS), 400)));
    let prev = cpuTimes(cpus);
    const loads = [];
    for (let i = 0; i < samples; i++) {
      wait(gap);
      const cur = cpuTimes(cpus);
      const dt = cur.total - prev.total;
      if (dt > 0) loads.push(100 * (1 - (cur.idle - prev.idle) / dt));
      prev = cur;
    }
    return loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : null;
  } catch {
    return null;
  }
}

function measureFreeGb() {
  const fake = process.env.GHORC_CAPACITY_FREE_GB;
  if (fake !== undefined && fake !== '') {
    const v = Number(fake);
    return Number.isFinite(v) ? v : null;
  }
  try {
    const v = os.freemem() / 1073741824;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// --- ledger (SubagentStart / SubagentStop) ------------------------------------------------------------------------
// Append-only event log, one JSON line per event: {e:"start"|"stop"|"clear", s:session, a:agent, ts}. A single small
// appendFileSync is atomic enough, so appends take no lock. Only the compaction of a big file takes a lock file; when it
// is busy the compaction is skipped (the next event tries again).
function foldLedger(lines, now = Date.now()) {
  const live = new Map();
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev.s !== 'string' || !finite(ev.ts)) continue;
    if (ev.e === 'start' && typeof ev.a === 'string') live.set(JSON.stringify([ev.s, ev.a]), { session: ev.s, agent: ev.a, ts: ev.ts });
    else if (ev.e === 'stop' && typeof ev.a === 'string') live.delete(JSON.stringify([ev.s, ev.a]));
    else if (ev.e === 'clear') for (const [k, v] of live) if (v.session === ev.s) live.delete(k);
  }
  return [...live.values()].filter((e) => now - e.ts < LEDGER_STALE_MS);
}

function ledgerLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const readLedger = (file, now = Date.now()) => foldLedger(ledgerLines(file), now);

// Rewrites a big ledger with the live starts only. Appends take no lock, so an event may arrive while the file is being
// rewritten: just before the rename the bytes appended since the read are copied to the new file (the window left is a
// short window; under heavy concurrency, measured at about 25 phantoms in 15000 start/stop pairs from 10 processes, a
// lost stop is a phantom agent that expires after 3 hours). `fsApi` is injectable for tests.
function compactLedger(file, now, log, fsApi = fs) {
  try {
    if (fsApi.statSync(file).size < COMPACT_BYTES) return;
  } catch {
    return;
  }
  const lock = `${file}.lock`;
  let fd;
  try {
    try {
      if (now - fsApi.statSync(lock).mtimeMs > 10000) fsApi.rmSync(lock, { force: true }); // a lock of a dead process
    } catch {
      /* no lock */
    }
    fd = fsApi.openSync(lock, 'wx');
  } catch {
    log('ledger lock busy: compaction skipped');
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const raw = fsApi.readFileSync(file);
    const kept = foldLedger(raw.toString('utf8').split('\n').filter(Boolean), now).map((e) =>
      JSON.stringify({ e: 'start', s: e.session, a: e.agent, ts: e.ts }),
    );
    fsApi.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
    const cur = fsApi.readFileSync(file);
    if (cur.length > raw.length) fsApi.appendFileSync(tmp, cur.subarray(raw.length)); // events that arrived meanwhile
    fsApi.renameSync(tmp, file);
  } catch (e) {
    log(`ledger compaction: ${e && e.message ? e.message : e}`);
    try {
      fsApi.rmSync(tmp, { force: true }); // never leave the temp file behind
    } catch {
      /* ignore */
    }
  } finally {
    try {
      fsApi.closeSync(fd);
      fsApi.rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function appendEvent(file, ev, log = () => {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(ev) + '\n');
  compactLedger(file, Date.now(), log);
}

// --- weekly cap (the ctx file of the status line) -----------------------------------------------------------------
// seven_day from one ctx file: { used, resetsAt (seconds | null), ts (ms) } or null when it has no usable value.
function readSevenDay(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sd = j && j.rate_limits && j.rate_limits.seven_day;
    if (!sd || !finite(sd.used_percentage)) return null;
    return { used: sd.used_percentage, resetsAt: finite(sd.resets_at) && sd.resets_at > 0 ? sd.resets_at : null, ts: finite(j.ts) ? j.ts : 0 };
  } catch {
    return null;
  }
}

// The raw weekly value for a session: its own ctx file while it is fresh (resets_at known and in the future), else the
// best of the other ctx files (the limit belongs to the account; a new session has no rate_limits yet) with other: true.
// A fresh candidate beats a stale one, then the newest ts, then the larger used (the brake only gets stricter).
// null: nothing found.
function readWeekRaw(dir, session, nowMs = Date.now()) {
  const nowS = Math.floor(nowMs / 1000);
  const isStale = (v) => v.resetsAt === null || v.resetsAt <= nowS;
  const ownName = `ctx-${safeId(session)}.json`;
  const own = readSevenDay(path.join(dir, ownName));
  if (own && !isStale(own)) return { ...own, other: false };
  const better = (v, best) =>
    !best || isStale(best) > isStale(v) || (isStale(best) === isStale(v) && (v.ts > best.ts || (v.ts === best.ts && v.used > best.used)));
  let best = own ? { ...own, other: false } : null;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^ctx-.*\.json$/.test(n) && n !== ownName)
      .map((n) => ({ f: path.join(dir, n), at: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((x, y) => y.at - x.at)
      .slice(0, 10);
    for (const { f } of files) {
      const v = readSevenDay(f);
      if (v && better(v, best)) best = { ...v, other: true };
    }
  } catch {
    /* the own value (if any) stays */
  }
  return best;
}

// Week state from a raw value. nowMs is milliseconds, resets_at is seconds: both are in seconds here.
// f = clamp((now_s - (resets_at - 604800)) / 604800, 0, 1); resets_at missing: f = 1 (only the cap applies), stale.
function weekState(raw, s, nowMs = Date.now()) {
  if (!raw || !finite(raw.used)) return null;
  const nowS = Math.floor(nowMs / 1000);
  const resetsAt = finite(raw.resetsAt) ? raw.resetsAt : null;
  const f = resetsAt === null ? 1 : Math.min(1, Math.max(0, (nowS - (resetsAt - WEEK_S)) / WEEK_S));
  const plan = s.weeklyCapPct * f;
  return {
    used: raw.used,
    plan,
    f,
    capped: raw.used >= s.weeklyCapPct,
    overPace: s.agentsOverPace > 0 && raw.used > plan,
    stale: Boolean(raw.other) || resetsAt === null || resetsAt <= nowS,
  };
}

const pct = (v) => String(Math.round(v * 10) / 10);

// One sentence about the week for the hint or the prompt line; null when the plain rules apply.
function weekNote(w, s) {
  if (!w) return null;
  const stale = w.stale ? ' (stale)' : '';
  if (w.capped) return `WEEKLY CAP: no new agents (used ${pct(w.used)}% >= ${pct(s.weeklyCapPct)}%)${stale}; only merge what is ready.`;
  if (w.overPace) {
    return `Weekly pace: used ${pct(w.used)}% > plan ${pct(w.plan)}% (cap ${pct(s.weeklyCapPct)}%)${stale}; at most ${s.agentsOverPace} agents.`;
  }
  return null;
}

// --- decision -----------------------------------------------------------------------------------------------------
const fmt = (v) => (v === null ? '?' : String(Math.round(v)));

// Stop decision. ctx: { agents, workers, cpu(), freeGb(), week }. Returns the block reason, or null to let the turn end.
// cpu and freeGb are functions so the slow CPU sampling happens only when every cheaper gate has passed.
function stopDecision(input, s, ctx) {
  if (!input || typeof input !== 'object') return null;
  if (input.stop_hook_active || input.agent_id) return null;
  // no text to judge (an answer without text blocks, or an older CLI without the field): fail open
  if (typeof input.last_assistant_message !== 'string') return null;
  if (idleReasonGiven(input.last_assistant_message, s.idleMarker)) return null;
  const { agents, workers, week } = ctx;
  if (agents === null) return null; // unknown: do not interfere
  if (week && week.capped) return null;
  const cap = week && week.overPace ? Math.min(s.agents, s.agentsOverPace) : s.agents;
  if (agents >= cap) return null;
  const freeGb = ctx.freeGb();
  if (freeGb === null || freeGb < s.minFreeRamGb) return null;
  const cpu = ctx.cpu();
  if (cpu === null || cpu >= s.cpuStartPct) return null;
  const wn = workers ? ` (herdr workers ${workers})` : '';
  const note = weekNote(week, s);
  return (
    `Machine underloaded: agents ${agents}${wn} of ${cap}, CPU ${fmt(cpu)}%, free ${freeGb.toFixed(1)} GB. ` +
    (note ? `${note} ` : '') +
    `Start work that can move in parallel, or write a line "${s.idleMarker} <reason>" in your answer.`
  );
}

// The UserPromptSubmit line. week: undefined - weekly rule off; null - no data (said aloud); object - state.
function promptLine(s, ctx) {
  const { agents, workers, cpu, freeGb, week } = ctx;
  let note = '';
  if (week === null) note = ' Week: no rate_limits in any ctx file, the weekly brake is off.';
  else if (week) note = weekNote(week, s) ? ` ${weekNote(week, s)}` : '';
  const wn = workers ? ` (herdr workers ${workers})` : '';
  return `agents ${agents === null ? '?' : agents}${wn}/${s.agents}, CPU ${fmt(cpu)}%, free ${freeGb === null ? '?' : freeGb.toFixed(1)} GB.${note}`;
}

module.exports = {
  LEDGER_STALE_MS,
  MAX_SAMPLE_MS,
  WEEK_S,
  settings,
  idleReasonGiven,
  agentsFromTasks,
  anyAgentTaskInFlight,
  otherAgentTaskInFlight,
  workersFromHerdr,
  herdrText,
  herdrWorkers,
  measureCpu,
  measureFreeGb,
  foldLedger,
  readLedger,
  compactLedger,
  appendEvent,
  readSevenDay,
  readWeekRaw,
  weekState,
  weekNote,
  stopDecision,
  promptLine,
};
