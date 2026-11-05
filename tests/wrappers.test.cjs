'use strict';
// E408 (closes E402#1): the built-in agent-start deny and the agent-start detection look through the wrappers
// timeout, nice, stdbuf, sudo, setsid and `cmd /c start`, like they already did through xargs, env and shells.
const test = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('../scripts/lib/cmd.cjs');

const DENY = [
  'timeout 5 herdr pane run p x',
  'timeout -k 1 5 herdr pane run p x',
  'timeout --kill-after=1 -s KILL 5s hc run claude',
  'timeout 5 hc keys t5 enter',
  'nice herdr agent start x',
  'nice -n 5 hc run claude',
  'nice -n -5 hc run claude',
  'nice -5 hc run claude',
  'nice --adjustment=5 hc run claude',
  'stdbuf -oL herdr pane send-keys p x',
  'stdbuf -o L -e0 hc exec ls',
  'stdbuf --output=L hc run claude',
  'sudo herdr pane run p x',
  'sudo -u root hc run claude',
  'sudo -Eu root hc run claude',
  'setsid hc run claude',
  'setsid -f herdr agent start x',
  'cmd /c start "" /b hc run claude',
  'start hc run claude',
  String.raw`C:\x\timeout.exe 5 hc run claude`,
  '/usr/bin/nice hc run claude',
  'timeout 5 nice stdbuf -oL hc run claude',
  'timeout 5 bash -c "hc run claude"',
  'FOO=1 timeout 5 hc run claude',
  'echo x | timeout 5 xargs hc run claude',
  'time timeout 9 herdr --session x pane run p y',
  'sudo setsid timeout 5 hc interrupt t5',
];
const OK = [
  'timeout 5 hc ls',
  'timeout 5 herdr pane list',
  'nice hc get t5',
  'stdbuf -oL hc read t5',
  'sudo hc ls',
  'setsid hc ls',
  'start notepad',
  'timeout 5 echo hc run',
  'nice echo herdr pane run',
  'git status',
];

test('E408 wrappers: timeout, nice, stdbuf, sudo, setsid and start are looked through by the built-in deny', () => {
  for (const c of DENY) {
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), true, `sh: ${c}`);
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY, { powershell: true }), true, `ps: ${c}`);
  }
  for (const c of OK) {
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), false, `sh: ${c}`);
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY, { powershell: true }), false, `ps: ${c}`);
  }
});

test('E408 wrappers: agent-start detection (handoff pushGuard) sees the same wrapped forms', () => {
  for (const c of ['timeout -k 1 5 hc run claude', 'nice -n 5 herdr agent start x', 'stdbuf -oL hc run claude', 'setsid hc run claude']) {
    assert.equal(cmd.matches(c, cmd.AGENT_START), true, c);
  }
  assert.equal(cmd.matches('timeout 5 hc ls', cmd.AGENT_START), false);
});

test('E408 wrappers: a pattern on the wrapper itself still matches the unpeeled command; heavy commands are seen inside', () => {
  const [re] = cmd.compile(['^timeout\\b']);
  assert.equal(cmd.matches('timeout 5 sleep 1', [re]), true);
  const [heavy] = cmd.compile(['^npm\\s+test\\b']);
  assert.equal(cmd.matches('timeout -k 1 5 npm test', [heavy]), true);
  assert.equal(cmd.matches('nice -n 5 npm test', [heavy]), true);
  assert.equal(cmd.matches('echo timeout 5 npm test', [heavy]), false);
});
