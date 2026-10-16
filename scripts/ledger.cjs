'use strict';
// Call ledger: <project>/.claude/ghorc-out/ledger.jsonl, one JSON line per event.
// `hook`    PostToolUse(Agent): a synchronous call appends a call line with totals; a background call (async_launched)
//           appends a launch line. Never the prompt or the response text; fails silent, exit 0.
// `stop`    SubagentStop: totals from the agent transcript become a done line (matched to the launch by agentId).
// `verdict` <pkg> <round> <ACCEPT|CHANGES_REQUIRED> [cause] [--class critical|ordinary]: appends a verdict line.
// `report`  [--since <ISO>] [--json]: per-role, per-class and per-package aggregates.
const fs = require('node:fs');
const path = require('node:path');
const { readStdin, parseInput } = require('./lib/hook-io.cjs');
const { projectRoot } = require('./lib/root.cjs');

const CAUSES = ['BRIEF_OMISSION', 'SKIPPED_CHECK', 'REASONING_FAILURE', 'OTHER'];
const VERDICTS = ['ACCEPT', 'CHANGES_REQUIRED'];
const CLASSES = ['critical', 'ordinary'];
const USAGE =
  'usage: ledger.cjs hook | stop | verdict <pkg> <round 1-9> ACCEPT [--class critical|ordinary] | ' +
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

// Totals from an agent transcript (JSONL): usage of each assistant message (deduplicated by message id), tool_use
// blocks, wall time between the first and the last timestamp. Null when unreadable or without assistant turns.
function transcriptTotals(file) {
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
  for (const raw of text.split('\n')) {
    let o;
    try {
      o = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      continue;
    }
    if (!obj(o)) continue;
    const t = Date.parse(o.timestamp);
    if (Number.isFinite(t)) {
      if (first === null || t < first) first = t;
      if (last === null || t > last) last = t;
    }
    const m = o.message;
    if (o.type !== 'assistant' || !obj(m)) continue;
    msgs.set(m.id || `anon${anon++}`, obj(m.usage) || {});
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_use') toolIds.add(b.id || `t${toolIds.size}`);
    }
  }
  if (!msgs.size) return null;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const u of msgs.values()) {
    sum.input += Number(u.input_tokens) || 0;
    sum.output += Number(u.output_tokens) || 0;
    sum.cacheRead += Number(u.cache_read_input_tokens) || 0;
    sum.cacheCreate += Number(u.cache_creation_input_tokens) || 0;
  }
  return {
    tokens: { ...sum, total: sum.input + sum.output + sum.cacheRead + sum.cacheCreate },
    tools: toolIds.size,
    ms: first !== null && last !== null ? last - first : null,
    turns: msgs.size,
  };
}

function modeHook() {
  try {
    const input = obj(parseInput(readStdin()));
    if (input) append(ledgerPath(input.cwd), hookLine(input));
  } catch {
    /* never fail the tool */
  }
  process.exit(0);
}

function modeStop() {
  try {
    const input = obj(parseInput(readStdin()));
    const file = input && (strOrNull(input.agent_transcript_path) || strOrNull(input.transcript_path));
    const agentId = input && (strOrNull(input.agent_id) || strOrNull(input.agentId));
    if (file && agentId) {
      const t = transcriptTotals(file);
      if (t) append(ledgerPath(input.cwd), { ts: new Date().toISOString(), kind: 'done', agentId, ...t });
    }
  } catch {
    /* never block */
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

// modelReq matches modelRes when equal or when it is a dash-delimited part of it (sonnet ~ claude-sonnet-5-5).
function modelMatches(req, res) {
  return res === req || `-${res}-`.includes(`-${req}-`);
}

function compute(lines) {
  const verdicts = lines.filter((l) => l.kind === 'verdict');
  const done = new Map();
  for (const l of lines) if (l.kind === 'done' && l.agentId) done.set(l.agentId, l);
  const calls = lines
    .filter((l) => l.kind !== 'verdict' && l.kind !== 'done')
    .map((c) => {
      if (c.kind !== 'launch' && !c.agentId) return c;
      // background (launch) or synchronous call with an agentId: totals come from the done line, else the transcript
      let d = c.agentId ? done.get(c.agentId) : null;
      if (!d && c.kind === 'launch' && c.outputFile) d = transcriptTotals(c.outputFile);
      return d ? { ...c, tokens: d.tokens.total, ms: d.ms, tools: d.tools } : c;
    });
  const byRole = {};
  for (const c of calls) (byRole[c.role || 'agent'] ||= []).push(c);
  const roles = Object.entries(byRole)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, cs]) => {
      const withRes = cs.filter((c) => c.modelReq && c.modelRes);
      return {
        role,
        calls: cs.length,
        tokensMedian: quantile(cs.map((c) => c.tokens), 0.5),
        tokensQ3: quantile(cs.map((c) => c.tokens), 0.75),
        msMedian: quantile(cs.map((c) => c.ms), 0.5),
        msQ3: quantile(cs.map((c) => c.ms), 0.75),
        toolsMean: mean(cs.map((c) => c.tools)),
        modelDiffShare: withRes.length ? withRes.filter((c) => !modelMatches(c.modelReq, c.modelRes)).length / withRes.length : null,
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
  const rate = (ps) => (ps.length ? ps.filter((p) => p.firstVerdict === 'ACCEPT').length / ps.length : null);
  const byClass = {};
  for (const c of CLASSES) {
    const ps = packages.filter((p) => p.class === c);
    byClass[c] = { packages: ps.length, firstRoundAcceptRate: rate(ps) };
  }
  const causes = {};
  for (const v of verdicts) if (v.cause) causes[v.cause] = (causes[v.cause] || 0) + 1;
  return { calls: calls.length, roles, packages, firstRoundAcceptRate: rate(packages), byClass, causes };
}

const f0 = (n) => (n === null ? '-' : String(Math.round(n)));
const f1 = (n) => (n === null ? '-' : (Math.round(n * 10) / 10).toString());
const pct = (n) => (n === null ? '-' : Math.round(n * 100) + '%');

function format(r) {
  const out = [`calls: ${r.calls}`];
  for (const x of r.roles) {
    out.push(
      `${x.role}: calls=${x.calls} tokens med=${f0(x.tokensMedian)} q3=${f0(x.tokensQ3)} ms med=${f0(x.msMedian)} q3=${f0(x.msQ3)} tools mean=${f1(x.toolsMean)} model mismatch ${pct(x.modelDiffShare)}`,
    );
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
  const r = compute(lines);
  console.log(json ? JSON.stringify(r) : format(r));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'hook') modeHook();
else if (mode === 'stop') modeStop();
else if (mode === 'verdict') modeVerdict(rest);
else if (mode === 'report') modeReport(rest);
else {
  console.error(USAGE);
  process.exit(mode === '--help' ? 0 : 2);
}
