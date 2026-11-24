'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, isDeny, tmpProject, bareProject, sid } = require('./helpers.cjs');

const bash = (cwd, command, tool = 'Bash') => ({ hook_event_name: 'PreToolUse', session_id: sid(), cwd, tool_name: tool, tool_input: { command } });
const mcp = (cwd, tool_name) => ({ hook_event_name: 'PreToolUse', session_id: sid(), cwd, tool_name, tool_input: { project_id: '1', pipeline_id: 2 } });
const ON = { ciRetry: { enabled: true } };
const guard = (input, env) => runScript('ci-retry-guard.cjs', input, { env: { CLAUDE_PROJECT_DIR: input.cwd, ...(env || {}) } });
const reason = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
const ledgerOf = (cwd) => path.join(cwd, '.claude', 'ghorc-out', 'ci-retry-ledger.jsonl');
const reasonOf = (cwd) => path.join(cwd, '.claude', 'ghorc-out', 'ci-retry-reason.md');
const lines = (cwd) => {
  try {
    return fs.readFileSync(ledgerOf(cwd), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const writeLedger = (cwd, hoursAgo) => {
  fs.mkdirSync(path.dirname(ledgerOf(cwd)), { recursive: true });
  fs.writeFileSync(ledgerOf(cwd), hoursAgo.map((h) => JSON.stringify({ ts: new Date(Date.now() - h * 3600000).toISOString(), command: 'glab ci retry 1', session: 'x' })).join('\n') + '\n');
};
const writeReason = (cwd, minutesAgo = 0) => {
  fs.mkdirSync(path.dirname(reasonOf(cwd)), { recursive: true });
  fs.writeFileSync(reasonOf(cwd), 'what failed: e2e job\nsignature: ETIMEDOUT\nwhy retry: runner network\n');
  if (minutesAgo) {
    const t = new Date(Date.now() - minutesAgo * 60000);
    fs.utimesSync(reasonOf(cwd), t, t);
  }
};

test('silent without .claude/ghorc.json and off by default; nothing is written', () => {
  for (const cwd of [bareProject(), tmpProject()]) {
    for (let i = 0; i < 4; i++) {
      const r = guard(bash(cwd, 'glab ci retry 123'));
      assert.equal(r.code, 0);
      assert.equal(r.out, '');
    }
    assert.equal(fs.existsSync(ledgerOf(cwd)), false);
  }
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'defaults.json'), 'utf8')).ciRetry;
  assert.deepEqual(d, { enabled: false, freeRetries: 1, hardCap: 3, windowHours: 24 });
});

test('the free restart is allowed and recorded; the next one is denied without a reason file', () => {
  const cwd = tmpProject(ON);
  const first = guard(bash(cwd, 'glab ci retry 123'));
  assert.equal(isDeny(first), false);
  const l = lines(cwd);
  assert.equal(l.length, 1);
  assert.equal(l[0].command, 'glab ci retry 123');
  assert.ok(l[0].ts && l[0].session);
  const second = guard(bash(cwd, 'gh run rerun 77', 'PowerShell'));
  assert.equal(isDeny(second), true);
  assert.match(reason(second), /ci-retry-reason\.md/);
  assert.match(reason(second), /error signature/);
  assert.equal(lines(cwd).length, 1);
});

test('a fresh reason file allows the next restart once; a stale or reused one does not', () => {
  const cwd = tmpProject(ON);
  writeLedger(cwd, [1]);
  writeReason(cwd, 45); // older than 30 minutes
  assert.equal(isDeny(guard(bash(cwd, 'glab ci retry 5'))), true);
  writeReason(cwd);
  assert.equal(isDeny(guard(bash(cwd, 'glab ci retry 5'))), false);
  assert.equal(lines(cwd).length, 2);
  assert.equal(lines(cwd)[1].reason, true);
  // the same file again: it was written before the last restart
  assert.equal(isDeny(guard(bash(cwd, 'glab ci retry 5'))), true);
});

test('the hard cap denies even with a fresh reason file', () => {
  const cwd = tmpProject(ON);
  writeLedger(cwd, [3, 2, 1]);
  writeReason(cwd);
  const r = guard(bash(cwd, 'gh workflow run ci.yml'));
  assert.equal(isDeny(r), true);
  assert.match(reason(r), /hard cap/);
  assert.match(reason(r), /owner/);
  assert.equal(lines(cwd).length, 3);
});

test('ledger lines outside the window do not count', () => {
  const cwd = tmpProject(ON);
  writeLedger(cwd, [30, 26, 25]);
  assert.equal(isDeny(guard(bash(cwd, 'glab ci retry 9'))), false);
  const short = tmpProject({ ciRetry: { enabled: true, windowHours: 2 } });
  writeLedger(short, [5, 4, 3]);
  assert.equal(isDeny(guard(bash(short, 'glab pipeline retry 9'))), false);
  writeLedger(short, [1.5, 1]);
  assert.equal(isDeny(guard(bash(short, 'glab pipeline retry 9'))), true);
});

test('freeRetries and hardCap come from the config', () => {
  const cwd = tmpProject({ ciRetry: { enabled: true, freeRetries: 2, hardCap: 2 } });
  assert.equal(isDeny(guard(bash(cwd, 'glab ci retry 1'))), false);
  assert.equal(isDeny(guard(bash(cwd, 'glab ci retry 1'))), false);
  writeReason(cwd);
  assert.match(reason(guard(bash(cwd, 'glab ci retry 1'))), /hard cap/);
});

test('MCP retry tools count; other MCP tools and other commands pass untouched', () => {
  const cwd = tmpProject(ON);
  assert.equal(isDeny(guard(mcp(cwd, 'mcp__gitlab__retry_pipeline'))), false);
  assert.equal(lines(cwd)[0].command, 'mcp__gitlab__retry_pipeline');
  assert.equal(isDeny(guard(mcp(cwd, 'mcp__gitlab__play_job'))), true);
  assert.equal(guard(mcp(cwd, 'mcp__gitlab__get_pipeline')).out, '');
  for (const c of ['glab ci view', 'glab ci status', 'gh run list', 'gh run view 5', 'glab ci retry --help', 'gh workflow run -h', 'echo glab ci retry', 'gh api repos/o/r/actions/runs/3', 'glab api projects/1/pipelines/2/jobs']) {
    assert.equal(guard(bash(cwd, c)).out, '', c);
  }
  assert.equal(lines(cwd).length, 1);
});

test('restart forms: glab with options and aliases, gh rerun, inside a chain', () => {
  const cwd = tmpProject({ ciRetry: { enabled: true, freeRetries: 0 } });
  for (const c of ['glab ci retry 1', 'glab -R grp/proj ci run', 'glab pipe retry 2', 'glab ci trigger 3', 'gh run rerun 4 --failed', 'gh workflow run ci.yml', 'cd app && glab ci retry 1', 'glab.exe ci retry 1', 'glab api -X POST projects/1/pipelines/2/retry', 'gh api -X POST repos/o/r/actions/runs/3/rerun-failed-jobs']) {
    assert.equal(isDeny(guard(bash(cwd, c))), true, c);
  }
  assert.equal(isDeny(guard(bash(cwd, 'gh run rerun 4', 'PowerShell'))), true);
});

test('the ledger lives in the project root and the deny goes to the denial log; garbage does not crash', () => {
  const cwd = tmpProject(ON);
  const sub = path.join(cwd, 'pkg');
  fs.mkdirSync(sub);
  assert.equal(isDeny(guard({ ...bash(sub, 'glab ci retry 1'), cwd: sub }, { CLAUDE_PROJECT_DIR: cwd })), false);
  assert.equal(lines(cwd).length, 1);
  const bad = tmpProject(ON);
  fs.mkdirSync(path.dirname(ledgerOf(bad)), { recursive: true });
  fs.writeFileSync(ledgerOf(bad), 'not json\n{"ts":"garbage"}\n');
  assert.equal(isDeny(guard(bash(bad, 'glab ci retry 1'))), false);
  assert.equal(runScript('ci-retry-guard.cjs', '###').code, 0);
});

test('hooks.json registers ci-retry-guard on Bash|PowerShell and the MCP retry matcher; --help prints', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const pre = hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes('ci-retry-guard.cjs')));
  assert.equal(pre.length, 2);
  const matchers = pre.map((g) => g.matcher);
  assert.ok(matchers.includes('Bash|PowerShell'));
  const m = matchers.find((x) => x !== 'Bash|PowerShell');
  for (const name of ['mcp__gitlab__retry_pipeline', 'mcp__gitlab__retry_job', 'mcp__gitlab__play_job', 'mcp__github__rerun_workflow_run']) {
    assert.ok(new RegExp(`^(?:${m})$`).test(name), name);
  }
  for (const g of pre) assert.equal(g.hooks[0].timeout, 5);
  const r = runScript('ci-retry-guard.cjs', '', { args: ['--help'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /ci-retry-guard\.cjs: PreToolUse/);
});

test('validator: ciRetry ranges and git.protectedBranches', () => {
  const validate = require('../scripts/lib/validate.cjs');
  assert.deepEqual(validate.check(tmpProject({ ciRetry: { enabled: true, freeRetries: 0, hardCap: 5, windowHours: 1.5 }, git: { guard: true, protectedBranches: ['develop'] } })).problems, []);
  const bad = validate.check(tmpProject({ ciRetry: { freeRetries: 4, hardCap: 2, windowHours: 0 }, git: { protectedBranches: [''] } })).fatal.join('\n');
  assert.match(bad, /ciRetry\.freeRetries \(4\) must not exceed ciRetry\.hardCap \(2\)/);
  assert.match(bad, /ciRetry\.windowHours/);
  assert.match(bad, /git\.protectedBranches\[0\]/);
  assert.match(validate.check(tmpProject({ git: { guard: 'yes' } })).fatal.join('\n'), /git\.guard: expected boolean/);
});
