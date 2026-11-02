'use strict';
// Fix round 1 for the heavy-check slots: every case here failed on the first version of the slots (e358e75).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');
const slots = require('../scripts/lib/slots.cjs');
const { SLOTS_LIB, NODE, hookIn, mkTmp, world, deadPid, sleepNode, exitNode, wait, waitClaim } = require('./slots-helpers.cjs');

const win = process.platform === 'win32';
const call = (w, command, session, extra) => runScript('heavy-check-guard.cjs', hookIn(w.cwd, command, session, extra), { env: w.env });

// ---- P1.1: the session of a claim ----

test('P1.1: the session is --session, then GHORC_SESSION, then CLAUDE_CODE_SESSION_ID, then pid-<parent pid>', async () => {
  const cases = [
    { args: ['--session', 'from-flag'], env: { GHORC_SESSION: 'from-ghorc', CLAUDE_CODE_SESSION_ID: 'from-claude' }, want: 'from-flag' },
    { args: [], env: { GHORC_SESSION: 'from-ghorc', CLAUDE_CODE_SESSION_ID: 'from-claude' }, want: 'from-ghorc' },
    { args: [], env: { CLAUDE_CODE_SESSION_ID: 'from-claude' }, want: 'from-claude' },
    { args: [], env: {}, want: /^pid-\d+$/ },
  ];
  const runs = cases.map((c) => {
    const w = world({ slots: 1 });
    return { w, c, a: w.wrapAsync(['run', ...c.args, ...sleepNode(9000)], { env: c.env }) };
  });
  const seen = [];
  for (const { w } of runs) seen.push((await waitClaim(w.file(1))).session); // all while the commands still run
  await Promise.all(runs.map((r) => r.a.done));
  runs.forEach(({ c }, i) => {
    if (c.want instanceof RegExp) assert.match(seen[i], c.want);
    else assert.equal(seen[i], c.want);
  });
});

// ---- P1.2 / P1.3: one holder, and the lock around every change ----

const RACER = `
const s = require(${JSON.stringify(SLOTS_LIB)});
const nonce = require('crypto').randomBytes(6).toString('hex');
const AT = Number(process.argv[1]);
const AT2 = Number(process.argv[2]);
while (Date.now() < AT) {}
if (Date.now() >= AT2) { console.log('LATE'); process.exit(0); } // started so late that the winner is gone: not a race
const t = Date.now();
const r = s.tryTake(1, { session: 'p' + process.pid, pid: process.pid, ts: t, heartbeat: t, minutes: 0, label: 'race', nonce, slot: 1 });
const back = Date.now();
while (Date.now() < AT2) {}
// a take that came back after the window ran against a winner that had already exited (its claim was dead): not a race
console.log(back >= AT2 ? 'LATE' : (r.ok ? 'WIN' : 'LOSE') + ' ' + s.owns(1, nonce));
`;

test('P1.2: 6 processes on one dead claim, 15 rounds: exactly one winner in every round', async () => {
  const rounds = [];
  for (let b = 0; b < 3; b++) {
    const batch = [];
    const worlds = Array.from({ length: 5 }, () => world({ slots: 1 }));
    const at = Date.now() + 5000;
    for (let k = 0; k < 5; k++) {
      const w = worlds[k];
      const n = b * 5 + k;
      // a dead pid, or a live pid whose heartbeat went stale
      w.plant(1, n % 2 ? { session: 'ghost', pid: deadPid() } : { session: 'ghost', pid: process.pid, heartbeat: Date.now() - 10 * 60000 });
      const procs = Array.from({ length: 6 }, () =>
        new Promise((res) => {
          const c = spawn(NODE, ['-e', RACER, String(at), String(at + 3000)], { env: { ...process.env, ...w.env } });
          let out = '';
          let err = '';
          c.stdout.on('data', (d) => (out += d));
          c.stderr.on('data', (d) => (err += d));
          // a racer that died shows its exit code and the first line of stderr instead of a result
          c.on('close', (code) => res(code === 0 && !err.trim() ? out.trim() : `CRASH exit ${code}: ${(err.trim().split('\n')[0] || out).slice(0, 200)}`));
        }),
      );
      batch.push(Promise.all(procs).then((r) => ({ n, r })));
    }
    rounds.push(...(await Promise.all(batch)));
  }
  let counted = 0;
  for (const { n, r } of rounds) {
    const verdict = judgeRound(r);
    if (verdict === 'skip') continue;
    counted++;
    assert.equal(verdict, null, `round ${n}: ${verdict}: ${r.join(' | ')}`);
  }
  assert.ok(counted >= 5, `only ${counted} of 15 rounds had racers in the window (machine too loaded)`);
});

// One round of the race: null = fine, 'skip' = nobody raced, otherwise the problem. A winner whose take came back after the
// window is LATE (it won, the others lost to it, and it is gone): a round with a LATE process and no other win is not red.
// Two live holders (two WIN) are, with or without a LATE one.
function judgeRound(r) {
  const raced = r.filter((x) => x !== 'LATE');
  if (!raced.length) return 'skip'; // every process started after the window: nobody raced, nothing to judge
  const wins = raced.filter((x) => x.startsWith('WIN'));
  if (wins.length === 0 && raced.length < r.length) {
    return raced.every((x) => x === 'LOSE false') ? null : 'a late winner and a loser that owns the slot';
  }
  if (wins.length !== 1) return `${wins.length} winners`;
  if (wins[0] !== 'WIN true') return 'the winner does not own the slot at the end';
  if (raced.filter((x) => x === 'LOSE false').length !== raced.length - 1) return 'a loser owns the slot or the counts differ';
  return null;
}

test('P1.2: a round with a LATE winner and no other win is not a failure; two live holders still are', () => {
  assert.equal(judgeRound(['LATE', 'LOSE false', 'LOSE false', 'LOSE false', 'LOSE false', 'LOSE false']), null, 'late winner, the rest lost');
  assert.equal(judgeRound(['WIN true', 'LOSE false', 'LOSE false', 'LATE', 'LOSE false', 'LOSE false']), null, 'ordinary winner, one late process');
  assert.equal(judgeRound(['LATE', 'LATE', 'LATE']), 'skip');
  assert.equal(judgeRound(['WIN true', 'WIN true', 'LOSE false']), '2 winners', 'two live holders');
  assert.equal(judgeRound(['WIN true', 'WIN false', 'LOSE false', 'LATE']), '2 winners', 'two live holders next to a late process');
  assert.notEqual(judgeRound(['LATE', 'LOSE true', 'LOSE false']), null, 'a loser that owns the slot next to a late winner');
  assert.notEqual(judgeRound(['LOSE false', 'LOSE false', 'LOSE false']), null, 'nobody won and nobody was late');
  assert.notEqual(judgeRound(['WIN false', 'LOSE false']), null, 'the winner lost the slot again');
});

// Runs fn with the slot library pointed at a fresh machine and a short lock wait; the fs seam is restored afterwards.
function inWorld(fn, slotsCount = 1) {
  const w = world({ slots: slotsCount });
  const saved = { ...slots.io };
  const env = { GHORC_TMP: process.env.GHORC_TMP, GHORC_SLOT_LOCK_WAIT_MS: process.env.GHORC_SLOT_LOCK_WAIT_MS };
  process.env.GHORC_TMP = w.tmp;
  process.env.GHORC_SLOT_LOCK_WAIT_MS = '80';
  try {
    return fn(w, saved);
  } finally {
    Object.assign(slots.io, saved);
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
}
const claimOf = (name) => ({ session: name, pid: process.pid, ts: Date.now(), heartbeat: Date.now(), minutes: 0, label: name, nonce: `${name}-nonce`, slot: 1 });
const onDisk = (w) => JSON.parse(fs.readFileSync(w.file(1), 'utf8'));

test('P1.2 replay (a): three racers on a dead claim; the removal cannot hand the slot to a second one', () => {
  inWorld((w, real) => {
    w.plant(1, { session: 'ghost', pid: deadPid() });
    const rivals = {};
    let injected = false;
    slots.io.rmSync = (p, ...rest) => {
      if (!injected && p === slots.slotFile(1)) {
        injected = true; // B and C arrive right while A removes the dead claim
        rivals.B = slots.tryTake(1, claimOf('B'));
        rivals.C = slots.tryTake(1, claimOf('C'));
      }
      return real.rmSync(p, ...rest);
    };
    const a = slots.tryTake(1, claimOf('A'));
    assert.equal(injected, true, 'the removal path ran');
    assert.equal(a.ok, true);
    assert.equal(rivals.B.ok, false);
    assert.equal(rivals.C.ok, false);
    assert.equal(onDisk(w).nonce, 'A-nonce');
    assert.equal(slots.owns(1, 'A-nonce'), true);
  });
});

test('P1.2 replay (b): a rival between the exclusive create and the write of the claim finds the slot taken', () => {
  inWorld((w, real) => {
    let rival = null;
    slots.io.writeSync = (fd, data, ...rest) => {
      if (!rival && typeof data === 'string' && data.includes('A-nonce')) rival = slots.tryTake(1, claimOf('B'));
      return real.writeSync(fd, data, ...rest);
    };
    const a = slots.tryTake(1, claimOf('A'));
    assert.equal(a.ok, true);
    assert.equal(rival && rival.ok, false, 'the rival was refused');
    assert.equal(onDisk(w).nonce, 'A-nonce', 'the slot file holds A\'s whole claim');
  });
});

test('P1.2: a slot lock left by a dead process is broken; one held by a live process is respected', () => {
  inWorld((w) => {
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(slots.lockFile(1), `${deadPid()} ${Date.now() - 5000} tok`);
    assert.equal(slots.tryTake(1, claimOf('A')).ok, true, 'stale lock of a dead process');
    fs.rmSync(w.file(1));
    fs.writeFileSync(slots.lockFile(1), `${process.pid} ${Date.now()} tok`);
    const r = slots.tryTake(1, claimOf('B'));
    assert.equal(r.ok, false, 'a live lock holder is waited for, not overridden');
    assert.equal(fs.existsSync(w.file(1)), false);
  });
});

test('P1.3: the heartbeat stops only when the file holds another nonce, never for a missing or unreadable file', () => {
  inWorld((w) => {
    const got = slots.acquire({ slots: 1, minFreeRamGb: 0 }, { session: 's', label: 'x' });
    assert.equal(got.slot, 1);
    const claim = got.claim;
    const beatOf = () => onDisk(w).heartbeat;

    fs.rmSync(w.file(1));
    assert.equal(slots.heartbeat(1, claim), true, 'file missing (renamed away for a moment)');
    assert.equal(fs.existsSync(w.file(1)), false, 'a missing claim is not recreated (release --session stays effective)');

    fs.writeFileSync(w.file(1), '{bad json');
    assert.equal(slots.heartbeat(1, claim), true, 'unreadable');
    assert.equal(fs.readFileSync(w.file(1), 'utf8'), '{bad json', 'an unreadable file is left alone');

    fs.writeFileSync(w.file(1), JSON.stringify({ ...claim, heartbeat: 1 }));
    assert.equal(slots.heartbeat(1, claim), true);
    assert.ok(beatOf() > 1, 'the claim is back: beats continue');

    fs.writeFileSync(w.file(1), JSON.stringify({ ...claim, nonce: 'someone-else' }));
    assert.equal(slots.heartbeat(1, claim), false, 'another nonce: stop');
    assert.equal(onDisk(w).nonce, 'someone-else', 'and the other claim is not touched');
  });
});

// ---- P1.4: the same config lookup as the hook ----

test('P1.4: in a linked worktree the wrapper finds the config of the main checkout, as the hook does', () => {
  const w = world({ slots: 1 });
  const main = mkTmp('ghorc-main-');
  const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
  assert.equal(git(main, 'init', '-q').status, 0);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
  fs.mkdirSync(path.join(main, '.claude'));
  fs.writeFileSync(path.join(main, '.claude', 'ghorc.json'), JSON.stringify({ heavySlots: { slots: 1 }, heavyCommands: ['^make full'] }));
  const linked = mkTmp('ghorc-linked-');
  const add = git(main, 'worktree', 'add', '-q', linked, '-b', 'linked-b');
  assert.equal(add.status, 0, add.stderr);
  assert.equal(fs.existsSync(path.join(linked, '.claude', 'ghorc.json')), false, 'the config exists only in the main checkout');
  w.plant(1, { session: 'other-session', pid: process.pid });
  const env = { CLAUDE_PROJECT_DIR: '' };

  const st = w.wrap(['status'], { cwd: linked, env });
  assert.match(st.stdout, /heavy slots: 1/);
  assert.doesNotMatch(st.stdout, /off/);
  const r = w.wrap(['run', ...exitNode(0)], { cwd: linked, env });
  assert.equal(r.status, 75, r.stderr);
  const h = runScript('heavy-check-guard.cjs', hookIn(linked, 'make full'), { env: { ...w.env, CLAUDE_PROJECT_DIR: '', GHORC_HOOK_GIT_TIMEOUT_MS: '15000' } });
  assert.equal(isDeny(h), true, 'the hook sees the same config');
});

test('P2-1: when the root lookup timed out in git, run and status warn on stderr; the command still runs, its exit code is kept', () => {
  const w = world({ slots: 1 });
  const main = mkTmp('ghorc-main-');
  const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
  assert.equal(git(main, 'init', '-q').status, 0);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
  fs.mkdirSync(path.join(main, '.claude'));
  fs.writeFileSync(path.join(main, '.claude', 'ghorc.json'), JSON.stringify({ heavySlots: { slots: 1 } }));
  const linked = mkTmp('ghorc-linked-');
  assert.equal(git(main, 'worktree', 'add', '-q', linked, '-b', 'linked-t').status, 0);
  const env = { CLAUDE_PROJECT_DIR: '', GHORC_HOOK_GIT_TIMEOUT_MS: '1' }; // git cannot answer in 1 ms
  const st = w.wrap(['status'], { cwd: linked, env });
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /heavy slots: off/, 'the lookup missed the config of the main checkout');
  assert.match(st.stderr, /warning: git did not answer within 1 ms/);
  const r = w.wrap(['run', ...exitNode(7)], { cwd: linked, env });
  assert.equal(r.status, 7, 'the command ran and its exit code is passed');
  assert.match(r.stderr, /warning: git did not answer within 1 ms/);
  // no timeout: no warning
  const ok = w.wrap(['run', ...exitNode(0)], { cwd: linked, env: { CLAUDE_PROJECT_DIR: '' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /warning/);
});

// ---- P1.5: --help and -h belong to the command after -- ----

test('P1.5: -h and --help after -- reach the command; before it they show the help', () => {
  const dir = mkTmp('ghorc-marker-');
  const script = path.join(dir, 'marker.js');
  fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2], process.argv.slice(3).join(' '));");
  for (const w of [world({ slots: 1 }), world(undefined)]) {
    for (const extra of [['-h', '127.0.0.1'], ['--help'], ['-h']]) {
      const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.txt`);
      const r = w.wrap(['run', '--', NODE, script, out, ...extra]);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /heavy-slot\.cjs run/, 'not the wrapper help');
      assert.equal(fs.readFileSync(out, 'utf8'), extra.join(' '), 'the command ran with its arguments');
    }
    assert.match(w.wrap(['run', '--help']).stdout, /heavy-slot\.cjs run/);
    assert.match(w.wrap(['-h']).stdout, /heavy-slot\.cjs run/);
  }
});

// ---- P1.6, P2.7: what the hook lets through ----

test('P1.6: a claim that cannot be parsed does not block the hook (a fresh one, an empty one)', () => {
  const w = world({ slots: 1 }, { heavyCommands: ['^make full'] });
  fs.mkdirSync(w.dir, { recursive: true });
  for (const text of ['{bad json', '']) {
    fs.writeFileSync(w.file(1), text);
    assert.equal(isDeny(call(w, 'make full')), false, JSON.stringify(text));
  }
  fs.writeFileSync(w.file(1), '{bad json');
  assert.equal(w.wrap(['run', ...exitNode(0)]).status, 75, 'the wrapper does wait for it');
});

test('P2.7: the lead\'s own claim on slot 2 passes even when free RAM is low and slot 1 belongs to another session', () => {
  const w = world({ slots: 2, minFreeRamGb: 4 }, { heavyCommands: ['^make full'] });
  const me = sid();
  const env = { ...w.env, GHORC_TEST_FREE_RAM_GB: '1' };
  w.plant(1, { session: 'other', pid: process.pid });
  w.plant(2, { session: me, pid: process.pid });
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full', me), { env })), false, 'own claim');
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full', 'someone-else'), { env })), true, 'another session');
});

// ---- P2.1 - P2.3: matching ----

test('P2.1: with slots off the deny set is not smaller than on v0.7.0 (patterns on the wrappers themselves still match)', () => {
  const cwd = tmpProject({ heavyCommands: ['^timeout\\b', '^xargs\\b', '^nice\\b', '^stdbuf\\b', '^node\\s+\\S*heavy-slot'] });
  const sub = (c) => isDeny(runScript('heavy-check-guard.cjs', hookIn(cwd, c, sid(), { agent_id: 'ag1' })));
  for (const c of ['timeout 5 sleep 1', 'xargs echo', 'nice ls', 'stdbuf -oL ls', 'node scripts/heavy-slot.cjs status', 'env X=1 timeout 5 ls']) {
    assert.equal(sub(c), true, c);
  }
  assert.equal(sub('ls'), false);
});

test('P2.1: for a corpus of commands and patterns, whatever v0.7.0 matched still matches', (t) => {
  const old = spawnSync('git', ['show', 'v0.7.0:scripts/lib/cmd.cjs'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  if (old.status !== 0) return t.skip('tag v0.7.0 not available');
  const file = path.join(mkTmp('ghorc-oldcmd-'), 'cmd-old.cjs');
  fs.writeFileSync(file, old.stdout);
  const oldCmd = require(file);
  const cur = require('../scripts/lib/cmd.cjs');
  const patterns = ['^timeout\\b', '^xargs\\b', '^nice\\b', '^stdbuf\\b', '^env\\b', '^npm\\s+test\\b', '^npm\\s+run\\s+\\S+', '^make\\s+full', '^herdr\\b', '^sleep\\b', '^git\\b', '^bash\\b', '^time\\b', '^node\\b', '^call\\b', '^nohup\\b', '^command\\b', '^vitest\\b', '\\bherdr\\b'];
  const re = cur.compile(patterns);
  const commands = [
    'timeout 5 sleep 1', 'timeout -k 2 30 npm test', 'nice -n 5 make full', 'nice ls herdr pane run', 'stdbuf -oL npm test', 'xargs echo', 'xargs grep herdr',
    'echo a | xargs -n1 npm test', 'env X=1 npm test', 'env -i timeout 5 sleep 1', 'time make full', 'nohup npm test', 'command npm test', 'call npm test', 'exec make full',
    'bash -c "timeout 5 sleep 1"', 'cmd /c npm test', 'FOO=1 nice make full', 'npx vitest run', 'npm --prefix app run test:e2e', 'herdr --session x pane run p hi',
    'herdr pane list', 'timeout 5 herdr pane run p hi', 'git status', 'node scripts/heavy-slot.cjs run -- make full', 'sleep 1 && npm test', 'xargs -p npm test',
  ];
  for (const c of commands) {
    for (let i = 0; i < patterns.length; i++) {
      if (oldCmd.matches(c, [new RegExp(patterns[i], 'i')])) {
        assert.equal(cur.matches(c, [re[i]]), true, `${patterns[i]} on ${c}`);
      }
    }
  }
  for (const c of commands) {
    assert.equal(oldCmd.matches(c, oldCmd.BUILTIN_SUBAGENT_DENY) && !cur.matches(c, cur.BUILTIN_SUBAGENT_DENY), false, `builtin deny: ${c}`);
  }
});

test('P2.1: a wrapper chain five deep is still seen (v0.7.0 peeled 4 rounds)', () => {
  const cur = require('../scripts/lib/cmd.cjs');
  const [re] = cur.compile(['^call\\b']);
  assert.equal(cur.matches('call call call call call x', [re]), true);
  assert.equal(cur.matches('call call call call call npm test', cur.DEFAULT_HEAVY), true);
});

test('P2.2: the slot wrapper with options is looked through', () => {
  const heavy = tmpProject({ heavyCommands: ['^make full'] });
  const sh = (c) => isDeny(runScript('heavy-check-guard.cjs', hookIn(heavy, c, sid(), { agent_id: 'ag1' })));
  for (const c of [
    'node scripts/heavy-slot.cjs run --label=x -- make full',
    'node scripts/heavy-slot.cjs run --label -- make full',
    'node scripts/heavy-slot.cjs run --label "a b" --minutes 5 -- make full',
    'node scripts/heavy-slot.cjs run --minutes=5 --label=x -- make full',
  ]) {
    assert.equal(sh(c), true, c);
  }
});

test('P2.3: only a quoted path to heavy-slot.cjs counts as the slot wrapper', () => {
  const cwd = tmpProject({ heavyCommands: ['^npm\\s+test\\b', '^make full'] });
  const sub = (c) => isDeny(runScript('heavy-check-guard.cjs', hookIn(cwd, c, sid(), { agent_id: 'ag1' })));
  assert.equal(sub('node "x y.js" run -- npm test'), false, 'another quoted script');
  assert.equal(sub('node "x y.js" run --label a -- make full'), false);
  assert.equal(sub('echo "node heavy-slot.cjs run -- make full"'), false, 'text that mentions it');
  assert.equal(sub('node "C:\\Program Files\\ghorc\\scripts\\heavy-slot.cjs" run -- make full'), true);
  assert.equal(sub("node '/opt/my dir/scripts/heavy-slot.cjs' run --label \"a b\" -- npm test"), true);
  assert.equal(sub('node "${CLAUDE_PLUGIN_ROOT}/scripts/heavy-slot.cjs" run -- make full'), true);
});

// ---- P2.4: the arguments reach the command unchanged ----

const ARGV_PRINTER = "process.stdout.write(JSON.stringify(process.argv.slice(2)));";
const TRICKY = ['a&echo INJECTED', '', 'a b', 'say "hi"', 'x|y', '(p)', '^c', '!bang!', 'tail\\', 'a;b', 'a,b', "it's", 'a>b', '*?'];

test('P2.4: arguments reach an .exe unchanged, slots on and off', () => {
  const dir = mkTmp('ghorc-argv-');
  const script = path.join(dir, 'argv.js');
  fs.writeFileSync(script, ARGV_PRINTER);
  for (const w of [world({ slots: 1 }), world(undefined)]) {
    const args = [...TRICKY, '%PATH%x'];
    const r = w.wrap(['run', '--', NODE, script, ...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args);
    assert.equal(w.wrap(['run', '--', NODE, '-e', '']).status, 0, 'an empty script argument is kept');
  }
});

test('P2.4: one string with spaces is a shell line; an argument list is not', () => {
  const w = world({ slots: 1 });
  assert.equal(w.wrap(['run', '--', `"${NODE}" -e "process.exit(7)"`]).status, 7, 'one string: the shell runs it');
  const dir = mkTmp('ghorc-shell-');
  const marker = path.join(dir, 'm.txt');
  const r = w.wrap(['run', '--', NODE, '-e', 'process.exit(0)', '&&', NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), false, '&& in an argument list is an argument, not a shell operator');
});

// ---- P2.5: signals (POSIX; on Windows only Ctrl-C reaches a handler, process.kill ends the wrapper at once) ----

for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
  test(`P2.5: ${sig} releases the slot, stops the command and exits ${code} (POSIX)`, { skip: win && 'signals reach handlers only from the console on Windows' }, async () => {
    const w = world({ slots: 1 });
    const dir = mkTmp('ghorc-sig-');
    const pidFile = path.join(dir, 'child.pid');
    const prog = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(()=>{}, 60000)`;
    const a = w.wrapAsync(['run', '--', NODE, '-e', prog]);
    for (let i = 0; i < 800 && !fs.existsSync(pidFile); i++) await wait(25); // the command writes its pid when it runs
    assert.equal(fs.existsSync(w.file(1)), true, 'the slot is held');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    a.child.kill(sig);
    const r = await a.done;
    assert.equal(r.code, code);
    assert.equal(fs.existsSync(w.file(1)), false, 'released');
    await wait(500);
    assert.equal(require('../scripts/lib/tmp.cjs').isAlive(childPid), false, 'the command was stopped');
  });
}

// ---- P2.6: status shows the whole id; minutes ----

test('P2.6: status prints the full session id, and release --session with that id frees the slot', () => {
  const w = world({ slots: 1 });
  const id = 'c190360b-1f3a-4d6e-9a7b-0123456789ab';
  w.plant(1, { session: id, pid: process.pid, label: 'stuck' });
  const st = w.wrap(['status']).stdout;
  assert.ok(st.includes(`session ${id},`), st);
  assert.match(w.wrap(['release', '--session', id]).stdout, /released 1 /);
  assert.equal(fs.existsSync(w.file(1)), false);
  assert.equal(w.wrap(['run', ...exitNode(0)]).status, 0);
});

test('P2.6: a live claim past its minutes is reported by status and the message, and is not removed', () => {
  const w = world({ slots: 1 }, { heavyCommands: ['^make full'] });
  w.plant(1, { session: 'slow-one', pid: process.pid, minutes: 1, ts: Date.now() - 5 * 60000 });
  const st = w.wrap(['status']).stdout;
  assert.match(st, /over its 1 min/);
  assert.match(st, /live/);
  const r = w.wrap(['run', ...exitNode(0)]);
  assert.equal(r.status, 75, 'still holds the slot');
  assert.match(r.stderr, /over its 1 min/);
  assert.equal(fs.existsSync(w.file(1)), true, 'not removed');
  const h = call(w, 'make full', 'another');
  assert.equal(isDeny(h), true);
  assert.match(JSON.parse(h.out).hookSpecificOutput.permissionDecisionReason, /over its 1 min/);
  w.plant(1, { session: 'quick', pid: process.pid, minutes: 30 });
  assert.doesNotMatch(w.wrap(['status']).stdout, /over its/);
});
