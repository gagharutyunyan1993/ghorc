'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');

const bash = (cwd, command, agent_id) => ({
  hook_event_name: 'PreToolUse',
  session_id: sid(),
  cwd,
  agent_id,
  tool_name: 'Bash',
  tool_input: { command },
});
const CFG = { heavyCommands: ['\\bnpm\\s+run\\s+test:e2e\\b', '^make\\s+full'] };

test('heavy command from an agent is denied', () => {
  const cwd = tmpProject(CFG);
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'npm run test:e2e -- x', 'ag1'));
  assert.equal(isDeny(r), true);
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /only the lead/);
});

test('heavy command from the lead is allowed', () => {
  const cwd = tmpProject(CFG);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(cwd, 'npm run test:e2e'))), false);
});

test('ordinary command from an agent is allowed', () => {
  const cwd = tmpProject(CFG);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(cwd, 'git status', 'ag1'))), false);
});

test('requireLeadEnv: lead without GHORC_ROLE=lead is denied', () => {
  const cwd = tmpProject({ ...CFG, heavyGuard: { requireLeadEnv: true } });
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'make full'), { env: { GHORC_ROLE: '' } });
  assert.equal(isDeny(r), true);
});

test('requireLeadEnv: GHORC_ROLE=lead lets the lead through', () => {
  const cwd = tmpProject({ ...CFG, heavyGuard: { requireLeadEnv: true } });
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'make full'), { env: { GHORC_ROLE: 'lead' } });
  assert.equal(isDeny(r), false);
});

test('no project config: everything is allowed', () => {
  const cwd = tmpProject();
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(cwd, 'npm run test:e2e', 'ag1'))), false);
});

test('a broken regex and garbage on stdin do not crash the hook', () => {
  const cwd = tmpProject({ heavyCommands: ['(['] });
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'x', 'ag1'));
  assert.equal(r.code, 0);
  assert.equal(isDeny(r), false);
  assert.equal(runScript('heavy-check-guard.cjs', '###').code, 0);
});
