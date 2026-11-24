'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, isDeny, tmpProject, bareProject, sid, TEST_TMP } = require('./helpers.cjs');

const call = (cwd, command, tool = 'Bash', agent_id) => ({
  hook_event_name: 'PreToolUse',
  session_id: sid(),
  cwd,
  agent_id,
  tool_name: tool,
  tool_input: { command },
});
const ON = { git: { guard: true } };
const reason = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
const guard = (cwd, command, tool, agent) => runScript('git-guard.cjs', call(cwd, command, tool, agent));

test('silent without .claude/ghorc.json and off by default', () => {
  for (const cwd of [bareProject(), tmpProject()]) {
    const r = guard(cwd, 'git push --force origin main');
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'defaults.json'), 'utf8')).git.guard, false);
});

test('denies for every session: lead, subagent and worker', () => {
  const cwd = tmpProject(ON);
  assert.equal(isDeny(guard(cwd, 'git push origin main')), true);
  assert.equal(isDeny(guard(cwd, 'git push origin main', 'Bash', 'ag1')), true);
  assert.equal(isDeny(runScript('git-guard.cjs', call(cwd, 'git push origin main'), { env: { GHORC_ROLE: 'worker' } })), true);
});

test('--no-verify and commit -n are denied; ordinary commits pass', () => {
  const cwd = tmpProject(ON);
  const r = guard(cwd, 'git commit -m "wip" --no-verify');
  assert.equal(isDeny(r), true);
  assert.match(reason(r), /no-verify/);
  assert.equal(isDeny(guard(cwd, "git commit -m 'wip' -n", 'PowerShell')), true);
  assert.equal(isDeny(guard(cwd, 'git commit -anm "wip"')), true);
  assert.equal(isDeny(guard(cwd, 'git push --no-verify origin feat/x')), true);
  assert.equal(isDeny(guard(cwd, 'git merge --no-verify feat/x')), true);
  assert.equal(isDeny(guard(cwd, 'git rebase --no-verify feat/x')), true);
  assert.equal(isDeny(guard(cwd, 'git commit -m "wip"')), false);
  assert.equal(isDeny(guard(cwd, 'git commit -m "mention --no-verify in the message"')), false);
  assert.equal(isDeny(guard(cwd, 'git commit -m "--no-verify"', 'PowerShell')), false);
  assert.equal(isDeny(guard(cwd, 'git merge -n feat/x')), false); // -n is --no-stat for merge
});

test('force push and +refspec are denied; a plain feature push passes', () => {
  const cwd = tmpProject(ON);
  for (const c of ['git push --force origin feat/x', 'git push -f origin feat/x', 'git push -uf origin feat/x', 'git push --force-with-lease origin feat/x', 'git push origin +feat/x']) {
    const r = guard(cwd, c);
    assert.equal(isDeny(r), true, c);
    assert.match(reason(r), /force push/, c);
  }
  assert.equal(isDeny(guard(cwd, 'git push --force origin feat/x', 'PowerShell')), true);
  assert.equal(isDeny(guard(cwd, 'git push origin feat/x')), false);
  assert.equal(isDeny(guard(cwd, 'git push -u origin feat/x', 'PowerShell')), false);
  assert.equal(isDeny(guard(cwd, 'git push --set-upstream origin feat/x')), false);
});

test('push to the default branch is denied in any spelling', () => {
  const cwd = tmpProject(ON);
  for (const c of [
    'git push origin main',
    'git push origin master',
    'git push origin HEAD:main',
    'git push origin refs/heads/main',
    'git push origin HEAD:refs/heads/main',
    'git push origin "main"',
    'git push origin feat/x:main',
    'git push origin :main',
    'git push origin --all',
    'cd sub && git push origin main',
    'bash -c "git push origin main"',
    'git -C ../repo push origin main',
  ]) {
    const r = guard(cwd, c);
    assert.equal(isDeny(r), true, c);
    assert.match(reason(r), /protected branch/, c);
  }
  assert.equal(isDeny(guard(cwd, 'git push origin HEAD:main', 'PowerShell')), true);
  assert.equal(isDeny(guard(cwd, 'git push origin main:feat/x')), false);
  assert.equal(isDeny(guard(cwd, 'git push origin feat/main-fix')), false);
});

test('git.protectedBranches replaces main and master', () => {
  const cwd = tmpProject({ git: { guard: true, protectedBranches: ['develop'] } });
  assert.equal(isDeny(guard(cwd, 'git push origin develop')), true);
  assert.match(reason(guard(cwd, 'git push origin develop')), /develop/);
  assert.equal(isDeny(guard(cwd, 'git push origin main')), false);
});

test('push without an explicit remote and branch is denied', () => {
  const cwd = tmpProject(ON);
  for (const c of ['git push', 'git push origin', 'git push -u origin HEAD', 'git push origin @', 'git push origin $BRANCH', 'git push origin $(git branch --show-current)', 'git push 2>&1']) {
    const r = guard(cwd, c);
    assert.equal(isDeny(r), true, c);
    assert.match(reason(r), /explicit/, c);
  }
  assert.equal(isDeny(guard(cwd, 'git push origin $branch', 'PowerShell')), true);
  assert.equal(isDeny(guard(cwd, 'git push origin HEAD:feat/x')), false);
  assert.equal(isDeny(guard(cwd, 'git push origin feat/x 2>&1')), false);
});

test('writing core.hooksPath or alias.* is denied; reading passes', () => {
  const cwd = tmpProject(ON);
  for (const c of [
    'git config core.hooksPath /dev/null',
    'git config --global alias.p "push --force"',
    'git config --unset core.hooksPath',
    'git config set core.hooksPath .hooks',
    'git config --remove-section alias',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -c alias.p=push p origin main',
  ]) {
    const r = guard(cwd, c);
    assert.equal(isDeny(r), true, c);
    assert.match(reason(r), /hooksPath/, c);
  }
  assert.equal(isDeny(guard(cwd, 'git -c core.hooksPath=x status', 'PowerShell')), true);
  for (const c of ['git config core.hooksPath', 'git config --get core.hooksPath', 'git config --list', 'git config user.name "A B"', 'git -c user.name=x commit -m x']) {
    assert.equal(isDeny(guard(cwd, c)), false, c);
  }
});

test('--help passes; other commands and text that only mentions git pass', () => {
  const cwd = tmpProject(ON);
  for (const c of ['git push --help', 'git push -h', 'git commit --help', 'git help push', 'git status', 'git log --oneline | head -5', 'echo git push --force', 'npm test']) {
    assert.equal(isDeny(guard(cwd, c)), false, c);
  }
});

test('a deny is appended to the denial log; garbage on stdin does not crash', () => {
  const cwd = tmpProject(ON);
  const s = sid();
  runScript('git-guard.cjs', { ...call(cwd, 'git push --force origin x'), session_id: s });
  const log = fs.readFileSync(path.join(TEST_TMP, 'denials.log'), 'utf8');
  assert.match(log, new RegExp(`${s.slice(0, 8)} git-guard git-guard \\(force push\\)`));
  assert.equal(runScript('git-guard.cjs', '###').code, 0);
  assert.equal(guard(cwd, 'git push origin main', 'Read').out, '');
});

test('hooks.json registers git-guard on Bash|PowerShell; --help prints', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const pre = hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes('git-guard.cjs')));
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, 'Bash|PowerShell');
  assert.equal(pre[0].hooks[0].timeout, 5);
  const r = runScript('git-guard.cjs', '', { args: ['--help'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /git-guard\.cjs: PreToolUse/);
});

test('include.path and includeIf.*.path count as guarded keys; help is only the first word after the subcommand', () => {
  const cwd = tmpProject(ON);
  for (const c of [
    'git config include.path /tmp/evil.cfg',
    'git config --global includeIf.gitdir:~/x/.path /tmp/evil.cfg',
    'git -c include.path=/tmp/evil.cfg status',
    'git config --remove-section include',
    'git commit -m --help --no-verify',
    'git push origin main -h',
  ]) assert.ok(isDeny(guard(cwd, c)), c);
  for (const c of ['git config --get include.path', 'git push --help', 'git commit -h', 'git config -h']) assert.ok(!isDeny(guard(cwd, c)), c);
});
