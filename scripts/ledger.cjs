'use strict';
// Call ledger: <project>/.claude/ghorc-out/ledger.jsonl, one JSON line per event.
// `hook`    PostToolUse(Agent): a synchronous call appends a call line with totals; a background call (async_launched)
//           appends a launch line. Never the prompt or the response text; fails silent, exit 0.
// `stop`    SubagentStop: totals from the agent transcript become a done line (matched to the launch by agentId),
//           with an estimated cost at list prices (lib/prices.cjs).
// `verdict` <pkg> <round> <ACCEPT|CHANGES_REQUIRED> [cause] [--class critical|ordinary]: appends a verdict line.
// `end`     SessionEnd: a totals snapshot of a main session transcript (a session line comes from session-start.cjs).
// `report`  [--since <ISO>] [--json]: per role x model x effort, per-class and per-package aggregates; main sessions
//           (the lead, tab workers) priced from their transcripts.
const fs = require('node:fs');
const path = require('node:path');
const { readStdin, parseInput } = require('./lib/hook-io.cjs');
const { projectRoot } = require('./lib/root.cjs');
const { optedIn, load } = require('./lib/config.cjs');
const { PRICES_AS_OF, messageCost } = require('./lib/prices.cjs');

const CAUSES = ['BRIEF_OMISSION', 'SKIPPED_CHECK', 'REASONING_FAILURE', 'OTHER', 'CASCADE'];
const VERDICTS = ['ACCEPT', 'CHANGES_REQUIRED'];
const CLASSES = ['critical', 'ordinary'];
const USAGE =
  'usage: ledger.cjs hook | stop | end | verdict <pkg> <round 1-9> ACCEPT [--class critical|ordinary] | ' +
  'verdict <pkg> <round 1-9> CHANGES_REQUIRED <' +
  CAUSES.join('|') +
  '> [--class critical|ordinary] | report [--since <ISO>] [--json]';

const ledgerPath = (cwd) => path.join(projectRoot(cwd), '.claude', 'ghorc-out', 'ledger.jsonl');

// Writes only inside an existing project directory (never creates the project dir itself). Returns false when skipped.
function append(file, obj) {
  const projectDir = path.dirname(path.dirname(path.dirname(file)));
  if (!fs.existsSync(projectDir)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  return true;
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function hookLine(input) {
  const ti = obj(input.tool_input) || {};
  const tr = obj(input.tool_response) || {};
  const head = {
    ts: new Date().toISOString(),
    session: String(input.session_id || '').slice(0, 8),
    desc: String(ti.description || tr.description || '').slice(0, 80),
    role: strOrNull(ti.subagent_type) || 'agent',
    modelReq: strOrNull(ti.model),
    modelRes: strOrNull(tr.resolvedModel),
    effortReq: strOrNull(ti.effort),
    agentId: strOrNull(tr.agentId),
  };
  if (tr.isAsync === true || tr.status === 'async_launched') {
    return { kind: 'launch', ...head, outputFile: strOrNull(tr.outputFile) };
  }
  return {
    ...head,
    tokens: numOrNull(tr.totalTokens),
    usage: obj(tr.usage),
    ms: numOrNull(tr.totalDurationMs),
    tools: numOrNull(tr.totalToolUseCount),
  };
}

// Totals from an agent or session transcript (JSONL): usage of each assistant message (deduplicated by message id), tool_use
// blocks, wall time between the first and the last timestamp, the last session name (`-n`, a custom-title record). Null
// when unreadable or without assistant turns. opts.seen (a Set) dedupes message ids across files (a resumed session
// copies earlier messages); sidechain rows (subagent turns in an older transcript layout) are never counted here, so a
// session total never repeats its subagents.
function transcriptTotals(file, opts = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const msgs = new Map();
  const toolIds = new Set();
  let first = null;
  let last = null;
  let anon = 0;
  let title = null;
  const seen = opts.seen instanceof Set ? opts.seen : null;
  for (const raw of text.split('\n')) {
    let o;
    try {
      o = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      continue;
    }
    if (!obj(o)) continue;
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') title = o.customTitle.slice(0, 60);
    if (o.isSidechain === true) continue;
    const t = Date.parse(o.timestamp);
    if (Number.isFinite(t)) {
      if (first === null || t < first) first = t;
      if (last === null || t > last) last = t;
    }
    const m = o.message;
    if (o.type !== 'assistant' || !obj(m)) continue;
    if (seen && m.id && seen.has(m.id) && !msgs.has(m.id)) continue; // counted in an earlier file
    msgs.set(m.id || `anon${anon++}`, { usage: obj(m.usage) || {}, model: strOrNull(m.model) });
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_use') toolIds.add(b.id || `t${toolIds.size}`);
    }
  }
  if (!msgs.size) return null;
  if (seen) for (const id of msgs.keys()) if (!id.startsWith('anon')) seen.add(id);
  const sum ={ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let cost = 0;
  let priced = 0;
  let unpriced = 0;
  let cacheTtlAssumed = false;
  const models = new Set();
  for (const { usage: u, model } of msgs.values()) {
    const n = {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheCreate: Number(u.cache_creation_input_tokens) || 0,
    };
    sum.input += n.input;
    sum.output += n.output;
    sum.cacheRead += n.cacheRead;
    sum.cacheCreate += n.cacheCreate;
    if (model) models.add(model);
    // all-zero usage is neither priced nor counted as unpriced
    if (!(n.input > 0 || n.output > 0 || n.cacheRead > 0 || n.cacheCreate > 0)) continue;
    const c = messageCost(model, u);
    if (!c) {
      unpriced++;
      continue;
    }
    cost += c.usd;
    priced++;
    if (c.ttlAssumed) cacheTtlAssumed = true;
  }
  return {
    tokens: { ...sum, total: sum.input + sum.output + sum.cacheRead + sum.cacheCreate },
    tools: toolIds.size,
    ms: first !== null && last !== null ? last - first : null,
    turns: msgs.size,
    cost: priced ? round6(cost) : null,
    unpriced,
    models: [...models].sort(),
    cacheTtlAssumed,
    title,
  };
}

function modeHook() {
  try {
    const input = obj(parseInput(readStdin()));
    if (input && optedIn(input.cwd || process.cwd())) append(ledgerPath(input.cwd), hookLine(input));
  } catch {
    /* never fail the tool */
  }
  process.exit(0);
}

function modeStop() {
  try {
    const input = obj(parseInput(readStdin()));
    const agentId = input && (strOrNull(input.agent_id) || strOrNull(input.agentId));
    // Never the main session transcript: transcript_path counts only for a subagent whose basename is not the session id.
    const tp = input && strOrNull(input.transcript_path);
    const own = tp && path.basename(tp).replace(/.jsonl$/, "") !== String(input.session_id || "") ? tp : null;
    const file = input && (strOrNull(input.agent_transcript_path) || (agentId ? own : null));
    if (file && agentId && optedIn((input && input.cwd) || process.cwd())) {
      const t = transcriptTotals(file);
      if (t) {
        delete t.title;
        append(ledgerPath(input.cwd), { ts: new Date().toISOString(), kind: 'done', agentId, ...t });
      }
    }
  } catch {
    /* never block */
  }
  process.exit(0);
}

// A main session (the lead, a tab worker, a candidate lead): SessionStart writes a session line with the transcript path
// Claude Code gave (never derived: ~/.claude/projects may be a link), and `report` prices that transcript lazily.
function sessionLine(input, role) {
  const sid = strOrNull(input.session_id);
  const transcript = strOrNull(input.transcript_path);
  if (!sid || !transcript || input.agent_id) return null;
  return { ts: new Date().toISOString(), kind: 'session', session: sid, source: strOrNull(input.source), role: role || 'lead', transcript };
}

// SessionEnd: a totals snapshot of the session transcript, so the report still has the session after Claude Code
// cleans old transcripts up. Never the text; fails silent.
const END_MAX_BYTES = 300 * 1024 * 1024;
function modeEnd() {
  try {
    const input = obj(parseInput(readStdin()));
    const sid = input && strOrNull(input.session_id);
    const file = input && strOrNull(input.transcript_path);
    if (sid && file && !input.agent_id && optedIn(input.cwd || process.cwd()) && fs.statSync(file).size <= END_MAX_BYTES) {
      const t = transcriptTotals(file);
      if (t) append(ledgerPath(input.cwd), { ts: new Date().toISOString(), kind: 'sessionEnd', session: sid, ...t });
    }
  } catch {
    /* never block the exit */
  }
  process.exit(0);
}

function modeVerdict(argsIn) {
  const args = [];
  let cls = 'ordinary';
  for (let i = 0; i < argsIn.length; i++) {
    if (argsIn[i] === '--class') cls = argsIn[++i];
    else args.push(argsIn[i]);
  }
  const [pkg, roundS, verdict, cause] = args;
  const ok =
    pkg &&
    !pkg.startsWith('-') &&
    /^[1-9]$/.test(roundS || '') &&
    VERDICTS.includes(verdict) &&
    CLASSES.includes(cls) &&
    args.length <= 4 &&
    (verdict === 'ACCEPT' ? cause === undefined : CAUSES.includes(cause));
  if (!ok) {
    console.error(USAGE);
    process.exit(2);
  }
  const round = Number(roundS);
  const written = append(ledgerPath(process.cwd()), {
    ts: new Date().toISOString(),
    kind: 'verdict',
    pkg,
    round,
    verdict,
    cause: cause || null,
    class: cls,
  });
  if (!written) {
    console.error('ledger: project directory does not exist, nothing written');
    process.exit(1);
  }
  console.log(`ledger: ${pkg} round ${round} ${verdict}${cause ? ' ' + cause : ''} (${cls})`);
}

// Linear-interpolated quantile of a number array; null for an empty one.
function quantile(values, q) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const mean = (values) => {
  const v = values.filter((x) => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

const sumOrNull = (values) => {
  const v = values.filter((x) => typeof x === 'number');
  return v.length ? round6(v.reduce((a, b) => a + b, 0)) : null;
};

// modelReq matches modelRes when equal or when it is a dash-delimited part of it (sonnet ~ claude-sonnet-<version>).
function modelMatches(req, res) {
  return res === req || `-${res}-`.includes(`-${req}-`);
}

// Main sessions (the lead, tab workers, candidate leads): one row per session kind and model. The kind comes from the
// session name (`-n p3-implementer` -> implementer, `-n lead-x` -> lead), else from GHORC_ROLE at start. A readable
// transcript is priced now (it may have grown since the snapshot); a cleaned-up one falls back to the newest SessionEnd
// snapshot. Message ids are deduplicated across sessions, oldest first, so a resumed session is not counted twice.
function computeSessions(lines, leadPrefix) {
  const by = new Map();
  for (const l of lines) {
    if ((l.kind !== 'session' && l.kind !== 'sessionEnd') || typeof l.session !== 'string') continue;
    const s = by.get(l.session) || { session: l.session, start: null, end: null };
    if (l.kind === 'session' && !s.start) s.start = l;
    if (l.kind === 'sessionEnd' && (!s.end || String(l.ts) > String(s.end.ts))) s.end = l;
    by.set(l.session, s);
  }
  const seen = new Set();
  const list = [...by.values()]
    .sort((a, b) => String((a.start || a.end).ts).localeCompare(String((b.start || b.end).ts)))
    .map((s) => {
      const live = s.start && s.start.transcript ? transcriptTotals(s.start.transcript, { seen }) : null;
      const t = live || s.end;
      if (!t) return null;
      const name = typeof t.title === 'string' ? t.title.toLowerCase() : '';
      const p = name ? require('./lib/tabs.cjs').parseName(name, leadPrefix) : null;
      const kind = p && p.ok ? (p.role === 'lead' ? 'lead' : p.kind) : (s.start && s.start.role) || 'lead';
      const models = Array.isArray(t.models) && t.models.length ? t.models.join('+') : '-';
      return { kind, models, tokens: t.tokens && t.tokens.total, cost: numOrNull(t.cost), unpriced: numOrNull(t.unpriced) || 0, live: Boolean(live) };
    })
    .filter(Boolean);
  const rows = {};
  for (const s of list) (rows[`${s.kind} ${s.models}`] ||= []).push(s);
  return {
    sessions: Object.entries(rows)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, ss]) => {
        const [kind, models] = key.split(' ');
        return {
          kind,
          models,
          sessions: ss.length,
          tokensMedian: quantile(ss.map((s) => s.tokens), 0.5),
          costMedian: quantile(ss.map((s) => s.cost), 0.5),
          costTotal: sumOrNull(ss.map((s) => s.cost)),
          fromSnapshot: ss.filter((s) => !s.live).length,
        };
      }),
    sessionsCostTotal: sumOrNull(list.map((s) => s.cost)),
    sessionsUnpriced: list.filter((s) => typeof s.cost !== 'number' || s.unpriced > 0).length,
  };
}

function compute(lines, leadPrefix = 'lead-') {
  const verdicts = lines.filter((l) => l.kind === 'verdict');
  const done = new Map();
  for (const l of lines) if (l.kind === 'done' && l.agentId) done.set(l.agentId, l);
  const calls = lines
    .filter((l) => !['verdict', 'done', 'session', 'sessionEnd'].includes(l.kind))
    .map((c) => {
      if (c.kind !== 'launch' && !c.agentId) return c;
      // background (launch) or synchronous call with an agentId: totals come from the done line, else the transcript
      let d = c.agentId ? done.get(c.agentId) : null;
      if (!d && c.kind === 'launch' && c.outputFile) d = transcriptTotals(c.outputFile);
      return d
        ? { ...c, tokens: d.tokens.total, ms: d.ms, tools: d.tools, cost: numOrNull(d.cost), unpriced: numOrNull(d.unpriced) || 0 }
        : c;
    });
  // one row per role, requested model and effort: an implementer on sonnet/low and one on opus/medium are different rows,
  // so a routing change compares like with like
  const byRole = {};
  for (const c of calls) (byRole[[c.role || 'agent', c.modelReq || '-', c.effortReq || '-'].join('\u0000')] ||= []).push(c);
  const roles = Object.entries(byRole)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cs]) => {
      const [role, model, effort] = key.split('\u0000');
      const withRes = cs.filter((c) => c.modelReq && c.modelRes);
      return {
        role,
        model,
        effort,
        calls: cs.length,
        tokensMedian: quantile(cs.map((c) => c.tokens), 0.5),
        tokensQ3: quantile(cs.map((c) => c.tokens), 0.75),
        msMedian: quantile(cs.map((c) => c.ms), 0.5),
        msQ3: quantile(cs.map((c) => c.ms), 0.75),
        toolsMean: mean(cs.map((c) => c.tools)),
        modelDiffShare: withRes.length ? withRes.filter((c) => !modelMatches(c.modelReq, c.modelRes)).length / withRes.length : null,
        costMedian: quantile(cs.map((c) => c.cost), 0.5),
        costTotal: sumOrNull(cs.map((c) => c.cost)),
      };
    });
  const byPkg = {};
  for (const v of verdicts) (byPkg[v.pkg] ||= []).push(v);
  const packages = Object.entries(byPkg).map(([pkg, vs]) => {
    const first = vs.reduce((a, b) => (b.round < a.round ? b : a));
    return {
      pkg,
      class: first.class || 'ordinary',
      rounds: Math.max(...vs.map((v) => v.round)),
      firstVerdict: first.verdict,
      firstCause: first.cause || null,
    };
  });
  // A cascade package's first round was planned to fail sometimes: it stays out of the first-round rate.
  const rate = (all) => {
    const ps = all.filter((p) => p.firstCause !== 'CASCADE');
    return ps.length ? ps.filter((p) => p.firstVerdict === 'ACCEPT').length / ps.length : null;
  };
  const byClass = {};
  for (const c of CLASSES) {
    const ps = packages.filter((p) => p.class === c);
    byClass[c] = { packages: ps.length, firstRoundAcceptRate: rate(ps) };
  }
  const causes = {};
  for (const v of verdicts) if (v.cause) causes[v.cause] = (causes[v.cause] || 0) + 1;
  const costTotal = sumOrNull(calls.map((c) => c.cost));
  const ses = computeSessions(lines, leadPrefix);
  return {
    ...ses,
    costTotalAll: sumOrNull([costTotal, ses.sessionsCostTotal]),
    calls: calls.length,
    roles,
    packages,
    firstRoundAcceptRate: rate(packages),
    byClass,
    causes,
    costTotal,
    costCalls: calls.filter((c) => typeof c.cost === 'number').length,
    unpricedCalls: calls.filter((c) => typeof c.tokens === 'number' && (typeof c.cost !== 'number' || c.unpriced > 0)).length,
    pricesAsOf: PRICES_AS_OF,
  };
}

const f0 = (n) => (n === null ? '-' : String(Math.round(n)));
const f1 = (n) => (n === null ? '-' : (Math.round(n * 10) / 10).toString());
const pct = (n) => (n === null ? '-' : Math.round(n * 100) + '%');
const usd = (n, digits) => (n === null ? '-' : '$' + n.toFixed(digits));

function format(r) {
  const out = [`calls: ${r.calls}`];
  for (const x of r.roles) {
    out.push(
      `${x.role} ${x.model}/${x.effort}: calls=${x.calls} tokens med=${f0(x.tokensMedian)} q3=${f0(x.tokensQ3)} ms med=${f0(x.msMedian)} q3=${f0(x.msQ3)} tools mean=${f1(x.toolsMean)} model mismatch ${pct(x.modelDiffShare)} cost med=${usd(x.costMedian, 4)} total=${usd(x.costTotal, 2)}`,
    );
  }
  out.push(
    `estimated cost: ${usd(r.costTotal, 2)} at list prices as of ${r.pricesAsOf} (${r.costCalls} calls priced, ${r.unpricedCalls} without a price)`,
  );
  if (r.sessions.length) {
    out.push('sessions (the lead, tab workers and candidate leads; their subagents are in the rows above):');
    for (const s of r.sessions) {
      out.push(
        `  ${s.kind} ${s.models}: sessions=${s.sessions} tokens med=${f0(s.tokensMedian)} cost med=${usd(s.costMedian, 2)} total=${usd(s.costTotal, 2)}${s.fromSnapshot ? ` (${s.fromSnapshot} from the end snapshot)` : ''}`,
      );
    }
    out.push(`estimated cost with sessions: ${usd(r.costTotalAll, 2)} (${r.sessionsUnpriced} sessions without a full price)`);
  }
  if (r.packages.length) {
    out.push('packages:');
    for (const p of r.packages) {
      out.push(`  ${p.pkg} [${p.class}]: rounds=${p.rounds} first=${p.firstVerdict}${p.firstCause ? ' ' + p.firstCause : ''}`);
    }
  }
  out.push(`first-round ACCEPT rate: ${pct(r.firstRoundAcceptRate)} (${r.packages.length} packages)`);
  for (const c of CLASSES) out.push(`  ${c}: ${pct(r.byClass[c].firstRoundAcceptRate)} (${r.byClass[c].packages} packages)`);
  const cs = Object.entries(r.causes);
  out.push('causes: ' + (cs.length ? cs.map(([k, n]) => `${k}=${n}`).join(' ') : 'none'));
  return out.join('\n');
}

function modeReport(args) {
  const json = args.includes('--json');
  const i = args.indexOf('--since');
  const since = i >= 0 ? Date.parse(args[i + 1]) : null;
  if (i >= 0 && !Number.isFinite(since)) {
    console.error(USAGE);
    process.exit(2);
  }
  let lines = [];
  try {
    lines = fs
      .readFileSync(ledgerPath(process.cwd()), 'utf8')
      .split('\n')
      .map((s) => {
        try {
          return s.trim() ? JSON.parse(s) : null;
        } catch {
          return null;
        }
      })
      .filter(obj);
  } catch {
    /* no file */
  }
  if (since !== null) lines = lines.filter((l) => Date.parse(l.ts) >= since);
  if (!lines.length) {
    console.log('no ledger yet');
    return;
  }
  let leadPrefix = 'lead-';
  try {
    leadPrefix = require('./lib/tabs.cjs').settings(load(process.cwd())).leadPrefix;
  } catch {
    /* the default prefix */
  }
  const r = compute(lines, leadPrefix);
  console.log(json ? JSON.stringify(r) : format(r));
}

module.exports = { sessionLine, append, ledgerPath, transcriptTotals, compute };

if (require.main === module) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'hook') modeHook();
  else if (mode === 'stop') modeStop();
  else if (mode === 'end') modeEnd();
  else if (mode === 'verdict') modeVerdict(rest);
  else if (mode === 'report') modeReport(rest);
  else {
    console.error(USAGE);
    process.exit(mode === '--help' ? 0 : 2);
  }
}
