'use strict';
// heavy-slot.cjs run -- <prog>.cmd|.bat <args...> on Windows: the arguments reach the script as separate words, quoted by the
// rules of scripts/lib/runcmd.cjs, and are never run as a second command. A stub script prints its arguments as JSON; no real
// npm or heavy process is started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const runcmd = require('../scripts/lib/runcmd.cjs');
const { NODE, mkTmp, world } = require('./slots-helpers.cjs');

const win = process.platform === 'win32';
const ONLY_WIN = !win && '.cmd/.bat is Windows only';

// A directory with npm.cmd (a stub that prints its argv as JSON and exits with the first argument "exit=N" if given) and a .bat.
function stubDir() {
  const dir = mkTmp('ghorc-cmdargs-');
  fs.writeFileSync(
    path.join(dir, 'show-argv.js'),
    "const a=process.argv.slice(2);console.log('ARGV'+JSON.stringify(a));const e=a.find(x=>/^exit=\\d+$/.test(x));process.exit(e?Number(e.slice(5)):0)\n",
  );
  const body = `@"${NODE}" "%~dp0show-argv.js" %*\r\n`;
  fs.writeFileSync(path.join(dir, 'npm.cmd'), body);
  fs.writeFileSync(path.join(dir, 'tool.bat'), body);
  fs.mkdirSync(path.join(dir, 'with space'));
  fs.writeFileSync(path.join(dir, 'with space', 'my tool.cmd'), `@"${NODE}" "${path.join(dir, 'show-argv.js')}" %*\r\n`);
  return dir;
}
const argvOf = (r) => {
  const m = /^ARGV(.*)$/m.exec(r.stdout);
  return m ? JSON.parse(m[1]) : null;
};
const claims = (w) => (fs.existsSync(w.dir) ? fs.readdirSync(w.dir).filter((f) => f.endsWith('.json')) : []);

test('runcmd.quoteWord: the quoting rule, on every platform', () => {
  assert.deepEqual(runcmd.quoteWord('test'), { ok: true, text: 'test' });
  assert.deepEqual(runcmd.quoteWord('--flag=x'), { ok: true, text: '"--flag=x"' }, '= separates words for a batch file');
  assert.deepEqual(runcmd.quoteWord('a b'), { ok: true, text: '"a b"' });
  assert.deepEqual(runcmd.quoteWord('a&b'), { ok: true, text: '"a&b"' });
  assert.deepEqual(runcmd.quoteWord(''), { ok: true, text: '""' });
  assert.deepEqual(runcmd.quoteWord('src\\'), { ok: true, text: 'src\\' }, 'a bare trailing backslash is fine');
  for (const bad of ['a"b', '%PATH%', 'a%', 'a\nb', 'a\rb', 'a\0b', 'a b\\', '&\\']) {
    assert.equal(runcmd.quoteWord(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(runcmd.isBatch('npm.cmd'), true);
  assert.equal(runcmd.isBatch('X.BAT'), true);
  assert.equal(runcmd.isBatch('npm'), false);
  assert.equal(runcmd.isBatch('x.cmd.exe'), false);
});

test('runcmd.plan: one verbatim cmd.exe command line; an unsafe word throws with a clear message', () => {
  const p = runcmd.plan(['npm.cmd', 'run', 'test', 'a b', 'x&y'], 'cmd.exe');
  assert.equal(p.file, 'cmd.exe');
  assert.deepEqual(p.args, ['/d', '/s', '/v:off', '/c', '"npm.cmd run test "a b" "x&y""']);
  assert.equal(p.options.windowsVerbatimArguments, true);
  assert.throws(() => runcmd.plan(['npm.cmd', 'a"b']), /argument 1 "a\\"b" cannot be passed to npm\.cmd safely: contains a double quote.*one string/);
  assert.throws(() => runcmd.plan(['npm.cmd', 'ok', '%COMSPEC%']), /argument 2 .* percent sign/);
  assert.throws(() => runcmd.plan(['bad".cmd']), /the program .* double quote/);
  assert.deepEqual(runcmd.plan(['./x.cmd', 'a'], 'cmd.exe').args[4], '".\\x.cmd a"', 'forward slashes of the program');
  assert.deepEqual(runcmd.plan(['C:\\my dir\\x.cmd', 'a'], 'cmd.exe').args[4], '""C:\\my dir\\x.cmd" a"', 'a program path with a space is quoted');
});

test('npm.cmd with two separate arguments: both arrive, the exit code passes, the slot is released', { skip: ONLY_WIN }, () => {
  const dir = stubDir();
  const env = { PATH: `${dir};${process.env.PATH}` };
  for (const w of [world({ slots: 1 }), world(undefined)]) {
    const r = w.wrap(['run', '--label', 'x', '--', 'npm.cmd', 'run', 'test'], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(argvOf(r), ['run', 'test']);
    assert.deepEqual(claims(w), []);
    const e = w.wrap(['run', '--', 'npm.cmd', 'run', 'exit=3'], { env });
    assert.equal(e.status, 3, e.stdout + e.stderr);
    assert.deepEqual(claims(w), [], 'released after a non-zero exit');
  }
  // a .bat, a path with a space, an absolute path
  const w = world({ slots: 1 });
  assert.deepEqual(argvOf(w.wrap(['run', '--', 'tool.bat', 'a', 'b'], { env })), ['a', 'b']);
  const spaced = path.join(dir, 'with space', 'my tool.cmd');
  assert.deepEqual(argvOf(w.wrap(['run', '--', spaced, 'one', 'two three'], { env })), ['one', 'two three']);
  assert.deepEqual(argvOf(w.wrap(['run', '--', path.join(dir, 'npm.cmd'), 'x'], { env })), ['x']);
});

test('an argument with a space stays one argument', { skip: ONLY_WIN }, () => {
  const dir = stubDir();
  const w = world({ slots: 1 });
  const r = w.wrap(['run', '--', 'npm.cmd', 'run', 'my script', '--', '-t', 'two words'], { env: { PATH: `${dir};${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(argvOf(r), ['run', 'my script', '--', '-t', 'two words']);
});

test('an argument with & | < > ^ ( ) ; , = ! is passed as text, never run as a second command', { skip: ONLY_WIN }, () => {
  const dir = stubDir();
  const marker = path.join(dir, 'INJECTED.txt');
  const w = world({ slots: 1 });
  const env = { PATH: `${dir};${process.env.PATH}` };
  const words = [
    `a&echo x>"${marker}"`.replace(/"/g, ''), // a & b > file
    `a&echo x>${marker}`,
    'a|b',
    'a&&b',
    'x>y',
    'x<y',
    'a^b',
    '(a)',
    'a;b',
    'a,b',
    'k=v',
    'a!b',
    "it's",
    'caf\u00e9 \u00fc',
    '*.js',
    '--grep=a b',
  ];
  for (const word of words) {
    fs.rmSync(marker, { force: true });
    const r = w.wrap(['run', '--', 'npm.cmd', 'first', word, 'last'], { env, cwd: dir });
    assert.equal(r.status, 0, `${word}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(argvOf(r), ['first', word, 'last'], word);
    assert.equal(fs.existsSync(marker), false, `${word}: nothing was executed from the argument`);
    assert.equal(fs.existsSync(path.join(dir, 'y')), false, 'no redirect created a file');
  }
});

test('an argument that cannot be quoted safely is refused: exit 2, a clear message, nothing runs, no slot is taken', { skip: ONLY_WIN }, () => {
  const dir = stubDir();
  const marker = path.join(dir, 'INJECTED.txt');
  const env = { PATH: `${dir};${process.env.PATH}` };
  const bad = [
    ['a"b', /double quote/],
    [`a" & echo x>"${marker}`, /double quote/],
    ['%COMSPEC%', /percent sign/],
    ['a%', /percent sign/],
    ['two words\\', /backslash/],
  ];
  for (const w of [world({ slots: 1 }), world(undefined)]) {
    for (const [word, why] of bad) {
      const r = w.wrap(['run', '--', 'npm.cmd', 'ok', word], { env, cwd: dir });
      assert.equal(r.status, 2, `${word}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /cannot be passed to npm\.cmd safely/);
      assert.match(r.stderr, why);
      assert.match(r.stderr, /one string/);
      assert.equal(r.stdout, '', 'the script did not run');
      assert.equal(fs.existsSync(marker), false);
      assert.deepEqual(claims(w), [], 'no claim file');
    }
  }
});

test('a bare trailing backslash and other plain words go through unquoted', { skip: ONLY_WIN }, () => {
  const dir = stubDir();
  const w = world({ slots: 1 });
  const r = w.wrap(['run', '--', 'npm.cmd', 'src\\', 'a/b', '--x', 'C:\\dir\\f.txt'], { env: { PATH: `${dir};${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(argvOf(r), ['src\\', 'a/b', '--x', 'C:\\dir\\f.txt']);
});
