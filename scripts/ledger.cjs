'use strict';
// Call ledger: <project>/.claude/ghorc-out/ledger.jsonl, one JSON line per subagent call and per lead verdict.
// `hook`    PostToolUse(Agent): appends the call line (never the prompt or the response text); fails silent, exit 0.
// `verdict` <pkg> <round> <ACCEPT|CHANGES_REQUIRED> [cause]: appends a verdict line.
// `report`  [--since <ISO>] [--json]: per-role and per-package aggregates.
const fs = require('node:fs');
const path = require('node:path');
const { readStdin, parseInput } = require('./lib/hook-io.cjs');
const { projectRoot } = require('./lib/root.cjs');

const CAUSES = ['BRIEF_OMISSION', 'SKIPPED_CHECK', 'REASONING_FAILURE', 'OTHER'];
const VERDICTS = ['ACCEPT', 'CHANGES_REQUIRED'];
const USAGE =
  'usage: ledger.cjs hook | verdict <pkg> <round> <ACCEPT|CHANGES_REQUIRED> [' +
  CAUSES.join('|') +
  '] | report [--since <ISO>] [--json]';

const ledgerPath = (cwd) => path.join(projectRoot(cwd), '.claude', 'ghorc-out', 'ledger.jsonl');

function append(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

function hookLine(input) {
  const ti = (input.tool_input && typeof input.tool_input === 'object' && input.tool_input) || {};
  const tr = (input.tool_response && typeof input.tool_response === 'object' && input.tool_response) || {};
  return {
    ts: new Date().toISOString(),
    session: String(input.session_id || '').slice(0, 8),
    desc: String(ti.description || '').slice(0, 80),
    role: strOrNull(ti.subagent_type) || 'agent',
    modelReq: strOrNull(ti.model),
    modelRes: strOrNull(tr.resolvedModel),
    effortReq: strOrNull(ti.effort),
    tokens: numOrNull(tr.totalTokens),
    usage: tr.usage && typeof tr.usage === 'object' ? tr.usage : null,
    ms: numOrNull(tr.totalDurationMs),
    tools: numOrNull(tr.totalToolUseCount),
  };
}

function modeHook() {
  try {
    const input = parseInput(readStdin());
    if (input && !Array.isArray(input)) append(ledgerPath(input.cwd), hookLine(input));
  } catch {
    /* never fail the tool */
  }
  process.exit(0);
}

function modeVerdict(args) {
  const [pkg, roundS, verdict, cause] = args;
  const round = Number(roundS);
  const ok =
    pkg &&
    Number.isInteger(round) &&
    round >= 1 &&
    VERDICTS.includes(verdict) &&
    (cause === undefined || CAUSES.includes(cause)) &&
    args.length <= 4;
  if (!ok) {
    console.error(USAGE);
    process.exit(2);
  }
  append(ledgerPath(process.cwd()), { ts: new Date().toISOString(), kind: 'verdict', pkg, round, verdict, cause: cause || null });
  console.log(`ledger: ${pkg} round ${round} ${verdict}${cause ? ' ' + cause : ''}`);
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

function compute(lines) {
  const calls = lines.filter((l) => l.kind !== 'verdict');
  const verdicts = lines.filter((l) => l.kind === 'verdict');
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
        modelDiffShare: withRes.length ? withRes.filter((c) => c.modelRes !== c.modelReq).length / withRes.length : null,
      };
    });
  const byPkg = {};
  for (const v of verdicts) (byPkg[v.pkg] ||= []).push(v);
  const packages = Object.entries(byPkg).map(([pkg, vs]) => {
    const first = vs.reduce((a, b) => (b.round < a.round ? b : a));
    return { pkg, rounds: Math.max(...vs.map((v) => v.round)), firstVerdict: first.verdict, firstCause: first.cause || null };
  });
  const accepted = packages.filter((p) => p.firstVerdict === 'ACCEPT').length;
  const causes = {};
  for (const v of verdicts) if (v.cause) causes[v.cause] = (causes[v.cause] || 0) + 1;
  return {
    calls: calls.length,
    roles,
    packages,
    firstRoundAcceptRate: packages.length ? accepted / packages.length : null,
    causes,
  };
}

const f0 = (n) => (n === null ? '-' : String(Math.round(n)));
const f1 = (n) => (n === null ? '-' : (Math.round(n * 10) / 10).toString());
const pct = (n) => (n === null ? '-' : Math.round(n * 100) + '%');

function format(r) {
  const out = [`calls: ${r.calls}`];
  for (const x of r.roles) {
    out.push(
      `${x.role}: calls=${x.calls} tokens med=${f0(x.tokensMedian)} q3=${f0(x.tokensQ3)} ms med=${f0(x.msMedian)} q3=${f0(x.msQ3)} tools mean=${f1(x.toolsMean)} model!=req ${pct(x.modelDiffShare)}`,
    );
  }
  if (r.packages.length) {
    out.push('packages:');
    for (const p of r.packages) out.push(`  ${p.pkg}: rounds=${p.rounds} first=${p.firstVerdict}${p.firstCause ? ' ' + p.firstCause : ''}`);
  }
  out.push(`first-round ACCEPT rate: ${pct(r.firstRoundAcceptRate)} (${r.packages.length} packages)`);
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
      .filter((l) => l && typeof l === 'object');
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
else if (mode === 'verdict') modeVerdict(rest);
else if (mode === 'report') modeReport(rest);
else {
  console.error(USAGE);
  process.exit(mode === '--help' ? 0 : 2);
}
