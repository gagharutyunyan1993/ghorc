'use strict';
// Arguments of a .cmd/.bat through heavy-slot.cjs run: a word of safe characters arrives as typed (`%~1` and `%*`), anything
// else keeps the double escape (the `"&echo INJECTED` fix), and `.\x.cmd` is found without PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildSpawn } = require('../scripts/lib/runcmd.cjs');
const { NODE, mkTmp, world } = require('./slots-helpers.cjs');

const win = process.platform === 'win32';
const SKIP = !win && 'cmd.exe only exists on Windows';
const ARGV_PRINTER = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));';

// The shims: the `%~1` forms of the review (set MODE=%~1; if "%~1"=="full"), a pure echo of `%~1` and `%*`, and the `%*` form.
function makeShims() {
  const dir = mkTmp('ghorc-cmdargs-');
  const w = (name, lines) => fs.writeFileSync(path.join(dir, name), `${lines.join('\r\n')}\r\n`);
  fs.writeFileSync(path.join(dir, 'argv.js'), ARGV_PRINTER);
  w('mode.cmd', ['@echo off', 'set MODE=%~1', 'if /i "%MODE%"=="ci" goto ci', 'echo QUICK-PATH', 'exit /b 0', ':ci', 'echo CI-PATH', 'exit /b 3']);
  w('full.cmd', ['@echo off', 'if "%~1"=="full" goto full', 'echo OTHER-PATH', 'exit /b 0', ':full', 'echo FULL-PATH', 'exit /b 4']);
  w('echo1.cmd', ['@echo off', 'echo ONE=[%~1]', 'echo STAR=[%*]']);
  w('star.cmd', [`@"${NODE}" "%~dp0argv.js" %*`]);
  w('sh.cmd', ['@echo off', 'echo SH=[%~1]']);
  return dir;
}
const lines = (s) => s.split(/\r?\n/).filter(Boolean);

// ---- plain words: the regression of 9cc1fc3 (every argument escaped twice, `ci` reached `%~1` as `^"ci^"`) ----

test('cmd args: `run -- x.cmd ci` delivers ci to %~1 (set MODE=%~1, if "%~1"==...) and to %*, and the right branch exits (Windows)', { skip: SKIP }, () => {
  const dir = makeShims();
  const w = world(undefined);
  const env = { PATH: `${dir};${process.env.PATH}` };
  const run = (...a) => w.wrap(['run', '--', ...a], { env });
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

test('cmd args: words of safe characters reach %* and a %* shim unchanged; = and , split %~1 as for a typed command (Windows)', { skip: SKIP }, () => {
  const dir = makeShims();
  const w = world(undefined);
  const env = { PATH: `${dir};${process.env.PATH}` };
  const words = ['ci', 'full', '--max=3', 'a,b', 'x/y.js', 'C:/p/q.txt', 'u@h:1+2', 'a_b-c', '12'];
  const r = w.wrap(['run', '--', 'star', ...words], { env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), words);
  // pinned: cmd.exe itself treats `=` and `,` as separators of the batch parameters, so %~1 is only the part before them
  const e = w.wrap(['run', '--', 'echo1', '--max=3'], { env });
  assert.deepEqual(lines(e.stdout), ['ONE=[--max]', 'STAR=[--max=3]']);
});

// ---- an argument with a space and one with a double quote, on the %~1 form and on the %* form ----

test('cmd args: a space argument arrives intact through a %* shim; a %~1 script gets it with its quotes (pinned) (Windows)', { skip: SKIP }, () => {
  const dir = makeShims();
  const w = world(undefined);
  const env = { PATH: `${dir};${process.env.PATH}` };
  const star = w.wrap(['run', '--', 'star', 'a b', 'ci'], { env });
  assert.equal(star.status, 0, star.stderr);
  assert.deepEqual(JSON.parse(star.stdout), ['a b', 'ci'], '%* form: intact');
  const one = w.wrap(['run', '--', 'echo1', 'a b'], { env });
  assert.equal(one.status, 0, one.stderr);
  // %~1 form: NOT intact. It still carries the quotes of the escape, `"a b"`; %* is the escaped line for the next parser.
  assert.deepEqual(lines(one.stdout), ['ONE=["a b"]', 'STAR=["a b"]'], '%~1 form: pinned actual result');
});

test('cmd args: a double-quote argument arrives intact through a %* shim; a %~1 script gets it escaped (pinned) (Windows)', { skip: SKIP }, () => {
  const dir = makeShims();
  const w = world(undefined);
  const env = { PATH: `${dir};${process.env.PATH}` };
  const star = w.wrap(['run', '--', 'star', 'say "hi"', 'a"b'], { env });
  assert.equal(star.status, 0, star.stderr);
  assert.deepEqual(JSON.parse(star.stdout), ['say "hi"', 'a"b'], '%* form: intact');
  const one = w.wrap(['run', '--', 'echo1', 'say "hi"'], { env });
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(lines(one.stdout), ['ONE=["say \\"hi\\""]', 'STAR=["say \\"hi\\""]'], '%~1 form: pinned actual result');
});

test('cmd args: a %~1 script given a space or quote argument never exits through the wrong branch: syntax error, 255 (Windows)', { skip: SKIP }, () => {
  const dir = makeShims();
  const w = world(undefined);
  const env = { PATH: `${dir};${process.env.PATH}` };
  for (const arg of ['a b', 'say "hi"', 'a"b']) {
    for (const shim of ['mode', 'full']) {
      const r = w.wrap(['run', '--', shim, arg], { env });
      assert.ok(![0, 3, 4].includes(r.status), `${shim} ${JSON.stringify(arg)}: exit ${r.status} is a branch exit`);
      assert.ok(!/QUICK-PATH|CI-PATH|OTHER-PATH|FULL-PATH/.test(r.stdout), `${shim} ${JSON.stringify(arg)}: ${r.stdout}`);
    }
  }
  const r = w.wrap(['run', '--', 'full', 'a b'], { env });
  assert.equal(r.status, 255, 'the if line is a syntax error: loud, not green');
});

// ---- the injection stays closed: an argument with metacharacters keeps the double escape ----

test('cmd args: the quote-plus-metacharacter injection does not run, through a %* shim and a %~1 script (Windows)', { skip: SKIP }, () => {
  const dir = makeShims();
  const marker = path.join(dir, 'injected.txt');
  const w = world(undefined);
  const env = { PATH: `${dir};${process.env.PATH}` };
  for (const shim of ['star', 'echo1']) {
    const r = w.wrap(['run', '--', shim, `"&echo X>${marker}`], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(marker), false, `${shim}: the tail of the argument did not run`);
  }
  assert.deepEqual(JSON.parse(w.wrap(['run', '--', 'star', `"&echo X>${marker}`], { env }).stdout), [`"&echo X>${marker}`]);
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

test('cmd args: buildSpawn leaves a word of safe characters unquoted and unescaped, escapes everything else twice', () => {
  assert.equal(plan(['C:\\g\\x.cmd', 'ci']), '"C:\\g\\x.cmd ci"');
  assert.equal(plan(['C:\\g\\x.cmd', 'ci', '--max=3', 'a,b', 'p/q.js', 'u@h:1+2', 'a_b-c']), '"C:\\g\\x.cmd ci --max=3 a,b p/q.js u@h:1+2 a_b-c"');
  assert.equal(plan(['C:\\g\\x.cmd', 'a b']), '"C:\\g\\x.cmd ^^^"a^^^ b^^^""');
  assert.equal(plan(['C:\\g\\x.cmd', 'ci', 'a b']), '"C:\\g\\x.cmd ci ^^^"a^^^ b^^^""');
  assert.equal(plan(['C:\\g\\x.cmd', '"&echo INJECTED']), '"C:\\g\\x.cmd ^^^"\\^^^"^^^&echo^^^ INJECTED^^^""');
});

test('cmd args: buildSpawn - every character outside the safe set sends the word through the double escape', () => {
  const safe = [...'ABCxyz019_./:=+@,-'];
  for (const c of safe) assert.equal(plan(['C:\\g\\x.cmd', `a${c}b`]), `"C:\\g\\x.cmd a${c}b"`, JSON.stringify(c));
  for (let code = 33; code < 127; code++) {
    const c = String.fromCharCode(code);
    if (safe.includes(c) || /[A-Za-z0-9]/.test(c) || c === '%') continue; // % is refused, tested elsewhere
    const line = plan(['C:\\g\\x.cmd', `a${c}b`]);
    assert.ok(line.includes('^^^"'), `${JSON.stringify(c)}: ${line}`);
  }
  assert.equal(plan(['C:\\g\\x.cmd', '']), '"C:\\g\\x.cmd ^^^"^^^""', 'an empty argument is not a safe word');
});

test('cmd args: buildSpawn keeps the leading .\\ of a relative shim path', () => {
  assert.equal(plan(['.\\sh.cmd', 'x']), '".\\sh.cmd x"');
  assert.equal(plan(['./sh.cmd', 'x']), '".\\sh.cmd x"');
  assert.equal(plan(['./sub/sh.cmd', 'x']), '".\\sub\\sh.cmd x"');
  assert.equal(plan(['sh.cmd', 'x']), '"sh.cmd x"');
  assert.equal(plan(['..\\sh.cmd', 'x']), '"..\\sh.cmd x"');
  assert.equal(plan(['C:\\g\\sh.cmd', 'x']), '"C:\\g\\sh.cmd x"');
});
