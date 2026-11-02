'use strict';
// Arguments of a .cmd/.bat through heavy-slot.cjs run, one rule (docs/hooks.md):
//  - only [A-Za-z0-9_./:+@-]: bare;
//  - none of & | < > ^ " ! ( ): plain "word" (no carets, trailing backslashes doubled), whole at %~1, %1 and %*;
//  - one of those: double escape for a known %* shim (npm, npx, pnpm, yarn, node_modules\.bin\*.cmd), refused (exit 2) for
//    any other .cmd, like `%`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildSpawn } = require('../scripts/lib/runcmd.cjs');
const { NODE, mkTmp, world } = require('./slots-helpers.cjs');

const win = process.platform === 'win32';
const SKIP = !win && 'cmd.exe only exists on Windows';
const ARGV_PRINTER = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));';

// The shims. Outside node_modules\.bin, so none of them is a known %* shim.
function makeShims() {
  const dir = mkTmp('ghorc-cmdargs-');
  const w = (name, lines) => fs.writeFileSync(path.join(dir, name), `${lines.join('\r\n')}\r\n`);
  fs.writeFileSync(path.join(dir, 'argv.js'), ARGV_PRINTER);
  w('mode.cmd', ['@echo off', 'set MODE=%~1', 'if /i "%MODE%"=="ci" goto ci', 'echo QUICK-PATH', 'exit /b 0', ':ci', 'echo CI-PATH', 'exit /b 3']);
  w('full.cmd', ['@echo off', 'if "%~1"=="full" goto full', 'echo OTHER-PATH', 'exit /b 0', ':full', 'echo FULL-PATH', 'exit /b 4']);
  // the whole word `--mode=ci` in three readings: set "X=%~1", if "%~1"==, and %1
  w('setmode.cmd', ['@echo off', 'set "MODE=%~1"', 'if "%MODE%"=="--mode=ci" goto ci', 'echo QUICK-PATH', 'exit /b 0', ':ci', 'echo CI-PATH', 'exit /b 3']);
  w('ifmode.cmd', ['@echo off', 'if "%~1"=="--mode=ci" goto ci', 'echo QUICK-PATH', 'exit /b 0', ':ci', 'echo CI-PATH', 'exit /b 3']);
  w('one.cmd', ['@echo off', 'if %1=="--mode=ci" goto ci', 'echo QUICK-PATH', 'exit /b 0', ':ci', 'echo CI-PATH', 'exit /b 3']);
  w('setcomma.cmd', ['@echo off', 'set "LIST=%~1"', 'if "%LIST%"=="a,b" goto ab', 'echo OTHER-PATH', 'exit /b 0', ':ab', 'echo AB-PATH', 'exit /b 3']);
  // plain words: set "F=%~1" then if "%F%"==
  w('fsrc.cmd', ['@echo off', 'set "F=%~1"', 'if "%F%"=="src\\a.js" goto hit', 'echo QUICK-PATH', 'exit /b 0', ':hit', 'echo CI-PATH', 'exit /b 3']);
  w('fhead.cmd', ['@echo off', 'set "F=%~1"', 'if "%F%"=="HEAD~1" goto hit', 'echo QUICK-PATH', 'exit /b 0', ':hit', 'echo CI-PATH', 'exit /b 3']);
  w('echo1.cmd', ['@echo off', 'echo ONE=[%~1]', 'echo STAR=[%*]']);
  w('star.cmd', [`@"${NODE}" "%~dp0argv.js" %*`]);
  // P0: the argument is read into a variable, then used
  w('b.cmd', ['@echo off', 'set "TARGET=%~1"', `"${NODE}" "%~dp0argv.js" "%TARGET%"`]);
  w('v.cmd', ['@echo off', 'set ARGS=%*', `"${NODE}" "%~dp0argv.js" %ARGS%`]);
  w('sh.cmd', ['@echo off', 'echo SH=[%~1]']);
  return dir;
}
const lines = (s) => s.split(/\r?\n/).filter(Boolean);
const setup = () => {
  const dir = makeShims();
  const w = world(undefined);
  const env = { PATH: `${dir};${process.env.PATH}` };
  return { dir, w, env, run: (...a) => w.wrap(['run', '--', ...a], { env }) };
};
const refused = (r, what) => {
  assert.equal(r.status, 2, `${what}: exit ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /cannot be passed unchanged/, what);
  assert.equal(r.stdout, '', `${what}: nothing ran`);
};

// ---- plain words ----

test('cmd args: `run -- x.cmd ci` delivers ci to %~1 (set MODE=%~1, if "%~1"==...) and to %*, and the right branch exits (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  let r = run('mode', 'ci');
  assert.deepEqual([r.status, lines(r.stdout)], [3, ['CI-PATH']], `set MODE=%~1 with ci: ${r.stderr}`);
  r = run('mode', 'quick');
  assert.deepEqual([r.status, lines(r.stdout)], [0, ['QUICK-PATH']], 'set MODE=%~1 with another word');
  r = run('full', 'full');
  assert.deepEqual([r.status, lines(r.stdout)], [4, ['FULL-PATH']], `if "%~1"=="full": ${r.stderr}`);
  r = run('full', 'fast');
  assert.deepEqual([r.status, lines(r.stdout)], [0, ['OTHER-PATH']], 'if "%~1"=="full" with another word');
  r = run('echo1', 'ci');
  assert.deepEqual(lines(r.stdout), ['ONE=[ci]', 'STAR=[ci]'], '%~1 and %* both get ci');
  r = run('star', 'ci');
  assert.deepEqual(JSON.parse(r.stdout), ['ci'], 'a %* shim handing the arguments to node');
});

test('cmd args: --mode=ci and a,b reach `if "%~1"==`, `set "MODE=%~1"` and %1 whole and take the right branch (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  for (const shim of ['setmode', 'ifmode', 'one']) {
    let r = run(shim, '--mode=ci');
    assert.deepEqual([r.status, lines(r.stdout)], [3, ['CI-PATH']], `${shim} --mode=ci: ${r.stderr}`);
    r = run(shim, '--mode=quick');
    assert.deepEqual([r.status, lines(r.stdout)], [0, ['QUICK-PATH']], `${shim} --mode=quick`);
  }
  let r = run('setcomma', 'a,b');
  assert.deepEqual([r.status, lines(r.stdout)], [3, ['AB-PATH']], `set "LIST=%~1" with a,b: ${r.stderr}`);
  r = run('setcomma', 'a');
  assert.deepEqual([r.status, lines(r.stdout)], [0, ['OTHER-PATH']], 'a alone is not a,b');
  r = run('echo1', '--mode=ci');
  assert.deepEqual(lines(r.stdout), ['ONE=[--mode=ci]', 'STAR=["--mode=ci"]']);
  r = run('echo1', 'a,b');
  assert.deepEqual(lines(r.stdout), ['ONE=[a,b]', 'STAR=["a,b"]']);
});

test('cmd args: the plain words src\\a.js and HEAD~1 reach `set "F=%~1"` plus `if "%F%"==` and a %* shim whole (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  let r = run('fsrc', 'src\\a.js');
  assert.deepEqual([r.status, lines(r.stdout)], [3, ['CI-PATH']], `src\\a.js: ${r.stderr}`);
  r = run('fsrc', 'src\\b.js');
  assert.deepEqual([r.status, lines(r.stdout)], [0, ['QUICK-PATH']], 'another path');
  r = run('fhead', 'HEAD~1');
  assert.deepEqual([r.status, lines(r.stdout)], [3, ['CI-PATH']], `HEAD~1: ${r.stderr}`);
  r = run('fhead', 'HEAD~2');
  assert.deepEqual([r.status, lines(r.stdout)], [0, ['QUICK-PATH']], 'another revision');
  r = run('star', 'src\\a.js', 'HEAD~1', 'a;b', 'a\\');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['src\\a.js', 'HEAD~1', 'a;b', 'a\\'], 'the %* shim form: trailing backslash too');
});

test('cmd args: words of safe characters and plain words reach %* and a %* shim unchanged (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  const words = ['ci', 'full', '--max=3', 'a,b', 'x/y.js', 'C:/p/q.txt', 'u@h:1+2', 'a_b-c', '12', 'a b', 'src\\a.js', 'HEAD~1', 'a;b', 'a\\', 'a\\\\', ''];
  const r = run('star', ...words);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), words);
});

// ---- the 8 cases of the addendum, in this order ----

test('cmd args: `a&echo INJECTED` to a .cmd outside the shim set: exit 2, nothing runs (Windows)', { skip: SKIP }, () => {
  const { dir, run } = setup();
  const marker = path.join(dir, 'injected.txt');
  for (const shim of ['b', 'v', 'star', 'echo1']) {
    refused(run(shim, 'a&echo INJECTED'), shim);
    refused(run(shim, `a&echo X>${marker}`), shim);
  }
  assert.equal(fs.existsSync(marker), false);
});

test('cmd args: `a|b` to a .cmd outside the shim set: exit 2, nothing runs (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  for (const shim of ['b', 'v', 'star', 'echo1']) {
    refused(run(shim, 'a|b'), shim);
    refused(run(shim, 'ok|echo INJECTED'), shim);
  }
});

test('cmd args: through %~1 an argument with = arrives intact (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  const r = run('echo1', 'a=b');
  assert.deepEqual(lines(r.stdout), ['ONE=[a=b]', 'STAR=["a=b"]']);
  const s = run('setmode', '--mode=ci');
  assert.equal(s.status, 3, s.stderr);
});

test('cmd args: through %~1 an argument with , arrives intact (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  const r = run('echo1', 'a,b');
  assert.deepEqual(lines(r.stdout), ['ONE=[a,b]', 'STAR=["a,b"]']);
  const s = run('setcomma', 'a,b');
  assert.equal(s.status, 3, s.stderr);
});

test('cmd args: through %~1 an argument with a space arrives as one word; %* carries it in quotes (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  const r = run('echo1', 'a b');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['ONE=[a b]', 'STAR=["a b"]'], 'what arrives: %~1 is a b, %* is "a b"');
  const f = run('full', 'a b');
  assert.deepEqual([f.status, lines(f.stdout)], [0, ['OTHER-PATH']], 'if "%~1"==: no syntax error, the other branch');
  const s = run('star', 'a b');
  assert.deepEqual(JSON.parse(s.stdout), ['a b']);
});

test('cmd args: through %~1 an argument with a double quote is refused: exit 2, nothing runs (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  for (const shim of ['echo1', 'full', 'mode', 'b']) {
    refused(run(shim, 'say "hi"'), shim);
    refused(run(shim, 'a"b'), shim);
    refused(run(shim, '"'), shim);
  }
});

test('cmd args: through %~1 the empty argument arrives as an empty word; %* carries it as "" (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  const r = run('echo1', '');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['ONE=[]', 'STAR=[""]'], 'what arrives');
  const s = run('star', '', 'x');
  assert.deepEqual(JSON.parse(s.stdout), ['', 'x']);
});

test('cmd args: any metacharacter to a .cmd outside the shim set: exit 2 (Windows)', { skip: SKIP }, () => {
  const { run } = setup();
  for (const c of [...'&|<>^"!()']) {
    for (const shim of ['echo1', 'star', 'mode', 'full', 'b', 'v']) {
      refused(run(shim, `a${c}b`), `${shim} ${c}`);
    }
  }
});

// ---- P0: an argument read into a variable never runs ----

test('cmd args: b.cmd (set "TARGET=%~1") and v.cmd (set ARGS=%*) refuse the injection arguments, nothing runs (Windows)', { skip: SKIP }, () => {
  const { dir, run } = setup();
  for (const shim of ['b', 'v']) {
    for (const arg of ['a&echo INJECTED', 'ok|echo INJECTED', '(&echo INJECTED', '"&echo INJECTED']) {
      const r = run(shim, arg);
      refused(r, `${shim} ${JSON.stringify(arg)}`);
      assert.doesNotMatch(r.stdout + r.stderr.replace(/"[^"]*INJECTED[^"]*"/g, ''), /INJECTED/, 'the message names the argument, nothing printed it');
    }
    // more than three arguments: the metacharacter one at any position
    const r = run(shim, 'a', 'b', 'c', 'd', 'e&echo INJECTED');
    refused(r, `${shim} fifth argument`);
    const ok = run(shim, 'a b', 'c', 'd', 'e');
    assert.equal(ok.status, 0, ok.stderr);
  }
  assert.deepEqual(JSON.parse(run('b', 'a b').stdout), ['a b'], 'a plain word with a space reaches node whole through set "TARGET=%~1"');
  assert.deepEqual(JSON.parse(run('v', 'a b').stdout), ['a b']);
  assert.equal(fs.existsSync(path.join(dir, 'injected.txt')), false);
});

test('cmd args: real npm (a known %* shim) gets `"&echo INJECTED` whole and does not run it (Windows)', { skip: SKIP }, () => {
  const dir = mkTmp('ghorc-npmarg-');
  fs.writeFileSync(path.join(dir, 'argv.js'), ARGV_PRINTER);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { show: 'node argv.js' } }));
  const marker = path.join(dir, 'injected.txt');
  const w = world(undefined);
  for (const arg of ['"&echo INJECTED', 'a&echo INJECTED', 'ok|echo INJECTED', '(&echo INJECTED', `"&echo X>${marker}`]) {
    const r = w.wrap(['run', '--', 'npm', 'run', 'show', '--silent', '--', arg], { cwd: dir });
    assert.equal(r.status, 0, `${arg}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), [arg], 'whole, and nothing else printed');
  }
  assert.equal(fs.existsSync(marker), false);
});

// ---- .\x.cmd with NoDefaultCurrentDirectoryInExePath=1 ----

test('cmd args: `run -- .\\sh.cmd x` runs with NoDefaultCurrentDirectoryInExePath=1 (Windows)', { skip: SKIP }, () => {
  const dir = makeShims();
  const w = world(undefined);
  const env = { NoDefaultCurrentDirectoryInExePath: '1', PATH: process.env.PATH };
  for (const form of ['.\\sh.cmd', './sh.cmd', '.\\sh']) {
    const r = w.wrap(['run', '--', form, 'x'], { cwd: dir, env });
    assert.equal(r.status, 0, `${form}: ${r.stderr}`);
    assert.deepEqual(lines(r.stdout), ['SH=[x]'], form);
  }
});

// ---- buildSpawn, no cmd.exe needed ----

const ENV = { PATH: 'C:\\g', PATHEXT: '.exe;.cmd', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
const plan = (command) => buildSpawn(command, { platform: 'win32', env: ENV, exists: (f) => /\.cmd$/i.test(f) || f.endsWith('.exe') }).args[3];

test('cmd args: buildSpawn - bare for [A-Za-z0-9_./:+@-], plain "word" for the rest without a metacharacter', () => {
  assert.equal(plan(['C:\\g\\x.cmd', 'ci']), '"C:\\g\\x.cmd ci"');
  assert.equal(plan(['C:\\g\\x.cmd', 'ci', 'p/q.js', 'u@h:1+2', 'a_b-c']), '"C:\\g\\x.cmd ci p/q.js u@h:1+2 a_b-c"');
  assert.equal(plan(['C:\\g\\x.cmd', '--max=3', 'a,b']), '"C:\\g\\x.cmd "--max=3" "a,b""');
  assert.equal(plan(['C:\\g\\x.cmd', 'a b']), '"C:\\g\\x.cmd "a b""');
  assert.equal(plan(['C:\\g\\x.cmd', 'src\\a.js', 'HEAD~1', 'a;b']), '"C:\\g\\x.cmd "src\\a.js" "HEAD~1" "a;b""');
  assert.equal(plan(['C:\\g\\x.cmd', 'a\\', 'b\\\\']), '"C:\\g\\x.cmd "a\\\\" "b\\\\\\\\""', 'trailing backslashes doubled');
  assert.equal(plan(['C:\\g\\x.cmd', '']), '"C:\\g\\x.cmd """', 'the empty word is ""');
});

test('cmd args: buildSpawn - a metacharacter word is escaped twice for npm, npx, pnpm, yarn and node_modules/.bin, refused for any other .cmd', () => {
  const inj = '"&echo INJECTED';
  const want = '^^^"\\^^^"^^^&echo^^^ INJECTED^^^"';
  for (const known of ['C:\\g\\npm.cmd', 'C:\\g\\npx.cmd', 'C:\\g\\pnpm.cmd', 'C:\\g\\yarn.cmd', 'C:\\p\\node_modules\\.bin\\tool.cmd']) {
    assert.equal(plan([known, inj]), `"${known} ${want}"`, known);
  }
  for (const other of ['C:\\g\\x.cmd', 'C:\\g\\mynpm.cmd', 'C:\\p\\node_modules\\tool.cmd', 'C:\\g\\npm.cmd.cmd']) {
    assert.throws(() => plan([other, inj]), /cannot be passed unchanged/, other);
  }
});

test('cmd args: buildSpawn - every character outside the bare set is plain, a metacharacter is refused outside the shim set', () => {
  const bare = [...'ABCxyz019_./:+@-'];
  const meta = [...'&|<>^"!()'];
  for (const c of bare) assert.equal(plan(['C:\\g\\x.cmd', `a${c}b`]), `"C:\\g\\x.cmd a${c}b"`, JSON.stringify(c));
  for (let code = 33; code < 127; code++) {
    const c = String.fromCharCode(code);
    if (bare.includes(c) || /[A-Za-z0-9]/.test(c) || c === '%') continue; // % is refused, tested elsewhere
    if (meta.includes(c)) {
      assert.throws(() => plan(['C:\\g\\x.cmd', `a${c}b`]), /cannot be passed unchanged/, JSON.stringify(c));
      assert.ok(plan(['C:\\g\\npm.cmd', `a${c}b`]).includes('^^^"'), `npm ${JSON.stringify(c)}`);
    } else {
      assert.equal(plan(['C:\\g\\x.cmd', `a${c}b`]), `"C:\\g\\x.cmd "a${c}b""`, JSON.stringify(c));
    }
  }
  assert.throws(() => plan(['C:\\g\\x.cmd', 'a%b']), /cannot be passed unchanged/);
});

test('cmd args: buildSpawn keeps the leading .\\ of a relative shim path', () => {
  assert.equal(plan(['.\\sh.cmd', 'x']), '".\\sh.cmd x"');
  assert.equal(plan(['./sh.cmd', 'x']), '".\\sh.cmd x"');
  assert.equal(plan(['./sub/sh.cmd', 'x']), '".\\sub\\sh.cmd x"');
  assert.equal(plan(['sh.cmd', 'x']), '"sh.cmd x"');
  assert.equal(plan(['..\\sh.cmd', 'x']), '"..\\sh.cmd x"');
  assert.equal(plan(['C:\\g\\sh.cmd', 'x']), '"C:\\g\\sh.cmd x"');
});
