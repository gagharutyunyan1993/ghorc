'use strict';
// heavyGuard.agentsWhenFree: with slots on, a subagent or worker may start a heavy command while a slot is free and is
// denied only when all are taken. Default false = only the lead (0.9.0).
const test = require('node:test');
const assert = require('node:assert');
const { runScript, isDeny, sid } = require('./helpers.cjs');
const { hookIn, world, deadPid } = require('./slots-helpers.cjs');

const HEAVY = { heavyCommands: ['^make full'] };
const reasonOf = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
const agent = (w, command = 'make full', session = sid()) => runScript('heavy-check-guard.cjs', hookIn(w.cwd, command, session, { agent_id: 'ag1' }), { env: w.env });
const worker = (w, command = 'make full') => runScript('heavy-check-guard.cjs', hookIn(w.cwd, command), { env: { ...w.env, GHORC_ROLE: 'worker' } });

test('default (key absent or false): an agent is denied "only the lead", whatever the slots say', () => {
  for (const guard of [undefined, { agentsWhenFree: false }, { requireLeadEnv: false }]) {
    const w = world({ slots: 2 }, { ...HEAVY, ...(guard ? { heavyGuard: guard } : {}) });
    const r = agent(w);
    assert.equal(isDeny(r), true, JSON.stringify(guard));
    assert.match(reasonOf(r), /only the lead runs heavy checks/);
    assert.equal(isDeny(worker(w)), true);
  }
  assert.equal(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'lib', 'defaults.json'), 'utf8')).heavyGuard.agentsWhenFree, false);
});

test('agentsWhenFree with slots off (0, absent): still only the lead', () => {
  for (const slots of [{ slots: 0 }, {}]) {
    const w = world(slots, { ...HEAVY, heavyGuard: { agentsWhenFree: true } });
    const r = agent(w);
    assert.equal(isDeny(r), true);
    assert.match(reasonOf(r), /only the lead runs heavy checks/);
  }
});

test('agentsWhenFree with a free slot: an agent and a worker may start a heavy command', () => {
  const w = world({ slots: 2 }, { ...HEAVY, heavyGuard: { agentsWhenFree: true } });
  assert.equal(isDeny(agent(w)), false, 'no claims');
  assert.equal(isDeny(worker(w)), false, 'a worker, no claims');
  w.plant(1, { session: 'lead-session', pid: process.pid, label: 'lead check' });
  assert.equal(isDeny(agent(w)), false, 'one of two taken');
  assert.equal(isDeny(worker(w)), false);
  assert.equal(isDeny(agent(w, 'git status')), false, 'an ordinary command');
});

test('agentsWhenFree with every slot taken: denied, and the text says the slots are full and names the holder', () => {
  const w = world({ slots: 2 }, { ...HEAVY, heavyGuard: { agentsWhenFree: true } });
  w.plant(1, { session: 'abcdef12-lead', pid: process.pid, label: 'nightly full' });
  w.plant(2, { session: 'other-worker', pid: process.pid, label: 'second' });
  for (const r of [agent(w), worker(w)]) {
    assert.equal(isDeny(r), true);
    const reason = reasonOf(r);
    assert.match(reason, /slots are full/);
    assert.match(reason, /abcdef12/);
    assert.match(reason, /nightly full/);
    assert.doesNotMatch(reason, /only the lead/);
  }
});

test('agentsWhenFree: a claim of the agent\'s own parent session does not count as its own; dead and stale claims hold nobody', () => {
  const w = world({ slots: 1 }, { ...HEAVY, heavyGuard: { agentsWhenFree: true } });
  const parent = sid();
  w.plant(1, { session: parent, pid: process.pid, label: 'lead check' });
  assert.equal(isDeny(agent(w, 'make full', parent)), true, 'the lead holds the only slot');
  w.plant(1, { session: parent, pid: deadPid() });
  assert.equal(isDeny(agent(w, 'make full', parent)), false, 'dead claim');
  w.plant(1, { session: 'x', pid: process.pid, heartbeat: Date.now() - 10 * 60000 });
  assert.equal(isDeny(agent(w)), false, 'stale heartbeat');
});

test('agentsWhenFree does not touch the built-in agent denies, nor the lead', () => {
  const w = world({ slots: 1 }, { ...HEAVY, heavyGuard: { agentsWhenFree: true } });
  assert.equal(isDeny(agent(w, 'hc run claude')), true, 'starting an agent is still denied');
  assert.equal(isDeny(agent(w, 'herdr pane run p x')), true);
  w.plant(1, { session: 'other', pid: process.pid });
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full'), { env: w.env })), true, 'the lead is still held by the slot');
});

test('agentsWhenFree: an invalid config still denies the default heavy commands to agents', () => {
  const w = world({ slots: 2 }, { heavyGuard: { agentsWhenFree: true }, nonsenseKey: 1, heavySlots: 'bad' });
  const r = agent(w, 'npm test');
  assert.equal(isDeny(r), true);
});
