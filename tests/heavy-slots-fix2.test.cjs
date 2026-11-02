'use strict';
// Fix round 2 for the heavy-check slots: every case here failed (or its mutant survived) on 6a03e71.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');
const slots = require('../scripts/lib/slots.cjs');
const cmd = require('../scripts/lib/cmd.cjs');
const { buildSpawn } = require('../scripts/lib/runcmd.cjs');
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

test('P2.4: cmd.exe scripts refuse a CR or LF in an argument (and a %)', () => {
  const exists = (f) => f === 'C:\\bin\\npm.cmd';
  const env = { PATH: 'C:\\bin', PATHEXT: '.exe;.cmd' };
  for (const bad of ['a\nb', 'a\rb', 'a\r\nb', '100%', '%PATH%']) {
    assert.throws(() => buildSpawn(['npm', 'run', bad], { platform: 'win32', env, exists }), /cannot be passed unchanged/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => buildSpawn(['npm', 'run', 'a b'], { platform: 'win32', env, exists }));
});

test('P2.4: the segment as written is always tried (patterns on the wrapper itself keep matching)', () => {
  const t = (command, pattern) => cmd.matches(command, cmd.compile([pattern]));
  for (const [command, pattern] of [
    ['env X=1 npm test', '^env\\b'],
    ['time make full', '^time\\b'],
    ['nohup npm test', '^nohup\\b'],
    ['call npm test', '^call\\b'],
    ['command npm test', '^command\\b'],
    ['bash -c "make full"', '^bash\\b'],
    ['cmd /c npm test', '^cmd\\b'],
  ]) {
    assert.equal(t(command, pattern), true, `${pattern} on ${command}`);
  }
  assert.equal(t('echo env', '^env\\b'), false);
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

// ---- new P2.1 / P2.5: shims, real cmd.exe ----

// 36 arguments that carry every cmd.exe metacharacter, with and without a quote
const TABLE = [
  'a&echo INJECTED', '"&echo INJECTED', 'a"^b', 'x"|y', '"', '""', '"a b"', 'a b', 'say "hi"', 'x|y', '(p)', '^c', '^^', '!bang!', 'tail\\', 'a\\"b',
  '\\"', 'a;b', 'a,b', "it's", 'a>b', 'a<b', 'a&&b', 'a||b', '*?', 'a=b', ' ', '', '`x`', '$(x)', '{x}', '[x]', 'a#b', '~', '"&|<>^"', '"; echo INJECTED',
];
const ARGV_PRINTER = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));';

function makeShims() {
  const dir = mkTmp('ghorc-shims-');
  fs.writeFileSync(path.join(dir, 'argv.js'), ARGV_PRINTER);
  const body = `@"${NODE}" "%~dp0argv.js" %*\r\n`;
  const inBin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(inBin, { recursive: true });
  fs.writeFileSync(path.join(dir, 'outside.cmd'), body);
  fs.writeFileSync(path.join(inBin, 'inside.cmd'), `@"${NODE}" "%~dp0..\\..\\argv.js" %*\r\n`);
  return { dir, inBin };
}

const META_ARG = /[&|<>^"!()]/;

test('P2.1: a shim under node_modules/.bin gets all 36 arguments unchanged; one outside it the plain ones, and refuses the rest (Windows)', { skip: !win && 'cmd.exe only exists on Windows' }, () => {
  const { dir, inBin } = makeShims();
  const env = { PATH: `${dir};${inBin};${process.env.PATH}` };
  const w = world(undefined);
  const r = w.wrap(['run', '--', 'inside', ...TABLE], { env });
  assert.equal(r.status, 0, `inside: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), TABLE, 'inside');
  const plain = TABLE.filter((a) => !META_ARG.test(a));
  const o = w.wrap(['run', '--', 'outside', ...plain], { env });
  assert.equal(o.status, 0, `outside: ${o.stderr}`);
  assert.deepEqual(JSON.parse(o.stdout), plain, 'outside, no metacharacter');
  for (const bad of TABLE.filter((a) => META_ARG.test(a))) {
    const x = w.wrap(['run', '--', 'outside', bad], { env });
    assert.equal(x.status, 2, `outside ${JSON.stringify(bad)}: ${x.stdout}${x.stderr}`);
    assert.equal(x.stdout, '');
  }
});

test('P2.1: the quote-plus-metacharacter injection through a shim outside .bin is refused, through npm it arrives whole (Windows)', { skip: !win && 'cmd.exe only exists on Windows' }, () => {
  const { dir } = makeShims();
  const marker = path.join(dir, 'injected.txt');
  const w = world(undefined);
  const r = w.wrap(['run', '--', 'outside', `"&echo X>${marker}`], { env: { PATH: `${dir};${process.env.PATH}` } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot be passed unchanged/);
  assert.equal(fs.existsSync(marker), false, 'the shell did not run the tail of the argument');
  assert.equal(r.stdout, '');
});

test('P2.1: buildSpawn escapes a metacharacter argument twice for a %* shim, and refuses it for any other .cmd', () => {
  const env = { PATH: 'C:\\g', PATHEXT: '.exe;.cmd', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const plan = (file) => buildSpawn([file, 'a&b', 'q"x'], { platform: 'win32', env, exists: (f) => f === file }).args[3];
  for (const known of ['C:\\p\\node_modules\\.bin\\tool.cmd', 'C:\\g\\npm.cmd', 'C:\\g\\npx.cmd', 'C:\\g\\pnpm.cmd', 'C:\\g\\yarn.cmd']) {
    assert.match(plan(known), /\^\^\^&/, `${known}: the & is escaped for the two readings`);
  }
  for (const other of ['C:\\g\\tool.cmd', 'C:\\g\\mynpm.cmd', 'C:\\p\\node_modules\\tool.cmd']) {
    assert.throws(() => plan(other), /cannot be passed unchanged/, other);
  }
});

test('P2.5: a path with forward slashes to a shim is normalised for cmd.exe (the leading .\\ stays)', () => {
  const exists = (f) => f === './bin/node_modules/.bin/plainl.cmd';
  const env = { PATH: '', PATHEXT: '.exe;.cmd', ComSpec: 'cmd.exe' };
  const b = buildSpawn(['./bin/node_modules/.bin/plainl', 'x'], { platform: 'win32', env, exists });
  assert.match(b.args[3], /^"\.\\bin\\node_modules\\\.bin\\plainl\.cmd /, b.args[3]);
  assert.doesNotMatch(b.args[3], /\//);
});

test('P2.5: run -- ./sub/shim x works through cmd.exe (Windows)', { skip: !win && 'cmd.exe only exists on Windows' }, () => {
  const dir = mkTmp('ghorc-fwd-');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'argv.js'), ARGV_PRINTER);
  fs.writeFileSync(path.join(dir, 'sub', 'plainl.cmd'), `@"${NODE}" "%~dp0argv.js" %*\r\n`);
  const w = world(undefined);
  const r = w.wrap(['run', '--', './sub/plainl', 'x y'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['x y']);
});

// ---- new P2.2: a program path with a space ----

test('P2.2: one word that is an existing file takes the argument-list path', () => {
  const exists = (f) => f === 'C:\\Program Files\\x\\tool.exe' || f === '/opt/my dir/tool';
  assert.deepEqual(buildSpawn(['C:\\Program Files\\x\\tool.exe'], { platform: 'win32', env: { PATH: '' }, exists }), {
    file: 'C:\\Program Files\\x\\tool.exe',
    args: [],
    options: {},
  });
  assert.deepEqual(buildSpawn(['/opt/my dir/tool'], { platform: 'linux', exists }), { file: '/opt/my dir/tool', args: [], options: {} });
  assert.deepEqual(buildSpawn(['npm run a && npm run b'], { platform: 'linux', exists }), { file: 'npm run a && npm run b', args: [], options: { shell: true } });
  assert.deepEqual(buildSpawn(['/opt/my dir/tool arg'], { platform: 'linux', exists }).options, { shell: true }, 'not a file: a shell line');
});

test('P2.2: run -- "<dir with a space>/prog" runs the program (exit code passes)', () => {
  const dir = path.join(mkTmp('ghorc-sp-'), 'with space');
  fs.mkdirSync(dir);
  const prog = path.join(dir, win ? 'prog.cmd' : 'prog.sh');
  fs.writeFileSync(prog, win ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n');
  if (!win) fs.chmodSync(prog, 0o755);
  for (const w of [world({ slots: 1 }), world(undefined)]) {
    const r = w.wrap(['run', '--', prog]);
    assert.equal(r.status, 7, `${r.stderr} ${r.stdout}`);
  }
});

// ---- new P2.6: matching ----

test('P2.6: xargs --max-lines and a node option before heavy-slot.cjs are looked through', () => {
  const heavy = tmpProject({ heavyCommands: ['^make full'] });
  const sh = (c) => isDeny(runScript('heavy-check-guard.cjs', hookIn(heavy, c, sid(), { agent_id: 'ag1' })));
  for (const c of [
    'echo p | xargs --max-lines make full',
    'echo p | xargs --max-lines=2 make full',
    'echo p | xargs --max-lines herdr pane run p hi',
    'echo p | xargs --max-lines=2 herdr pane run p hi',
    'echo p | xargs --max-args 1 make full',
    'node --no-warnings scripts/heavy-slot.cjs run -- make full',
    'node --no-warnings --trace-uncaught scripts/heavy-slot.cjs run --label x -- make full',
    'node --max-old-space-size=4096 "C:\\Program Files\\ghorc\\scripts\\heavy-slot.cjs" run -- make full',
  ]) {
    assert.equal(sh(c), true, c);
  }
  assert.equal(sh('node --no-warnings other.js run -- make full'), false, 'another script');
  assert.equal(sh('echo p | xargs --max-lines echo hi'), false);
});

// ---- item 7: windowsHide ----

test('item 7: the wrapper starts its command and kills its tree without a console window', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'heavy-slot.cjs'), 'utf8');
  assert.match(src, /spawn\(launch\.file, launch\.args, \{[^}]*windowsHide: true/);
  assert.match(src, /spawnSync\('taskkill'[^\n]*windowsHide: true/);
});
