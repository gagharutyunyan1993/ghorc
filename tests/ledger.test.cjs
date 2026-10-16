'use strict';
// 0.6 call ledger: hook line, no prompt leak, fail-silent, verdict validation, report aggregates.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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
  for (const bad of [[], ['E1'], ['E1', '0', 'ACCEPT'], ['E1', 'x', 'ACCEPT'], ['E1', '1', 'MAYBE'], ['E1', '1', 'CHANGES_REQUIRED', 'WHY'], ['E1', '1', 'ACCEPT', 'OTHER', 'extra']]) {
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
  assert.deepEqual(j.packages.find((p) => p.pkg === 'E2'), { pkg: 'E2', rounds: 2, firstVerdict: 'CHANGES_REQUIRED', firstCause: 'BRIEF_OMISSION' });
  const text = run().out;
  assert.match(text, /ghorc:implementer: calls=5 tokens med=300 q3=400/);
  assert.match(text, /first-round ACCEPT rate: 50% \(2 packages\)/);
  // --since drops the call lines (all earlier than 11:00) and keeps verdicts
  const since = JSON.parse(run('--since', '2026-10-16T10:30:00Z', '--json').out);
  assert.equal(since.calls, 0);
  assert.equal(since.packages.length, 2);
});
