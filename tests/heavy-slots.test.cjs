'use strict';
// Heavy-check slots: scripts/heavy-slot.cjs (the lock), lib/slots.cjs and the hint in heavy-check-guard.cjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');
const slots = require('../scripts/lib/slots.cjs');
const { hookIn, world, deadPid, exitedPid, sleepNode, exitNode, wait, waitClaim } = require('./slots-helpers.cjs');

test('slots are off by default: no config and an empty config run the command without a claim', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'defaults.json'), 'utf8'));
  assert.deepEqual(defaults.heavySlots, { slots: 0, minFreeRamGb: 0 });
  for (const w of [world(undefined), world({})]) {
    const r = w.wrap(['run', '--label', 'x', ...exitNode(0)]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(w.dir), false, 'no claim directory');
    assert.match(w.wrap(['status']).stdout, /off/);
  }
  const cwd = tmpProject({ heavyCommands: ['^make full'] });
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(cwd, 'make full'))), false);
});

test('the exit code of the command passes through, and the slot is released on a non-zero exit', () => {
  const w = world({ slots: 1 });
  for (const code of [0, 3, 42]) {
    const r = w.wrap(['run', '--label', 'x', ...exitNode(code)]);
    assert.equal(r.status, code, r.stderr);
    assert.equal(fs.existsSync(w.file(1)), false, `released after exit ${code}`);
  }
  const r = w.wrap(['run', '--', 'ghorc-no-such-command-xyz']);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(w.file(1)), false, 'released when the command cannot start');
});

test('the claim holds { session, pid, ts, heartbeat, minutes, label } and the heartbeat is refreshed while it runs', async () => {
  const w = world({ slots: 1 });
  const a = w.wrapAsync(['run', '--label', 'full check', '--session', 'sess-A', ...sleepNode(4000)], { env: { GHORC_SLOT_HEARTBEAT_MS: '100' } });
  const first = await waitClaim(w.file(1));
  await wait(500);
  const second = JSON.parse(fs.readFileSync(w.file(1), 'utf8'));
  for (const k of ['session', 'pid', 'ts', 'heartbeat', 'minutes', 'label']) assert.ok(k in first, k);
  assert.equal(first.session, 'sess-A');
  assert.equal(first.label, 'full check');
  assert.ok(second.heartbeat > first.heartbeat, 'heartbeat moved');
  assert.equal(second.ts, first.ts, 'ts stays the start time');
  assert.equal((await a.done).code, 0);
  assert.equal(fs.existsSync(w.file(1)), false);
});

test('two wrappers on one slot: one runs, the other exits 75 naming the holder, its label and age', async () => {
  const w = world({ slots: 1 });
  const a = w.wrapAsync(['run', '--label', 'first-check', '--session', 'aaaaaaaa-1111', ...sleepNode(5000)]);
  await waitClaim(w.file(1));
  const b = w.wrap(['run', '--label', 'second', '--session', 'bbbb', ...exitNode(0)]);
  assert.equal(b.status, 75, b.stderr);
  assert.match(b.stderr, /no free heavy-check slot/);
  assert.match(b.stderr, /aaaaaaaa/);
  assert.match(b.stderr, /first-check/);
  assert.match(b.stderr, /\d+s ago/);
  assert.equal((await a.done).code, 0);
  assert.equal(w.wrap(['run', ...exitNode(0)]).status, 0, 'free again after the holder ended');
});

test('a claim with a dead pid is removed and the slot is taken', () => {
  const w = world({ slots: 1 });
  w.plant(1, { session: 'ghost', pid: deadPid() });
  assert.match(w.wrap(['status']).stdout, /dead/);
  const r = w.wrap(['run', '--label', 'x', ...exitNode(0)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(w.file(1)), false);
});

test('a claim with a stale heartbeat is removed even when its pid is alive; a fresh one blocks', () => {
  const w = world({ slots: 1 });
  w.plant(1, { session: 'old', pid: process.pid, heartbeat: Date.now() - 10 * 60000 });
  assert.equal(w.wrap(['run', ...exitNode(0)]).status, 0, 'stale heartbeat');
  w.plant(1, { session: 'live', pid: process.pid });
  assert.equal(w.wrap(['run', ...exitNode(0)]).status, 75, 'live pid and fresh heartbeat');
  w.plant(1, { session: 'live', pid: process.pid, heartbeat: Date.now() - 4000 });
  assert.equal(w.wrap(['run', ...exitNode(0)], { env: { GHORC_SLOT_STALE_MS: '3000' } }).status, 0, 'GHORC_SLOT_STALE_MS shortens the limit');
});

test('pid liveness works on this platform: own pid is alive, an exited one is not', () => {
  const { isAlive } = require('../scripts/lib/tmp.cjs');
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(deadPid()), false);
  assert.equal([exitedPid(), exitedPid(), exitedPid()].some((p) => !isAlive(p)), true, 'the pid of a process that has exited');
  assert.equal(slots.isLive({ claim: { pid: deadPid(), heartbeat: Date.now() }, mtimeMs: Date.now() }), false);
  assert.equal(slots.isLive({ claim: { pid: process.pid, heartbeat: Date.now() }, mtimeMs: Date.now() }), true);
});

test('RAM gate: low free RAM denies the slots above the first, not the first', () => {
  const w = world({ slots: 2, minFreeRamGb: 4 });
  assert.equal(w.wrap(['run', ...exitNode(0)], { env: { GHORC_TEST_FREE_RAM_GB: '1' } }).status, 0, 'slot 1 needs no RAM');
  w.plant(1, { session: 'other', pid: process.pid });
  const low = w.wrap(['run', ...exitNode(0)], { env: { GHORC_TEST_FREE_RAM_GB: '1' } });
  assert.equal(low.status, 75, low.stderr);
  assert.match(low.stderr, /RAM/);
  assert.match(low.stderr, /minFreeRamGb 4/);
  const ok = w.wrap(['run', ...exitNode(0)], { env: { GHORC_TEST_FREE_RAM_GB: '16' } });
  assert.equal(ok.status, 0, ok.stderr);
  // the hook agrees
  const hw = world({ slots: 2, minFreeRamGb: 4 }, { heavyCommands: ['^make full'] });
  hw.plant(1, { session: 'other', pid: process.pid });
  const s = sid();
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(hw.cwd, 'make full', s), { env: { ...hw.env, GHORC_TEST_FREE_RAM_GB: '1' } })), true);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(hw.cwd, 'make full', s), { env: { ...hw.env, GHORC_TEST_FREE_RAM_GB: '16' } })), false);
});

test('hook: the lead is denied a heavy command while every slot holds a live claim of another session', async () => {
  const w = world({ slots: 1 }, { heavyCommands: ['^make full', '^npm\\s+run\\s+test:e2e'] });
  const me = sid();
  const call = (command, session = me, extra) => runScript('heavy-check-guard.cjs', hookIn(w.cwd, command, session, extra), { env: w.env });

  assert.equal(isDeny(call('make full')), false, 'no claims');
  w.plant(1, { session: 'abcdef12-other', pid: process.pid, label: 'nightly full' });
  const r = call('make full');
  assert.equal(isDeny(r), true);
  const reason = JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /abcdef12/);
  assert.match(reason, /nightly full/);
  assert.match(reason, /\d+s ago/);
  assert.equal(isDeny(call('git status')), false, 'an ordinary command');
  assert.equal(isDeny(call('cd app && make full')), true, 'a heavy command inside a chain');

  // own claim: made by the real wrapper with no --session and no GHORC_SESSION, only the session id Claude Code puts in the environment
  fs.rmSync(w.file(1));
  const mine = w.wrapAsync(['run', '--label', 'mine', ...sleepNode(8000)], { env: { CLAUDE_CODE_SESSION_ID: me } });
  assert.equal((await waitClaim(w.file(1))).session, me, 'the wrapper took the session from the environment');
  assert.equal(isDeny(call('make full')), false, 'own claim does not block');
  assert.equal(isDeny(call('make full', 'another-session')), true, 'another session is blocked by it');
  mine.child.kill();
  await mine.done;
  w.plant(1, { session: 'abcdef12-other', pid: deadPid() });
  assert.equal(isDeny(call('make full')), false, 'dead claim holds nobody');
  w.plant(1, { session: 'abcdef12-other', pid: process.pid, heartbeat: Date.now() - 10 * 60000 });
  assert.equal(isDeny(call('make full')), false, 'stale heartbeat holds nobody');
});

test('hook: two slots, one free means no deny; slots off or an unparseable claim does not block', () => {
  const w = world({ slots: 2 }, { heavyCommands: ['^make full'] });
  w.plant(1, { session: 'other', pid: process.pid });
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full'), { env: w.env })), false, 'slot 2 is free');
  w.plant(2, { session: 'third', pid: process.pid });
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full'), { env: w.env })), true, 'both taken');

  const off = world({ slots: 0 }, { heavyCommands: ['^make full'] });
  off.plant(1, { session: 'other', pid: process.pid });
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(off.cwd, 'make full'), { env: off.env })), false, 'slots off');

  // a claim that cannot be parsed (empty, or cut in the middle) does not block the hook
  const bad = world({ slots: 1 }, { heavyCommands: ['^make full'] });
  fs.mkdirSync(bad.dir, { recursive: true });
  for (const text of ['', '{bad json', '{"session":"x",']) {
    fs.writeFileSync(bad.file(1), text);
    const r = runScript('heavy-check-guard.cjs', hookIn(bad.cwd, 'make full'), { env: bad.env });
    assert.equal(r.code, 0);
    assert.equal(isDeny(r), false, 'unparseable claim ' + JSON.stringify(text));
  }
});

test('hook: subagents and workers are still denied as before, with or without slots', () => {
  const w = world({ slots: 1 }, { heavyCommands: ['^make full'] });
  const r = runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full', sid(), { agent_id: 'ag1' }), { env: w.env });
  assert.equal(isDeny(r), true);
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /only the lead/);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full'), { env: { ...w.env, GHORC_ROLE: 'worker' } })), true);
});

test('the wrapper does not hide a heavy command from a subagent: heavyCommands are matched after `--`', () => {
  const cwd = tmpProject({ heavyCommands: ['^npm\\s+run\\s+test:e2e\\b', '^make full'] });
  const call = (command) => runScript('heavy-check-guard.cjs', hookIn(cwd, command, sid(), { agent_id: 'ag1' }));
  for (const c of [
    'node scripts/heavy-slot.cjs run --label full -- npm run test:e2e',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/heavy-slot.cjs" run --label "full check" -- make full',
    'node /p/ghorc/scripts/heavy-slot.cjs run -- make full',
  ]) {
    assert.equal(isDeny(call(c)), true, c);
  }
  assert.equal(isDeny(call('node scripts/heavy-slot.cjs status')), false);
  assert.equal(isDeny(call('node scripts/heavy-slot.cjs run -- git status')), false);
});

test('heavySlots.slots above 8 is clipped to 8 with a warning; unusable values switch slots off', () => {
  const c = slots.slotConfig({ heavySlots: { slots: 12, minFreeRamGb: 3 } });
  assert.equal(c.slots, 8);
  assert.equal(c.minFreeRamGb, 3);
  assert.match(c.warning, /clipped to 8/);
  assert.equal(slots.slotConfig({ heavySlots: { slots: 8 } }).warning, '');
  assert.equal(slots.slotConfig({ heavySlots: { slots: 3 } }).slots, 3);
  for (const bad of [-1, 1.5, 'x', null]) {
    assert.equal(slots.slotConfig({ heavySlots: { slots: bad } }).slots, 0, String(bad));
  }
  assert.equal(slots.slotConfig({}).slots, 0);
  const w = world({ slots: 12 });
  const st = w.wrap(['status']);
  assert.match(st.stderr, /clipped to 8/);
  assert.match(st.stdout, /heavy slots: 8/);
  assert.equal((st.stdout.match(/slot \d+: free/g) || []).length, 8);
});

test('status lists holders; release --session removes the claims of that session only', () => {
  const w = world({ slots: 3 });
  w.plant(1, { session: 'keep-me', pid: process.pid, label: 'kept' });
  w.plant(2, { session: 'drop-me', pid: process.pid, label: 'dropped' });
  const st = w.wrap(['status']).stdout;
  assert.match(st, /slot 1: session keep-me, "kept"/);
  assert.match(st, /slot 2: session drop-me, "dropped".*live/);
  assert.match(st, /slot 3: free/);
  assert.match(w.wrap(['release', '--session', 'drop-me']).stdout, /released 1/);
  assert.equal(fs.existsSync(w.file(2)), false);
  assert.equal(fs.existsSync(w.file(1)), true);
  assert.equal(w.wrap(['release']).status, 2, '--session is required');
});

test('GHORC_SESSION names the session of a claim', async () => {
  const w = world({ slots: 1 });
  const a = w.wrapAsync(['run', ...sleepNode(3000)], { env: { GHORC_SESSION: 'from-env' } });
  assert.equal((await waitClaim(w.file(1))).session, 'from-env');
  await a.done;
});
