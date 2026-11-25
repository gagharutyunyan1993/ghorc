'use strict';
// Main sessions in the ledger: SessionStart writes a session line, SessionEnd a totals snapshot, and the report prices the
// lead and tab workers from their transcripts (named by -n, deduplicated across a resume, sidechains never counted).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpProject, bareProject } = require('./helpers.cjs');

const ledgerFile = (dir) => path.join(dir, '.claude', 'ghorc-out', 'ledger.jsonl');
const lines = (dir) => fs.readFileSync(ledgerFile(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const env = (dir, extra = {}) => ({ CLAUDE_PROJECT_DIR: dir, GHORC_NO_AUTOSTART: '1', ...extra });
const report = (dir) => JSON.parse(runScript('ledger.cjs', '', { args: ['report', '--json'], env: env(dir), cwd: dir }).out);

// Opus 5.5: 1000 in + 2000 out = 0.004 + 0.04 = 0.044
const A = (id, extra = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-24T10:00:00.000Z', ...extra, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 2000 }, content: [{ type: 'text', text: 'PRIVATE' }] } });
const title = (t) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 'x' });

function transcript(dir, name, rows) {
  const f = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(f, rows.join('\n') + '\n');
  return f;
}
const start = (dir, sid, file, role) =>
  runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid, cwd: dir, transcript_path: file, source: 'startup' }, { env: env(dir, role ? { GHORC_ROLE: role } : {}), cwd: dir });

test('SessionStart writes a session line in an opted-in project only, never for a subagent', () => {
  const dir = tmpProject();
  const f = transcript(dir, 's1', [A('m1')]);
  start(dir, 's1', f, 'worker');
  const l = lines(dir).filter((x) => x.kind === 'session');
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].session, l[0].role, l[0].transcript, l[0].source], ['s1', 'worker', f, 'startup']);
  const bare = bareProject();
  start(bare, 's2', transcript(bare, 's2', [A('m1')]));
  assert.equal(fs.existsSync(ledgerFile(bare)), false);
});

test('report: the lead and a named worker are their own rows; a resume and sidechains are not counted twice', () => {
  const dir = tmpProject();
  const lead = transcript(dir, 'lead', [A('m1'), A('m2'), A('side', { isSidechain: true })]);
  const resumed = transcript(dir, 'resumed', [A('m1'), A('m2'), A('m3')]); // a resume copies m1, m2
  const worker = transcript(dir, 'worker', [title('p3-implementer'), A('w1')]);
  start(dir, 'L1', lead, 'lead');
  start(dir, 'L2', resumed, 'lead');
  start(dir, 'W1', worker, 'worker');
  const r = report(dir);
  assert.equal(r.calls, 0, 'session lines are not agent calls');
  const lead1 = r.sessions.find((s) => s.kind === 'lead');
  assert.equal(lead1.sessions, 2);
  assert.equal(lead1.costTotal, 0.132, 'm1, m2, m3 once each; the sidechain row not at all');
  const impl = r.sessions.find((s) => s.kind === 'implementer');
  assert.equal(impl.costTotal, 0.044);
  assert.equal(impl.models, 'claude-opus-5-5');
  assert.equal(r.sessionsCostTotal, 0.176);
  assert.equal(r.costTotalAll, 0.176);
  const text = runScript('ledger.cjs', '', { args: ['report'], env: env(dir), cwd: dir }).out;
  assert.match(text, /implementer claude-opus-5-5: sessions=1 .* total=\$0\.04/);
  assert.match(text, /estimated cost with sessions: \$0\.18/);
  assert.ok(!fs.readFileSync(ledgerFile(dir), 'utf8').includes('PRIVATE'));
});

test('SessionEnd writes a snapshot; the report falls back to it when the transcript is gone', () => {
  const dir = tmpProject();
  const f = transcript(dir, 'gone', [title('lead-x'), A('m1')]);
  start(dir, 'G1', f, '');
  runScript('ledger.cjs', { hook_event_name: 'SessionEnd', session_id: 'G1', cwd: dir, transcript_path: f }, { args: ['end'], env: env(dir) });
  const snap = lines(dir).find((x) => x.kind === 'sessionEnd');
  assert.equal(snap.cost, 0.044);
  assert.equal(snap.title, 'lead-x');
  fs.unlinkSync(f);
  const r = report(dir);
  assert.deepEqual([r.sessions[0].kind, r.sessions[0].costTotal, r.sessions[0].fromSnapshot], ['lead', 0.044, 1]);
  // a subagent never writes a snapshot
  runScript('ledger.cjs', { hook_event_name: 'SessionEnd', session_id: 'G2', agent_id: 'a', cwd: dir, transcript_path: f }, { args: ['end'], env: env(dir) });
  assert.equal(lines(dir).filter((x) => x.kind === 'sessionEnd').length, 1);
});
