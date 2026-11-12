'use strict';
// What heavy-slot.cjs run does with its command:
//  - one string with whitespace: a shell line, run by the shell;
//  - an argument list: no shell; on Windows a .cmd/.bat first word runs through cmd.exe with quoted arguments (lib/runcmd.cjs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { NODE, mkTmp, world } = require('./slots-helpers.cjs');

const win = process.platform === 'win32';
const ONLY_WIN = !win && '.cmd/.bat is Windows only';
const noClaim = (w) => assert.match(w.wrap(['status']).stdout, /slot 1: free/, 'no slot is held');
const claimFiles = (w) => (fs.existsSync(w.dir) ? fs.readdirSync(w.dir).filter((f) => f.endsWith('.json')) : []);

test('cut: a .cmd or .bat argument list runs on Windows through cmd.exe with its arguments (details: heavy-slots-cmd.test.cjs)', { skip: ONLY_WIN }, () => {
  const dir = mkTmp('ghorc-cut-');
  const marker = path.join(dir, 'ran.txt');
  fs.writeFileSync(path.join(dir, 'x.cmd'), `@echo ran> "${marker}"\r\n`);
  fs.writeFileSync(path.join(dir, 'y.BAT'), `@echo ran> "${marker}"\r\n`);
  for (const w of [world({ slots: 1 }), world(undefined)]) {
    const env = { PATH: `${dir};${process.env.PATH}` };
    for (const argv of [['x.cmd'], [path.join(dir, 'x.cmd'), 'a'], ['y.BAT', 'a b'], ['.\\x.cmd', '--flag']]) {
      fs.rmSync(marker, { force: true });
      const r = w.wrap(['run', '--', ...argv], { env, cwd: dir });
      assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.equal(fs.existsSync(marker), true, 'the script ran');
      assert.deepEqual(claimFiles(w), [], 'the slot is released');
    }
  }
});

test('cut: a .cmd argument list takes the slot first: a busy slot gives 75, not a refusal (Windows)', { skip: ONLY_WIN }, () => {
  const w = world({ slots: 1 });
  w.plant(1, { session: 'other', pid: process.pid });
  const r = w.wrap(['run', '--', 'npm.cmd', 'test']);
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /no free heavy-check slot/);
});

test('cut: the same command as one string still runs through the shell, with a slot, and its exit code passes', () => {
  const dir = mkTmp('ghorc-cut-');
  const script = path.join(dir, win ? 'x.cmd' : 'x.sh');
  fs.writeFileSync(script, win ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n');
  if (!win) fs.chmodSync(script, 0o755);
  const w = world({ slots: 1 });
  const r = w.wrap(['run', '--', `"${script}" a`]);
  assert.equal(r.status, 7, `${r.stdout}${r.stderr}`);
  noClaim(w);
  assert.equal(world(undefined).wrap(['run', '--', `"${script}" a`]).status, 7, 'slots off: the same');
});

test('cut: a one-string command runs real npm (a .cmd on Windows) and prints its version', () => {
  const w = world({ slots: 1 });
  const r = w.wrap(['run', '--', 'npm --version']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  noClaim(w);
});

test('cut: a plain argument list is not a shell line (&& is an argument), and the slot is released', () => {
  const w = world({ slots: 1 });
  const dir = mkTmp('ghorc-cut-');
  const marker = path.join(dir, 'm.txt');
  const r = w.wrap(['run', '--', NODE, '-e', 'process.exit(0)', '&&', NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), false);
  noClaim(w);
});

test('cut: a command that cannot start ends with a clear message and a non-zero exit, and the slot is released', () => {
  const w = world({ slots: 1 });
  const r = w.wrap(['run', '--', 'ghorc-no-such-program-xyz', 'a']);
  assert.equal(r.status, 127, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /cannot run "ghorc-no-such-program-xyz"/);
  assert.equal(/one string/.test(r.stderr), win, 'the one-string hint is for Windows only');
  noClaim(w);
});
