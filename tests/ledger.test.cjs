'use strict';
// 0.6 call ledger: hook line, no prompt leak, fail-silent, verdict validation, report aggregates.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, tmpProject } = require('./helpers.cjs');

const ledgerFile = (dir) => path.join(dir, '.claude', 'ghorc-out', 'ledger.jsonl');
const readLines = (dir) =>
  fs
    .readFileSync(ledgerFile(dir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const env = (dir) => ({ CLAUDE_PROJECT_DIR: dir });
const SECRET = 'SECRET-BRIEF-TEXT sk-live-123';

function payload(dir, extra = {}) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'abcdef1234567890',
    cwd: dir,
    tool_name: 'Agent',
    tool_input: {
      description: 'implement the thing',
      subagent_type: 'ghorc:implementer',
      model: 'sonnet',
      effort: 'medium',
      prompt: SECRET,
    },
    tool_response: {
      resolvedModel: 'claude-sonnet-5-5',
      totalTokens: 1234,
      totalDurationMs: 5678,
      totalToolUseCount: 7,
      usage: { input_tokens: 10, output_tokens: 20 },
      agentId: 'ag1',
      content: [{ type: 'text', text: SECRET }],
    },
    ...extra,
  };
}

test('hook appends one well-formed line', () => {
  const dir = tmpProject();
  const r = runScript('ledger.cjs', payload(dir), { args: ['hook'], env: env(dir) });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  const [l] = readLines(dir);
  assert.match(l.ts, /^\d{4}-\d\d-\d\dT/);
  assert.equal(l.session, 'abcdef12');
  assert.equal(l.desc, 'implement the thing');
  assert.equal(l.role, 'ghorc:implementer');
  assert.equal(l.modelReq, 'sonnet');
  assert.equal(l.modelRes, 'claude-sonnet-5-5');
  assert.equal(l.effortReq, 'medium');
  assert.equal(l.tokens, 1234);
  assert.deepEqual(l.usage, { input_tokens: 10, output_tokens: 20 });
  assert.equal(l.ms, 5678);
  assert.equal(l.tools, 7);
});

test('hook never stores the prompt or the response text; description is cut to 80', () => {
  const dir = tmpProject();
  const p = payload(dir);
  p.tool_input.description = 'x'.repeat(200);
  runScript('ledger.cjs', p, { args: ['hook'], env: env(dir) });
  const raw = fs.readFileSync(ledgerFile(dir), 'utf8');
  assert.ok(!raw.includes('SECRET-BRIEF-TEXT'));
  assert.ok(!raw.includes('sk-live'));
  assert.equal(JSON.parse(raw).desc.length, 80);
});

test('hook: missing fields give nulls and role "agent"', () => {
  const dir = tmpProject();
  runScript('ledger.cjs', { session_id: 's', cwd: dir, tool_name: 'Agent' }, { args: ['hook'], env: env(dir) });
  const [l] = readLines(dir);
  assert.equal(l.role, 'agent');
  assert.equal(l.modelReq, null);
  assert.equal(l.tokens, null);
  assert.equal(l.usage, null);
});

test('hook: malformed stdin exits 0 and writes nothing', () => {
  const dir = tmpProject();
  for (const bad of ['not json', '', '[1,2]', 'null']) {
    const r = runScript('ledger.cjs', bad, { args: ['hook'], env: env(dir) });
    assert.equal(r.code, 0);
  }
  assert.equal(fs.existsSync(ledgerFile(dir)), false);
});

test('verdict validates its arguments', () => {
  const dir = tmpProject();
  const v = (...args) => runScript('ledger.cjs', '', { args: ['verdict', ...args], env: env(dir), cwd: dir });
  const bads = [
    [],
    ['E1'],
    ['E1', '0', 'ACCEPT'],
    ['E1', '10', 'ACCEPT'],
    ['E1', 'x', 'ACCEPT'],
    ['-E1', '1', 'ACCEPT'],
    ['E1', '1', 'MAYBE'],
    ['E1', '1', 'CHANGES_REQUIRED'],
    ['E1', '1', 'CHANGES_REQUIRED', 'WHY'],
    ['E1', '1', 'ACCEPT', 'OTHER'],
    ['E1', '1', 'ACCEPT', '--class', 'huge'],
    ['E1', '1', 'ACCEPT', 'extra', 'more'],
  ];
  for (const bad of bads) {
    const r = v(...bad);
    assert.equal(r.code, 2, bad.join(' '));
    assert.match(r.err, /usage/);
  }
  assert.equal(fs.existsSync(ledgerFile(dir)), false);
  assert.equal(v('E1', '1', 'CHANGES_REQUIRED', 'REASONING_FAILURE').code, 0);
  assert.equal(v('E1', '2', 'ACCEPT').code, 0);
  const [a, b] = readLines(dir);
  assert.equal(a.kind, 'verdict');
  assert.equal(a.pkg, 'E1');
  assert.equal(a.round, 1);
  assert.equal(a.cause, 'REASONING_FAILURE');
  assert.equal(b.cause, null);
});

test('verdict --class is stored, default ordinary', () => {
  const dir = tmpProject();
  const v = (...args) => runScript('ledger.cjs', '', { args: ['verdict', ...args], env: env(dir), cwd: dir });
  assert.equal(v('E1', '1', 'ACCEPT', '--class', 'critical').code, 0);
  assert.equal(v('E2', '1', 'ACCEPT').code, 0);
  const [a, b] = readLines(dir);
  assert.equal(a.class, 'critical');
  assert.equal(b.class, 'ordinary');
});

test('nothing is written (and no directory created) when the project dir does not exist', () => {
  const dir = path.join(tmpProject(), 'gone', 'deeper');
  const r = runScript('ledger.cjs', payload(dir), { args: ['hook'], env: env(dir) });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(path.dirname(dir)), false);
  const v = runScript('ledger.cjs', '', { args: ['verdict', 'E1', '1', 'ACCEPT'], env: env(dir), cwd: os.tmpdir() });
  assert.equal(v.code, 1);
  assert.equal(fs.existsSync(path.dirname(dir)), false);
});

const T = (id, ts, usage, content) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, usage, content } });

function writeTranscript(dir, name = 'agent.jsonl') {
  const f = path.join(dir, name);
  fs.writeFileSync(
    f,
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-16T10:00:00.000Z', message: { role: 'user' } }),
      T('m1', '2026-10-16T10:00:05.000Z', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 1000 }, [{ type: 'tool_use', id: 't1' }]),
      T('m1', '2026-10-16T10:00:06.000Z', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 1000 }, [{ type: 'tool_use', id: 't1' }]),
      T('m2', '2026-10-16T10:00:20.000Z', { input_tokens: 5, output_tokens: 15, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0 }, [{ type: 'tool_use', id: 't2' }, { type: 'text', text: 'x' }]),
      T('m3', '2026-10-16T10:01:00.000Z', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 1200, cache_creation_input_tokens: 3 }, [{ type: 'text', text: 'done' }]),
    ].join('\n') + '\n',
  );
  return f;
}
// m1 (deduplicated) 1130 + m2 1120 + m3 1206 = 3456; 2 tool_use blocks; 60 s; 3 turns

test('async launch writes a launch line without totals or prompt; stop writes a done line from the transcript', () => {
  const dir = tmpProject();
  const out = writeTranscript(dir, 'out.jsonl');
  const p = payload(dir);
  p.tool_response = { isAsync: true, status: 'async_launched', agentId: 'agX', outputFile: out, resolvedModel: 'claude-sonnet-5-5', description: 'd', prompt: SECRET };
  runScript('ledger.cjs', p, { args: ['hook'], env: env(dir) });
  const [l] = readLines(dir);
  assert.equal(l.kind, 'launch');
  assert.equal(l.agentId, 'agX');
  assert.equal(l.outputFile, out);
  assert.equal(l.tokens, undefined);
  assert.ok(!fs.readFileSync(ledgerFile(dir), 'utf8').includes('SECRET-BRIEF-TEXT'));

  const t = writeTranscript(dir);
  runScript('ledger.cjs', { hook_event_name: 'SubagentStop', session_id: 's', cwd: dir, agent_id: 'agX', agent_transcript_path: t }, { args: ['stop'], env: env(dir) });
  const d = readLines(dir)[1];
  assert.equal(d.kind, 'done');
  assert.equal(d.agentId, 'agX');
  assert.deepEqual(d.tokens, { input: 16, output: 37, cacheRead: 2400, cacheCreate: 1003, total: 3456 });
  assert.equal(d.tools, 2);
  assert.equal(d.ms, 60000);
  assert.equal(d.turns, 3);
});

test('stop: payload without transcript path or agent id, or with an unreadable file, writes nothing and exits 0', () => {
  const dir = tmpProject();
  for (const p of [{ cwd: dir }, { cwd: dir, agent_id: 'a' }, { cwd: dir, agent_transcript_path: 'x' }, { cwd: dir, agent_id: 'a', transcript_path: path.join(dir, 'nope') }]) {
    assert.equal(runScript('ledger.cjs', p, { args: ['stop'], env: env(dir) }).code, 0);
  }
  assert.equal(runScript('ledger.cjs', 'garbage', { args: ['stop'], env: env(dir) }).code, 0);
  assert.equal(fs.existsSync(ledgerFile(dir)), false);
});

test('report: a launch joins its done line; a launch without one is read lazily from outputFile', () => {
  const dir = tmpProject();
  const out = writeTranscript(dir, 'out.jsonl');
  const base = { ts: '2026-10-16T10:00:00.000Z', session: 's', desc: 'd', role: 'ghorc:implementer', modelReq: 'sonnet', modelRes: 'claude-sonnet-5-5', effortReq: 'medium' };
  const lines = [
    { kind: 'launch', ...base, agentId: 'a1', outputFile: path.join(dir, 'missing.jsonl') },
    { kind: 'done', ts: base.ts, agentId: 'a1', tokens: { total: 1000 }, tools: 4, ms: 2000, turns: 2 },
    { kind: 'launch', ...base, agentId: 'a2', outputFile: out },
    { kind: 'launch', ...base, agentId: 'a3', outputFile: path.join(dir, 'missing2.jsonl') },
  ];
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true });
  fs.writeFileSync(ledgerFile(dir), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const j = JSON.parse(runScript('ledger.cjs', '', { args: ['report', '--json'], env: env(dir), cwd: dir }).out);
  assert.equal(j.calls, 3);
  const r = j.roles[0];
  assert.equal(r.tokensMedian, 2228); // a1 1000, a2 3456 (a3 unknown)
  assert.equal(r.toolsMean, 3);
  assert.equal(r.modelDiffShare, 0, 'sonnet matches claude-sonnet-5-5');
});

test('report: first-round accept rate per class and overall', () => {
  const dir = tmpProject();
  const vs = [
    ['E1', 1, 'ACCEPT', null, 'critical'],
    ['E2', 1, 'CHANGES_REQUIRED', 'OTHER', 'critical'],
    ['E3', 1, 'ACCEPT', null, 'ordinary'],
    ['E4', 1, 'ACCEPT', null, 'ordinary'],
  ].map(([pkg, round, verdict, cause, cls]) => ({ ts: '2026-10-16T10:00:00.000Z', kind: 'verdict', pkg, round, verdict, cause, class: cls }));
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true });
  fs.writeFileSync(ledgerFile(dir), vs.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const j = JSON.parse(runScript('ledger.cjs', '', { args: ['report', '--json'], env: env(dir), cwd: dir }).out);
  assert.equal(j.byClass.critical.firstRoundAcceptRate, 0.5);
  assert.equal(j.byClass.ordinary.firstRoundAcceptRate, 1);
  assert.equal(j.firstRoundAcceptRate, 0.75);
  assert.match(runScript('ledger.cjs', '', { args: ['report'], env: env(dir), cwd: dir }).out, /critical: 50% \(2 packages\)/);
});

test('report: empty ledger prints one line', () => {
  const dir = tmpProject();
  const r = runScript('ledger.cjs', '', { args: ['report'], env: env(dir), cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'no ledger yet');
});

test('report: median, upper quartile, accept rate on a 5-line fixture', () => {
  const dir = tmpProject();
  const calls = [100, 200, 300, 400, 500].map((t, i) => ({
    ts: `2026-10-16T10:0${i}:00.000Z`,
    session: 's',
    desc: 'd',
    role: 'ghorc:implementer',
    modelReq: 'sonnet',
    modelRes: i === 0 ? 'claude-opus-5' : 'sonnet',
    effortReq: 'medium',
    tokens: t,
    usage: null,
    ms: t * 10,
    tools: i + 1,
  }));
  const verdicts = [
    { kind: 'verdict', pkg: 'E1', round: 1, verdict: 'ACCEPT', cause: null },
    { kind: 'verdict', pkg: 'E2', round: 1, verdict: 'CHANGES_REQUIRED', cause: 'BRIEF_OMISSION' },
    { kind: 'verdict', pkg: 'E2', round: 2, verdict: 'ACCEPT', cause: null },
  ].map((v) => ({ ts: '2026-10-16T11:00:00.000Z', ...v }));
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true });
  fs.writeFileSync(ledgerFile(dir), [...calls, ...verdicts].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const run = (...a) => runScript('ledger.cjs', '', { args: ['report', ...a], env: env(dir), cwd: dir });
  const j = JSON.parse(run('--json').out);
  const role = j.roles[0];
  assert.equal(role.calls, 5);
  assert.equal(role.tokensMedian, 300);
  assert.equal(role.tokensQ3, 400);
  assert.equal(role.msMedian, 3000);
  assert.equal(role.toolsMean, 3);
  assert.equal(role.modelDiffShare, 0.2);
  assert.equal(j.firstRoundAcceptRate, 0.5);
  assert.deepEqual(j.causes, { BRIEF_OMISSION: 1 });
  assert.deepEqual(j.packages.find((p) => p.pkg === 'E2'), { pkg: 'E2', class: 'ordinary', rounds: 2, firstVerdict: 'CHANGES_REQUIRED', firstCause: 'BRIEF_OMISSION' });
  const text = run().out;
  assert.match(text, /ghorc:implementer: calls=5 tokens med=300 q3=400/);
  assert.match(text, /first-round ACCEPT rate: 50% \(2 packages\)/);
  // --since drops the call lines (all earlier than 11:00) and keeps verdicts
  const since = JSON.parse(run('--since', '2026-10-16T10:30:00Z', '--json').out);
  assert.equal(since.calls, 0);
  assert.equal(since.packages.length, 2);
});

test('setup: a missing top-level effortLevel is ok; --apply effort writes only modelSettings.<model>.effortLevel', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const sf = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(sf, JSON.stringify({ model: 'opus' }));
    const proj = tmpProject({});
    const e = { GHORC_HOME: home };
    const run = (...a) => runScript('setup.cjs', '', { args: a, env: e }).out;
    assert.doesNotMatch(run('--check', '--cwd', proj), /MISSING effort/);
    fs.writeFileSync(sf, JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }));
    assert.match(run('--check', '--cwd', proj), /MISSING effort/, 'a differing per-model value is not ok');
    run('--apply', 'effort', '--cwd', proj);
    const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.equal(s.modelSettings['claude-opus-5-5'].effortLevel, 'medium');
    assert.equal('opus' in s.modelSettings, false, 'the alias is not used as a key');
    assert.equal('effortLevel' in s, false);
    assert.doesNotMatch(run('--check', '--cwd', proj), /MISSING effort/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup: lead.model alias maps to a full id; an explicit full id passes through', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const sf = path.join(home, '.claude', 'settings.json');
    for (const [model, key] of [['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5'], ['claude-opus-4-1', 'claude-opus-4-1']]) {
      fs.writeFileSync(sf, '{}');
      const proj = tmpProject({ lead: { model, effort: 'high' } });
      runScript('setup.cjs', '', { args: ['--apply', 'effort', '--cwd', proj], env: { GHORC_HOME: home } });
      assert.deepEqual(JSON.parse(fs.readFileSync(sf, 'utf8')).modelSettings, { [key]: { effortLevel: 'high' } });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stop: never falls back to the main session transcript', () => {
  const dir = tmpProject();
  const main = writeTranscript(dir, 'sess-1234.jsonl');
  const run = (p) => runScript('ledger.cjs', { cwd: dir, ...p }, { args: ['stop'], env: env(dir) });
  assert.equal(run({ session_id: 'sess-1234', agent_id: 'a1', transcript_path: main }).code, 0);
  assert.equal(run({ session_id: 'sess-1234', transcript_path: main }).code, 0);
  assert.equal(fs.existsSync(ledgerFile(dir)), false, 'session transcript only: nothing written');
  const sub = writeTranscript(dir, 'agent-a1.jsonl');
  run({ session_id: 'sess-1234', agent_id: 'a1', transcript_path: sub });
  assert.equal(readLines(dir)[0].agentId, 'a1');
});
