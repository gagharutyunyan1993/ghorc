'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');

const read = (s, cwd, file, ti = {}, agent_id = 'ag1') => ({
  hook_event_name: 'PreToolUse',
  session_id: s,
  cwd,
  agent_id,
  tool_name: 'Read',
  tool_input: { file_path: file, ...ti },
});
const post = (s, cwd, tool, tool_input = {}, agent_id = 'ag1') => ({
  hook_event_name: 'PostToolUse',
  session_id: s,
  cwd,
  agent_id,
  tool_name: tool,
  tool_input,
});

test('P1-1: чтение файла по частям (разные offset) не считается повтором', () => {
  const s = sid();
  const cwd = tmpProject();
  for (const offset of [1, 2001, 4001, 6001, 8001]) {
    assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, 'big.log', { offset, limit: 2000 }))), false, `offset ${offset}`);
  }
});

test('P1-1: PDF по разным pages разрешён, одинаковый вызов повторяется до лимита', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { leadNoMedia: false } });
  for (const pages of ['1-5', '6-10', '11-15', '16-20']) {
    assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, 'x.pdf', { pages }))), false, pages);
  }
  const s2 = sid();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', read(s2, cwd, 'a.txt', { offset: 5 }));
  assert.equal(isDeny(runScript('read-guard.cjs', read(s2, cwd, 'a.txt', { offset: 5 }))), true);
});

test('P2-1: пути нормализуются (относительный и абсолютный - один файл)', () => {
  const s = sid();
  const cwd = tmpProject();
  const abs = path.join(cwd, 'a.txt');
  runScript('read-guard.cjs', read(s, cwd, 'a.txt'));
  runScript('read-guard.cjs', read(s, cwd, abs));
  runScript('read-guard.cjs', read(s, cwd, './a.txt'));
  assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, abs))), true);
});

test('P2-2: PowerShell и NotebookEdit сбрасывают счётчик', () => {
  for (const tool of ['NotebookEdit', 'PowerShell']) {
    const s = sid();
    const cwd = tmpProject();
    for (let i = 0; i < 3; i++) runScript('read-guard.cjs', read(s, cwd, 'a.txt'));
    const ti = tool === 'PowerShell' ? { command: 'Set-Content a.txt hi' } : { notebook_path: 'a.ipynb' };
    runScript('read-guard.cjs', post(s, cwd, tool, ti));
    assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, 'a.txt'))), false, tool);
  }
});

test('P2-3: посторонняя команда Bash счётчик не сбрасывает', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', read(s, cwd, 'a.txt'));
  runScript('read-guard.cjs', post(s, cwd, 'Bash', { command: 'ls' }));
  const r = runScript('read-guard.cjs', read(s, cwd, 'a.txt'));
  assert.equal(isDeny(r), true);
  assert.doesNotMatch(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /Bash/);
});

test('P2-10: роли media не советуют «отдай роли media»', () => {
  const s = sid();
  const cwd = tmpProject();
  const input = { ...read(s, cwd, 'x.pdf'), agent_type: 'orc-kit:media' };
  const r = runScript('read-guard.cjs', input);
  assert.equal(isDeny(r), true);
  assert.doesNotMatch(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /роли media/);
});

test('P2-5: без session_id счётчик не ведётся', () => {
  const cwd = tmpProject();
  for (let i = 0; i < 6; i++) {
    assert.equal(isDeny(runScript('read-guard.cjs', read(undefined, cwd, 'a.txt'))), false);
  }
});

test('P1-3: конфиг находится из подкаталога проекта (подъём до корня git)', () => {
  const cwd = tmpProject({ heavyCommands: ['\\bnpm\\s+test\\b'] });
  fs.mkdirSync(path.join(cwd, '.git'));
  const sub = path.join(cwd, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const input = { hook_event_name: 'PreToolUse', session_id: sid(), cwd: sub, agent_id: 'ag1', tool_name: 'Bash', tool_input: { command: 'NPM  test 2>&1 | tail' } };
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', input)), true);
});

test('P1-3: CLAUDE_PROJECT_DIR имеет приоритет над cwd', () => {
  const proj = tmpProject({ heavyCommands: ['zzheavy'] });
  const other = tmpProject();
  const input = { hook_event_name: 'PreToolUse', session_id: sid(), cwd: other, agent_id: 'ag1', tool_name: 'Bash', tool_input: { command: 'run zzheavy' } };
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', input, { env: { CLAUDE_PROJECT_DIR: proj } })), true);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', input)), false);
});

test('P1-3: config.load и found из подкаталога', () => {
  const config = require('../scripts/lib/config.cjs');
  const cwd = tmpProject({ readGuard: { maxRepeat: 9 } });
  fs.mkdirSync(path.join(cwd, '.git'));
  const sub = path.join(cwd, 'x');
  fs.mkdirSync(sub);
  assert.equal(config.load(sub).readGuard.maxRepeat, 9);
  assert.equal(config.found(sub), true);
});

test('P1-2: напоминание про skill orc только лиду', () => {
  const cwd = tmpProject();
  const input = { hook_event_name: 'SessionStart', session_id: sid(), cwd };
  assert.match(runScript('session-start.cjs', input).out, /skill orc/);
  assert.match(runScript('session-start.cjs', input, { env: { ORC_ROLE: 'lead' } }).out, /skill orc/);
  assert.doesNotMatch(runScript('session-start.cjs', input, { env: { ORC_ROLE: 'worker' } }).out, /skill orc/);
  assert.doesNotMatch(runScript('session-start.cjs', { ...input, agent_id: 'a1' }).out, /skill orc/);
  const off = tmpProject({ lead: { remind: false } });
  assert.doesNotMatch(runScript('session-start.cjs', { ...input, cwd: off }).out, /skill orc/);
  assert.match(runScript('session-start.cjs', { ...input, cwd: off }, { env: { ORC_ROLE: 'lead' } }).out, /skill orc/);
});

test('P2-4: check-config ловит битый регэксп, session-start пишет одну строку', () => {
  const cwd = tmpProject({ heavyCommands: ['(['], readGuard: { maxRepeat: 'три' }, bogus: 1 });
  const r = runScript('check-config.cjs', '', { args: ['--cwd', cwd] });
  assert.equal(r.code, 1);
  assert.match(r.out, /регэксп не компилируется/);
  assert.match(r.out, /неизвестный ключ: bogus/);
  assert.match(r.out, /readGuard\.maxRepeat/);
  const s = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd });
  assert.equal(s.out.split('\n').filter((l) => l.startsWith('конфиг неверен')).length, 1);
});

test('P2-4: check-config --sample и валидный конфиг', () => {
  const cwd = tmpProject({ heavyCommands: ['\\bnpm\\s+(run\\s+)?test\\b(?!:)'] });
  const r = runScript('check-config.cjs', '', { args: ['--cwd', cwd, '--sample', 'NPM  test; echo done', '--sample', 'git status'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /образец "NPM  test; echo done": ТЯЖЁЛАЯ/);
  assert.match(r.out, /образец "git status": обычная/);
  assert.match(r.out, /ошибок нет/);
});

test('P2-4: невалидный JSON конфига не ломает хуки (fail open)', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'orc-kit.json'), '{bad');
  const r = runScript('check-config.cjs', '', { args: ['--cwd', cwd] });
  assert.equal(r.code, 1);
  assert.match(r.out, /невалидный JSON/);
});

test('P2-6: --notify получает текст тревоги одним аргументом', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'dir with space'));
  fs.writeFileSync(path.join(root, 'dir with space', 'big file.jsonl'), Buffer.alloc(2 * 1024 * 1024));
  const out = path.join(root, 'notify.json');
  const script = path.join(root, 'notify.cjs');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({argv: process.argv.slice(2), env: process.env.ORC_ALERT}));`);
  const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '1', '--notify', `node "${script}"`] });
  assert.equal(r.code, 0);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(got.argv.length, 1);
  assert.match(got.argv[0], /big file\.jsonl/);
  assert.equal(got.env, got.argv[0]);
});

test('P2-7: watchdog тревожит о файле субагента выше порога', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'subagents'));
  fs.writeFileSync(path.join(root, 'subagents', 'a.jsonl'), Buffer.alloc(2 * 1024 * 1024));
  const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '100', '--subagentsMiB', '1'] });
  assert.match(r.out, /файл субагента больше 1 MiB/);
});

test('P2-8: statusline пишет в корень проекта (git), атомарно, ctx --session', () => {
  const proj = tmpProject();
  fs.mkdirSync(path.join(proj, '.git'));
  const sub = path.join(proj, 'sub');
  fs.mkdirSync(sub);
  const s1 = sid();
  const s2 = sid();
  for (const s of [s1, s2]) runScript('statusline.cjs', { session_id: s, cwd: sub, context_window: { used_percentage: 5 } });
  assert.ok(fs.existsSync(path.join(proj, '.claude', `ctx-${s1}.json`)));
  assert.ok(!fs.existsSync(path.join(sub, '.claude')));
  assert.equal(fs.readdirSync(path.join(proj, '.claude')).filter((f) => f.endsWith('.tmp')).length, 0);
  const r = runScript('ctx.cjs', '', { args: ['--cwd', sub, '--session', s2] });
  assert.equal(r.out.trim().split('\n').length, 1);
  assert.match(r.out, new RegExp(`ctx-${s2}`));
  // workspace.project_dir важнее cwd
  const pd = tmpProject();
  const s3 = sid();
  runScript('statusline.cjs', { session_id: s3, cwd: sub, workspace: { project_dir: pd }, context_window: {} });
  assert.ok(fs.existsSync(path.join(pd, '.claude', `ctx-${s3}.json`)));
});
