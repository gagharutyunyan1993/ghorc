'use strict';
// Fix round 2 for the heavy-check slots: every case here failed (or its mutant survived) on 6a03e71.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');
const slots = require('../scripts/lib/slots.cjs');
const { SLOTS_LIB, NODE, hookIn, mkTmp, world, deadPid, exitNode } = require('./slots-helpers.cjs');

const win = process.platform === 'win32';
const claimOf = (name) => ({ session: name, pid: process.pid, ts: Date.now(), heartbeat: Date.now(), minutes: 0, label: name, nonce: `${name}-nonce`, slot: 1 });
const onDisk = (w) => JSON.parse(fs.readFileSync(w.file(1), 'utf8'));

// Runs fn with the slot library pointed at a fresh machine and a short lock wait; the fs seam is restored afterwards.
function inWorld(fn, { wait = '80', slotsCount = 1 } = {}) {
  const w = world({ slots: slotsCount });
  const saved = { ...slots.io };
  const env = { GHORC_TMP: process.env.GHORC_TMP, GHORC_SLOT_LOCK_WAIT_MS: process.env.GHORC_SLOT_LOCK_WAIT_MS };
  process.env.GHORC_TMP = w.tmp;
  process.env.GHORC_SLOT_LOCK_WAIT_MS = wait;
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
const eperm = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted, open`), { code });

// ---- new P1: EPERM / EACCES on the exclusive create count as busy ----

const CHURN = `
const s = require(${JSON.stringify(SLOTS_LIB)});
const end = Date.now() + Number(process.argv[1]);
const nonce = 'n' + process.pid;
let takes = 0;
while (Date.now() < end) {
  const r = s.tryTake(1, { session: 's' + process.pid, pid: process.pid, ts: Date.now(), heartbeat: Date.now(), minutes: 0, label: 'c', nonce, slot: 1 });
  takes++;
  if (r.ok) s.release(1, nonce);
}
console.log('OK ' + takes);
`;

test('P1: six processes taking and releasing one slot for 4 s: nobody dies on EPERM', async () => {
  const w = world({ slots: 1 });
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      new Promise((res) => {
        const c = spawn(NODE, ['-e', CHURN, '4000'], { env: { ...process.env, ...w.env } });
        let out = '';
        let err = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (err += d));
        c.on('close', (code) => res({ code, out: out.trim(), err: err.trim().split('\n')[0] }));
      }),
    ),
  );
  for (const r of results) {
    assert.equal(r.code, 0, `a churn process died: ${r.err}`);
    assert.match(r.out, /^OK \d+$/);
  }
});

test('P1: EPERM or EACCES on the create of the lock is retried until the deadline, then it is busy, never a throw', () => {
  for (const code of ['EPERM', 'EACCES']) {
    inWorld((w, real) => {
      let n = 0;
      slots.io.openSync = (p, flag, ...rest) => {
        if (String(p).endsWith('.lock') && flag === 'wx' && n++ < 3) throw eperm(code);
        return real.openSync(p, flag, ...rest);
      };
      assert.equal(slots.tryTake(1, claimOf('A')).ok, true, `${code} three times, then it works`);
      assert.equal(onDisk(w).nonce, 'A-nonce');
      fs.rmSync(w.file(1));

      slots.io.openSync = (p, flag, ...rest) => {
        if (String(p).endsWith('.lock') && flag === 'wx') throw eperm(code);
        return real.openSync(p, flag, ...rest);
      };
      const t0 = Date.now();
      const r = slots.tryTake(1, claimOf('B'));
      assert.equal(r.ok, false);
      assert.match(r.holder.label, /slot lock busy/);
      assert.ok(Date.now() - t0 >= 60, 'it waited for the lock until the deadline');
      const got = slots.acquire({ slots: 1, minFreeRamGb: 0 }, { session: 's', label: 'x' });
      assert.equal(got.slot, 0);
      assert.match(got.message, /\(slot lock busy\)/, 'busyMessage keeps the label');
    });
  }
});

test('P1: EPERM or EACCES on the create of the claim file is retried, then it is busy, never a throw', () => {
  for (const code of ['EPERM', 'EACCES']) {
    inWorld((w, real) => {
      let n = 0;
      slots.io.openSync = (p, flag, ...rest) => {
        if (String(p).endsWith('slot-1.json') && flag === 'wx' && n++ < 3) throw eperm(code);
        return real.openSync(p, flag, ...rest);
      };
      assert.equal(slots.tryTake(1, claimOf('A')).ok, true, `${code} three times on the claim, then it works`);
      assert.equal(onDisk(w).nonce, 'A-nonce');
      fs.rmSync(w.file(1));

      slots.io.openSync = (p, flag, ...rest) => {
        if (String(p).endsWith('slot-1.json') && flag === 'wx') throw eperm(code);
        return real.openSync(p, flag, ...rest);
      };
      const r = slots.tryTake(1, claimOf('B'));
      assert.equal(r.ok, false);
      assert.match(r.holder.label, /slot lock busy/);
      assert.equal(slots.acquire({ slots: 1, minFreeRamGb: 0 }, { session: 's', label: 'x' }).slot, 0);
      assert.equal(fs.existsSync(slots.lockFile(1)), false, 'the lock was released');
    }, { wait: '2000' });
  }
});

test('P1: another error from the file system (not busy) does not escape tryTake or acquire either', () => {
  inWorld((w, real) => {
    slots.io.openSync = (p, flag, ...rest) => {
      if (flag === 'wx') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.openSync(p, flag, ...rest);
    };
    const r = slots.tryTake(1, claimOf('A'));
    assert.equal(r.ok, false);
    assert.match(r.holder.label, /slot error: ENOSPC/);
    const got = slots.acquire({ slots: 1, minFreeRamGb: 0 }, { session: 's', label: 'x' });
    assert.equal(got.slot, 0);
    assert.match(got.message, /ENOSPC/);
  });
});

test('item 8: the wrapper says "(slot lock busy)" when a fresh lock blocks a free slot (exit 75)', () => {
  const w = world({ slots: 1 });
  fs.mkdirSync(w.dir, { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'slot-1.lock'), `${process.pid} ${Date.now()} held`);
  const r = w.wrap(['run', ...exitNode(0)], { env: { GHORC_SLOT_LOCK_WAIT_MS: '300' } });
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /\(slot lock busy\)/);
  assert.doesNotMatch(r.stderr, /all busy/);
});

// ---- new P2.3 (accepted as a limit) and P2.4: mutants that survived ----

test('P2.4: a stale lock that turns out to belong to someone else is put back, not lost', () => {
  inWorld((w, real) => {
    fs.mkdirSync(w.dir, { recursive: true });
    const lock = slots.lockFile(1);
    fs.writeFileSync(lock, `${deadPid()} ${Date.now() - 5000} tok`);
    const live = `${process.pid} ${Date.now()} live-owner`;
    let swapped = false;
    slots.io.renameSync = (from, to, ...rest) => {
      if (!swapped && from === lock) {
        swapped = true;
        fs.writeFileSync(lock, live); // the breaker read the stale lock; a live owner took the name before the rename
      }
      return real.renameSync(from, to, ...rest);
    };
    const r = slots.tryTake(1, claimOf('B'));
    assert.equal(swapped, true, 'the break path ran');
    assert.equal(r.ok, false, 'the live owner is respected');
    assert.equal(fs.readFileSync(lock, 'utf8'), live, 'its lock was put back');
  });
});

test('P2.4: a lock held by a live process is overridden only after 10 s', () => {
  inWorld((w) => {
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(slots.lockFile(1), `${process.pid} ${Date.now() - 9000} tok`);
    assert.equal(slots.tryTake(1, claimOf('A')).ok, false, '9 s old, owner alive: respected');
    fs.writeFileSync(slots.lockFile(1), `${process.pid} ${Date.now() - 11000} tok`);
    assert.equal(slots.tryTake(1, claimOf('B')).ok, true, '11 s old, owner alive: broken');
    assert.equal(onDisk(w).nonce, 'B-nonce');
  });
});

test('P2.4: the hook lets a heavy command through when the slot directory cannot be read (fail open)', () => {
  const w = world({ slots: 1 }, { heavyCommands: ['^make full'] });
  const notADir = path.join(mkTmp('ghorc-notdir-'), 'file');
  fs.writeFileSync(notADir, 'x');
  const env = { ...w.env, GHORC_TMP: notADir };
  const r = runScript('heavy-check-guard.cjs', hookIn(w.cwd, 'make full'), { env });
  assert.equal(r.code, 0);
  assert.equal(isDeny(r), false);
  assert.equal(r.out.trim(), '');
});

// ---- new P2.2: a program path with a space ----

test('P2.2: run -- "<dir with a space>/prog" runs the program (exit code passes) (POSIX)', { skip: win && 'a POSIX shell script path: not on Windows' }, () => {
  const dir = path.join(mkTmp('ghorc-sp-'), 'with space');
  fs.mkdirSync(dir);
  const prog = path.join(dir, 'prog.sh');
  fs.writeFileSync(prog, '#!/bin/sh\nexit 7\n');
  fs.chmodSync(prog, 0o755);
  for (const w of [world({ slots: 1 }), world(undefined)]) {
    const r = w.wrap(['run', '--', prog]);
    assert.equal(r.status, 7, `${r.stderr} ${r.stdout}`);
  }
});

// ---- new P2.6: matching ----

test('P2.6: a node option before heavy-slot.cjs is looked through', () => {
  const heavy = tmpProject({ heavyCommands: ['^make full'] });
  const sh = (c) => isDeny(runScript('heavy-check-guard.cjs', hookIn(heavy, c, sid(), { agent_id: 'ag1' })));
  for (const c of [
    'node --no-warnings scripts/heavy-slot.cjs run -- make full',
    'node --no-warnings --trace-uncaught scripts/heavy-slot.cjs run --label x -- make full',
    'node --max-old-space-size=4096 "C:\\Program Files\\ghorc\\scripts\\heavy-slot.cjs" run -- make full',
  ]) {
    assert.equal(sh(c), true, c);
  }
  assert.equal(sh('node --no-warnings other.js run -- make full'), false, 'another script');
});

// ---- item 7: windowsHide ----

test('item 7: the wrapper starts its command and kills its tree without a console window', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'heavy-slot.cjs'), 'utf8');
  assert.match(src, /spawn\(launch\.file, launch\.args, \{[^}]*windowsHide: true/);
  assert.match(src, /spawnSync\('taskkill'[^\n]*windowsHide: true/);
});
