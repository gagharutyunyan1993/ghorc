'use strict';
// Agent guard: the lead names a model on every Agent call and never starts the built-in Explore, Plan or general-purpose.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, isDeny, tmpProject, bareProject, sid } = require('./helpers.cjs');

const call = (cwd, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: sid(), cwd, tool_name: 'Agent', tool_input, ...extra });
const guard = (input, env) => runScript('agent-guard.cjs', input, { env: { CLAUDE_PROJECT_DIR: input.cwd, ...(env || {}) } });
const reason = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;

test('built-in Explore, Plan and general-purpose are denied to the lead, with the alternative', () => {
  const cwd = tmpProject();
  for (const t of ['Explore', 'Plan', 'general-purpose']) {
    const r = guard(call(cwd, { subagent_type: t, model: 'haiku', prompt: 'x' }));
    assert.ok(isDeny(r), t);
    assert.match(reason(r), new RegExp(`built-in ${t} agent runs on the session model`));
    assert.match(reason(r), /ghorc:scout/);
  }
});

test('a project agent of the same name is allowed (setup item explore)', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\nmodel: haiku\n---\n');
  assert.ok(!isDeny(guard(call(cwd, { subagent_type: 'Explore', model: 'haiku', prompt: 'x' }))));
});

test('a call without model is denied; with model it passes', () => {
  const cwd = tmpProject();
  const r = guard(call(cwd, { subagent_type: 'methodology-toolkit:evidence-scout', prompt: 'x' }));
  assert.ok(isDeny(r));
  assert.match(reason(r), /pass model \(and effort\) on every Agent call/);
  assert.ok(!isDeny(guard(call(cwd, { subagent_type: 'ghorc:scout', model: 'sonnet', effort: 'medium', prompt: 'x' }))));
  assert.ok(!isDeny(guard({ ...call(cwd, { subagent_type: 'ghorc:scout', model: 'sonnet' }), tool_name: 'Task' })));
});

test('silent for subagents, workers, projects without a config, and with agentGuard.enabled false', () => {
  const bad = { subagent_type: 'Explore', prompt: 'x' };
  assert.equal(guard(call(tmpProject(), bad, { agent_id: 'a1' })).out, '');
  assert.equal(guard(call(tmpProject(), bad), { GHORC_ROLE: 'worker' }).out, '');
  assert.equal(guard(call(bareProject(), bad)).out, '');
  assert.equal(guard(call(tmpProject({ agentGuard: { enabled: false } }), bad)).out, '');
  assert.equal(guard({ ...call(tmpProject(), bad), tool_name: 'Bash' }).out, '');
});
