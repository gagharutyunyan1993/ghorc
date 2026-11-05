'use strict';
// E408 ext, round 1: sudo options are case-sensitive (-H, -P without a value, -D dir); the wrappers chroot, watch, parallel,
// doas, ionice, chrt, taskset, flock, script -c, find -exec and Invoke-Expression/iex are looked through; edge forms of
// timeout, nice and `cmd /c start "title"`. The allowed commands of the review stay allowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('../scripts/lib/cmd.cjs');

const DENY = [
  'sudo -H herdr pane run p x',
  'sudo -P hc run claude',
  'sudo -D /tmp hc run claude',
  'sudo -H -u root hc run claude',
  'sudo -u root -H hc run claude',
  'sudo -Hu root hc exec ls',
  'sudo --chdir=/tmp hc run claude',
  'chroot /r hc run claude',
  'chroot --userspec=u:g /r herdr agent start x',
  'watch hc run claude',
  'watch -n 5 hc run claude',
  'watch -n5 -d herdr pane run p x',
  'parallel hc run claude ::: a b',
  'parallel -j 4 hc run claude ::: a',
  'parallel -j4 hc keys t5 enter ::: a',
  'doas hc run claude',
  'doas -u root herdr pane send-keys p x',
  'ionice -c 2 hc run claude',
  'ionice -c2 -n 4 hc run claude',
  'chrt 10 hc run claude',
  'chrt -f 10 hc run claude',
  'taskset 0x1 hc run claude',
  'taskset -c 0-3 hc run claude',
  'flock /tmp/l hc run claude',
  'flock -n /tmp/l hc run claude',
  'flock -w 5 /tmp/l herdr pane run p x',
  'flock /tmp/l -c "hc run claude"',
  'script -qc "hc run claude" /dev/null',
  'script -q -c "herdr pane run p x" out',
  'find . -name x -exec hc run claude {} \\;',
  'find . -exec herdr pane run p x {} +',
  'Invoke-Expression "hc run claude"',
  'iex "hc run claude"',
  "iex 'herdr pane run p x'",
  'timeout -vk 1 5 hc run claude',
  'timeout inf hc run claude',
  'nice --10 hc run claude',
  'cmd /c start "t" hc run claude',
  'cmd /c start "t" /b hc run claude',
  'sudo -H nice -n 5 timeout 5 hc run claude',
  'SUDO.EXE hc run claude',
  'sudo.Exe -H hc run claude',
  'Sudo -u root hc run claude',
  'powershell -Command start "hc run claude"',
  'pwsh -c start "herdr pane run p x"',
  'bash -c start "hc run claude"',
];
const OK = [
  'timeout 5 hc send t1f',
  'nice git status',
  'sudo apt',
  'sudo -H ls',
  'start notepad',
  'npm start',
  'echo timeout 5 hc run claude',
  'timeout /t 5',
  'stdbuf -oL hc get',
  'watch -n 5 git status',
  'parallel echo ::: a b',
  'ionice -c 2 ls',
  'chrt 10 ls',
  'taskset 0x1 ls',
  'flock /tmp/l ls',
  'flock /tmp/l -c "echo x"',
  'script -q -c "echo hc run claude" out',
  'find . -name x -exec grep hc {} \\;',
  'find . -name "hc run claude"',
  'iex "echo hc run claude"',
  'echo iex "hc run claude"',
  'chroot /r ls',
  'doas ls',
  'cmd /c start "t" notepad',
  'timeout inf sleep 1',
  'nice --10 ls',
  'sudo -D /tmp ls',
];

test('E408 fix1: new wrappers and edge forms are looked through by the built-in deny; allowed commands stay allowed', () => {
  for (const c of DENY) {
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), true, `sh: ${c}`);
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY, { powershell: true }), true, `ps: ${c}`);
  }
  for (const c of OK) {
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), false, `sh: ${c}`);
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY, { powershell: true }), false, `ps: ${c}`);
  }
});

test('E408 fix1: agent-start detection sees sudo -H/-P/-D and the new wrappers', () => {
  for (const c of ['sudo -H hc run claude', 'sudo -P herdr agent start x', 'sudo -D /tmp hc run claude', 'flock /l hc run claude', 'script -qc "hc run claude" /dev/null', 'iex "hc run claude"', 'cmd /c start "t" hc run claude', 'timeout -vk 1 5 hc run claude', 'nice --10 herdr agent start x']) {
    assert.equal(cmd.matches(c, cmd.AGENT_START), true, c);
  }
  assert.equal(cmd.matches('sudo -H hc ls', cmd.AGENT_START), false);
});

test('E408 fix1: hc send targets are read through sudo -H/-P/-D and the new wrappers', () => {
  assert.deepEqual(cmd.hcSendTargets('sudo -H hc send t2 z'), ['t2']);
  assert.deepEqual(cmd.hcSendTargets('sudo -P hc send t2 z'), ['t2']);
  assert.deepEqual(cmd.hcSendTargets('sudo -D /tmp hc send t2 z'), ['t2']);
  assert.deepEqual(cmd.hcSendTargets('timeout -vk 1 5 hc send t3 z'), ['t3']);
  assert.deepEqual(cmd.hcSendTargets('flock /l hc send t4 z'), ['t4']);
  assert.deepEqual(cmd.hcSendTargets('watch -n 5 hc send t5 z'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('echo hc send t6 z'), []);
});

test('E408 fix1: heavy commands are seen inside the new wrappers', () => {
  const [heavy] = cmd.compile(['^npm\\s+test\\b']);
  for (const c of ['sudo -H npm test', 'sudo -D /tmp npm test', 'watch -n 5 npm test', 'flock l npm test', 'taskset 0x1 npm test', 'parallel npm test ::: a', 'script -qc "npm test" /dev/null', 'find . -exec npm test {} \\;', 'iex "npm test"', 'cmd /c start "t" npm test', 'timeout inf npm test']) {
    assert.equal(cmd.matches(c, [heavy]), true, c);
  }
  for (const c of ['echo iex "npm test"', 'find . -name x', 'watch -n 5 git status']) assert.equal(cmd.matches(c, [heavy]), false, c);
});
