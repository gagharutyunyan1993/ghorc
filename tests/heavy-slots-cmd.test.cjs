'use strict';
// E402#1: the built-in agent-start deny sees herdr global options and the wrappers timeout, nice, stdbuf, xargs.
const test = require('node:test');
const assert = require('node:assert');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');

const sub = (cwd, command) =>
  runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: sid(), cwd, agent_id: 'ag1', tool_name: 'Bash', tool_input: { command } });
const lead = (cwd, command) =>
  runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: sid(), cwd, tool_name: 'Bash', tool_input: { command } });

const FORMS = [
  // herdr global options that take a value
  'herdr --session x agent prompt lead-next hi',
  'herdr --session=x agent prompt lead-next hi',
  'herdr --machine m1 pane run w1:p2 hi',
  'herdr --remote host agent start x',
  'herdr --no-color --session x --remote h pane send-keys w1:p2 enter',
  'herdr.exe --session x pane send-text w1:p2 hi',
  // wrappers
  'timeout 5 herdr pane run w1:p2 hi',
  'timeout -k 2 30 herdr pane run w1:p2 hi',
  'timeout --foreground 10s herdr agent prompt x hi',
  'nice herdr pane run w1:p2 hi',
  'nice -n 10 herdr pane run w1:p2 hi',
  'nice -10 herdr pane run w1:p2 hi',
  'stdbuf -oL herdr pane run w1:p2 hi',
  'stdbuf -o0 -e0 herdr agent send-keys x enter',
  'echo w1:p2 | xargs herdr pane run',
  'echo w1:p2 | xargs -n1 herdr pane run',
  'echo w1:p2 | xargs -r -n 1 herdr pane send-text',
  'echo w1:p2 | xargs -I{} herdr pane run {} hi',
  'echo w1:p2 | xargs -I X herdr pane run X hi',
  // combined
  'timeout 5 herdr --session x agent prompt lead-next hi',
  'nice timeout 5 stdbuf -oL herdr --remote h pane run w1:p2 hi',
  'echo x | xargs timeout 5 herdr --machine m agent start y',
  'MSYS_NO_PATHCONV=1 timeout 5 herdr --session x pane run p /exit',
  'bash -c "timeout 5 herdr --session x pane run p hi"',
  'cd x && nice -n 5 herdr pane run p hi',
  'timeout 5 claude -p hi',
  'nice claude --print hi',
];
const OK = [
  'herdr --session x pane list',
  'herdr --session x agent read x',
  'timeout 5 herdr pane list',
  'nice -n 5 npm run build',
  'stdbuf -oL ls',
  'echo herdr --session x pane run | xargs echo',
  'xargs echo herdr pane run',
  'timeout 5 sleep 1',
];

test('E402#1: a subagent is denied every form of herdr agent/pane input, and the lead is not', () => {
  const cwd = tmpProject({});
  const miss = FORMS.filter((c) => !isDeny(sub(cwd, c)));
  assert.deepEqual(miss, [], `not denied for a subagent:\n${miss.join('\n')}`);
  for (const c of FORMS) assert.equal(isDeny(lead(cwd, c)), false, `lead: ${c}`);
});

test('E402#1: read-only herdr commands and look-alikes pass', () => {
  const cwd = tmpProject({});
  for (const c of OK) assert.equal(isDeny(sub(cwd, c)), false, c);
});
