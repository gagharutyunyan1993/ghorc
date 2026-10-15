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

test('тяжёлая команда от агента запрещена', () => {
  const cwd = tmpProject(CFG);
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'npm run test:e2e -- x', 'ag1'));
  assert.equal(isDeny(r), true);
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /только лид/);
});

test('тяжёлая команда от лида разрешена', () => {
  const cwd = tmpProject(CFG);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(cwd, 'npm run test:e2e'))), false);
});

test('обычная команда от агента разрешена', () => {
  const cwd = tmpProject(CFG);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(cwd, 'git status', 'ag1'))), false);
});

test('requireLeadEnv: лид без ORC_ROLE=lead запрещён', () => {
  const cwd = tmpProject({ ...CFG, heavyGuard: { requireLeadEnv: true } });
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'make full'), { env: { ORC_ROLE: '' } });
  assert.equal(isDeny(r), true);
});

test('requireLeadEnv: ORC_ROLE=lead пропускает лида', () => {
  const cwd = tmpProject({ ...CFG, heavyGuard: { requireLeadEnv: true } });
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'make full'), { env: { ORC_ROLE: 'lead' } });
  assert.equal(isDeny(r), false);
});

test('нет конфига проекта: разрешено всё', () => {
  const cwd = tmpProject();
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(cwd, 'npm run test:e2e', 'ag1'))), false);
});

test('битый регэксп и мусор на stdin не роняют хук', () => {
  const cwd = tmpProject({ heavyCommands: ['(['] });
  const r = runScript('heavy-check-guard.cjs', bash(cwd, 'x', 'ag1'));
  assert.equal(r.code, 0);
  assert.equal(isDeny(r), false);
  assert.equal(runScript('heavy-check-guard.cjs', '###').code, 0);
});
