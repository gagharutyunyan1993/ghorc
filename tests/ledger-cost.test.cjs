'use strict';
// Estimated cost per subagent run: list prices from scripts/lib/prices.cjs applied to transcript usage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpProject } = require('./helpers.cjs');
const { messageCost, PRICES_AS_OF } = require('../scripts/lib/prices.cjs');

const ledgerFile = (dir) => path.join(dir, '.claude', 'ghorc-out', 'ledger.jsonl');
const env = (dir) => ({ CLAUDE_PROJECT_DIR: dir });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

const A = (id, model, usage) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-24T10:00:00.000Z', message: { id, model, usage, content: [{ type: 'text', text: 'PRIVATE-REPLY' }] } });

function stopWith(dir, id, lines) {
  const f = path.join(dir, `agent-${id}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  runScript('ledger.cjs', { hook_event_name: 'SubagentStop', session_id: 's', cwd: dir, agent_id: id, agent_transcript_path: f }, { args: ['stop'], env: env(dir) });
  return JSON.parse(fs.readFileSync(ledgerFile(dir), 'utf8').trim().split('\n').pop());
}

const report = (dir, ...a) => runScript('ledger.cjs', '', { args: ['report', ...a], env: env(dir), cwd: dir });

test('prices: Opus message with every token kind and a TTL split', () => {
  // Opus 5.5: input 4, output 20, cache read 0.20, 5m write 5, 1h write 8 (USD per 1M)
  // 1000*4/1e6 = 0.004; 2000*20/1e6 = 0.04; 100000*0.2/1e6 = 0.02; 10000*5/1e6 = 0.05; 20000*8/1e6 = 0.16; sum 0.274
  const c = messageCost('claude-opus-5-5', {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_read_input_tokens: 100000,
    cache_creation_input_tokens: 30000,
    cache_creation: { ephemeral_5m_input_tokens: 10000, ephemeral_1h_input_tokens: 20000 },
  });
  near(c.usd, 0.274);
  assert.equal(c.ttlAssumed, false);
});

test('prices: Haiku uses the long tier when the prompt is over 100000 tokens', () => {
  // long: prompt 1000 + 150000 = 151000 > 100000: input 0.5, read 0.05, output 2.5
  // 1000*0.5/1e6 = 0.0005; 150000*0.05/1e6 = 0.0075; 1000*2.5/1e6 = 0.0025; sum 0.0105
  near(messageCost('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 150000 }).usd, 0.0105);
  // short: prompt 51000: input 0.1, read 0.01, output 0.5: 0.0001 + 0.0005 + 0.0005 = 0.0011
  near(messageCost('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 50000 }).usd, 0.0011);
  // exactly 100000 is still the short tier: 100000*0.1/1e6 = 0.01
  near(messageCost('claude-haiku-5-5', { input_tokens: 100000 }).usd, 0.01);
  // cache writes count towards the prompt: 60000 + 50000 = 110000 > 100000 -> 60000*0.5/1e6 + 50000*0.5*1.25/1e6 = 0.03 + 0.03125
  near(messageCost('claude-haiku-5-5', { input_tokens: 60000, cache_creation_input_tokens: 50000 }).usd, 0.06125);
});

test('prices: no split prices the cache writes at the 5m rate and says so', () => {
  // Sonnet 5.5: input 2, output 10, 5m write 2.5; 1000*2/1e6 = 0.002; 1000*10/1e6 = 0.01; 10000*2.5/1e6 = 0.025; sum 0.037
  const c = messageCost('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 10000 });
  near(c.usd, 0.037);
  assert.equal(c.ttlAssumed, true);
  assert.equal(messageCost('claude-sonnet-5-5', { input_tokens: 1000 }).ttlAssumed, false, 'no cache writes: nothing assumed');
});

test('prices: model matching', () => {
  const u = { input_tokens: 1000000 };
  near(messageCost('claude-opus-5-5[1m]', u).usd, 4);
  near(messageCost('claude-opus-5-5-20261101', u).usd, 4);
  near(messageCost('opus', u).usd, 4);
  near(messageCost('fable', u).usd, 8);
  near(messageCost('claude-fable-5-2', u).usd, 8);
  near(messageCost('sonnet', u).usd, 2);
  near(messageCost('haiku', { input_tokens: 100000 }).usd, 0.01);
  for (const m of ['<synthetic>', 'claude-opus-5', 'claude-opus-5-50', 'claude-sonnet-4-6', '', null, undefined, 'toString']) {
    assert.equal(messageCost(m, u), null, String(m));
  }
});

test('done line carries cost, models, unpriced and cacheTtlAssumed; duplicates by message id count once', () => {
  const dir = tmpProject();
  const d = stopWith(dir, 'c1', [
    // m1 (twice, counted once): Opus, 1000 in + 2000 out = 0.004 + 0.04 = 0.044
    A('m1', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000 }),
    A('m1', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000 }),
    // m2: Opus with a split: 10000 5m write = 0.05
    A('m2', 'claude-opus-5-5', { cache_creation_input_tokens: 10000, cache_creation: { ephemeral_5m_input_tokens: 10000, ephemeral_1h_input_tokens: 0 } }),
    // m3: unknown model with usage: unpriced
    A('m3', '<synthetic>', { input_tokens: 5, output_tokens: 5 }),
    // m4: unknown model, all-zero usage: neither priced nor unpriced
    A('m4', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
  ]);
  assert.equal(d.kind, 'done');
  assert.equal(d.cost, 0.094);
  assert.equal(d.unpriced, 1);
  assert.deepEqual(d.models, ['<synthetic>', 'claude-opus-5-5']);
  assert.equal(d.cacheTtlAssumed, false);
  assert.ok(!fs.readFileSync(ledgerFile(dir), 'utf8').includes('PRIVATE-REPLY'));
});

test('done line: no split sets cacheTtlAssumed; only unknown models gives cost null', () => {
  const dir = tmpProject();
  const a = stopWith(dir, 'c2', [A('m1', 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 10000 })]);
  assert.equal(a.cost, 0.037);
  assert.equal(a.cacheTtlAssumed, true);
  const b = stopWith(dir, 'c3', [A('m1', 'claude-sonnet-4-6', { input_tokens: 1000 })]);
  assert.equal(b.cost, null);
  assert.equal(b.unpriced, 1);
});

test('report: estimated cost line, per-role cost, --json totals', () => {
  const dir = tmpProject();
  const base = { ts: '2026-11-24T10:00:00.000Z', session: 's', desc: 'd', role: 'ghorc:implementer', modelReq: 'opus', modelRes: 'claude-opus-5-5', effortReq: 'high' };
  const done = (agentId, cost, unpriced) => ({ kind: 'done', ts: base.ts, agentId, tokens: { total: 100 }, tools: 1, ms: 1000, turns: 1, cost, unpriced });
  const lines = [
    { kind: 'launch', ...base, agentId: 'a1', outputFile: null },
    done('a1', 0.25, 0),
    { kind: 'launch', ...base, agentId: 'a2', outputFile: null },
    done('a2', 0.75, 0),
    { kind: 'launch', ...base, agentId: 'a3', outputFile: null },
    done('a3', null, 2), // totals, but no price
    { kind: 'launch', ...base, agentId: 'a4', outputFile: null }, // no totals at all: not counted as unpriced
  ];
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true });
  fs.writeFileSync(ledgerFile(dir), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const j = JSON.parse(report(dir, '--json').out);
  assert.equal(j.costTotal, 1);
  assert.equal(j.costCalls, 2);
  assert.equal(j.unpricedCalls, 1);
  assert.equal(j.pricesAsOf, PRICES_AS_OF);
  assert.equal(j.roles[0].costMedian, 0.5);
  assert.equal(j.roles[0].costTotal, 1);
  const text = report(dir).out;
  assert.match(text, /ghorc:implementer opus\/high: calls=4.* model mismatch 0% cost med=\$0\.5000 total=\$1\.00/);
  assert.match(text, new RegExp(`estimated cost: \\$1\\.00 at list prices as of ${PRICES_AS_OF} \\(2 calls priced, 1 without a price\\)`));
});

test('report: a ledger without cost data prints dashes and zero priced calls', () => {
  const dir = tmpProject();
  const l = { ts: '2026-11-24T10:00:00.000Z', session: 's', desc: 'd', role: 'agent', modelReq: null, modelRes: null, effortReq: null, agentId: null, tokens: 10, usage: null, ms: 1, tools: 1 };
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true });
  fs.writeFileSync(ledgerFile(dir), JSON.stringify(l) + '\n');
  const text = report(dir).out;
  assert.match(text, /cost med=- total=-/);
  assert.match(text, /estimated cost: - at list prices as of \d{4}-\d\d-\d\d \(0 calls priced, 1 without a price\)/);
  assert.equal(JSON.parse(report(dir, '--json').out).costTotal, null);
});

test('report: a lazily read outputFile transcript is priced', () => {
  const dir = tmpProject();
  const out = path.join(dir, 'out.jsonl');
  fs.writeFileSync(out, A('m1', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000 }) + '\n'); // 0.044
  const l = { kind: 'launch', ts: '2026-11-24T10:00:00.000Z', session: 's', desc: 'd', role: 'r', modelReq: 'opus', modelRes: 'claude-opus-5-5', effortReq: null, agentId: 'z1', outputFile: out };
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true });
  fs.writeFileSync(ledgerFile(dir), JSON.stringify(l) + '\n');
  const j = JSON.parse(report(dir, '--json').out);
  assert.equal(j.costTotal, 0.044);
  assert.equal(j.costCalls, 1);
});

test('messageCost: fast mode bills twice the standard rate', () => {
  // Opus 5.5 fast: (1000 * 4 + 2000 * 20) * 2 / 1e6 = 0.088
  const c = messageCost('claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000, speed: 'fast' });
  assert.ok(Math.abs(c.usd - 0.088) < 1e-12);
  const s = messageCost('claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000, speed: 'standard' });
  assert.ok(Math.abs(s.usd - 0.044) < 1e-12);
});

test('verdict: CASCADE is a cause for CHANGES_REQUIRED and counts in the report', () => {
  const dir = tmpProject();
  const r = runScript('ledger.cjs', '', { args: ['verdict', 'B1', '1', 'CHANGES_REQUIRED', 'CASCADE'], env: { CLAUDE_PROJECT_DIR: dir }, cwd: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(report(dir).out, /causes: CASCADE=1/);
});
