'use strict';
// Tabs guard: an option of the env wrapper in front of the program of `hc run` must not hide a claude start.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runScript, isDeny, tmpProject, TEST_TMP } = require('./helpers.cjs');
process.env.GHORC_TMP = TEST_TMP;
const tabs = require('../scripts/lib/tabs.cjs');
const cmd = require('../scripts/lib/cmd.cjs');

let seq = 0;
const BYPASS = ['--permission-mode', 'bypassPermissions'];
function project() {
  const cwd = fs.realpathSync.native(tmpProject({ tabs: {}, worker: { permissionArgs: BYPASS }, handoff: { candidatePermissionArgs: BYPASS } }));
  return { cwd, sid: `${String(++seq).padStart(4, '0')}-env-wrapper-x` };
}
const NONE = JSON.stringify({ result: { agents: [] } });
const pre = (p, command, tool = 'Bash') =>
  runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: tool, session_id: p.sid, cwd: p.cwd, tool_input: { command } }, { cwd: p.cwd, env: { CLAUDE_PROJECT_DIR: p.cwd, GHORC_CAPACITY_HERDR_JSON: NONE, GHORC_CAPACITY_HC_JSON: JSON.stringify({ terminals: [] }) } });
const reasonOf = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
const denied = (r) => {
  assert.equal(r.code, 0);
  return isDeny(r);
};
function allowed(r, msg) {
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '', `${msg || ''} ${r.out}`);
}

const HEAD = 'hc run --bg --name a-implementer --cwd .';
const NO_MODEL = '--effort medium -n a-implementer --permission-mode bypassPermissions "task"';
const GOOD = '--model opus --effort medium -n a-implementer --permission-mode bypassPermissions "task"';
const WIN_ENV = String.raw`"C:\Program Files\Git\usr\bin\env.exe"`;
// every modelled option of env, as the words in front of GHORC_ROLE=worker
const MODELLED = ['-i', '-', '--ignore-environment', '-u FOO', '--unset=FOO', '--unset FOO', '-i -u FOO', '--', '-i --'];

test('env wrapper start: a modelled option does not hide the missing --model', () => {
  const p = project();
  assert.match(reasonOf(pre(p, `${HEAD} env GHORC_ROLE=worker claude.exe ${NO_MODEL}`)), /--model is missing/); // the unwrapped form: the reference
  for (const opt of MODELLED) {
    const r = pre(p, `${HEAD} env ${opt} GHORC_ROLE=worker claude.exe ${NO_MODEL}`);
    assert.ok(denied(r), `env ${opt}`);
    assert.match(reasonOf(r), /--model is missing/, `env ${opt}`);
  }
});

test('env wrapper start: a modelled option with a fully correct start is allowed', () => {
  const p = project();
  for (const opt of MODELLED) allowed(pre(p, `${HEAD} env ${opt} GHORC_ROLE=worker claude.exe ${GOOD}`), `env ${opt}`);
  allowed(pre(p, `${HEAD} env -i GHORC_ROLE=worker PATH=/usr/bin claude ${GOOD}`));
  allowed(pre(p, `${HEAD} /usr/bin/env -u FOO GHORC_ROLE=worker claude ${GOOD}`));
});

test('env wrapper start: every other check still applies behind an env option', () => {
  const p = project();
  const eff = pre(p, `${HEAD} env -i GHORC_ROLE=worker claude --model opus -n a-implementer --permission-mode bypassPermissions "task"`);
  assert.ok(denied(eff));
  assert.match(reasonOf(eff), /--effort is missing/);
  const nm = pre(p, `${HEAD} env -u FOO GHORC_ROLE=worker claude --model opus --effort medium --permission-mode bypassPermissions "task"`);
  assert.ok(denied(nm));
  assert.match(reasonOf(nm), /-n a-implementer is missing/);
  const perm = pre(p, `${HEAD} env --ignore-environment GHORC_ROLE=worker claude --model opus --effort medium -n a-implementer "task"`);
  assert.ok(denied(perm));
  assert.match(reasonOf(perm), /--permission-mode/);
});

test('env wrapper start: the bypass forms from the report are denied', () => {
  const p = project();
  for (const opt of ['-i', '-u FOO', '--ignore-environment']) {
    assert.ok(denied(pre(p, `${HEAD} env ${opt} GHORC_ROLE=worker claude.exe ${NO_MODEL}`)), opt);
  }
});

test('env wrapper start: the quoted Windows env.exe path followed by -i', () => {
  const p = project();
  const r = pre(p, `${HEAD} ${WIN_ENV} -i GHORC_ROLE=worker claude.exe ${NO_MODEL}`);
  assert.ok(denied(r));
  assert.match(reasonOf(r), /--model is missing/);
  allowed(pre(p, `${HEAD} ${WIN_ENV} -i GHORC_ROLE=worker claude.exe ${GOOD}`));
  allowed(pre(p, `${HEAD} ${WIN_ENV} -u FOO GHORC_ROLE=worker claude.exe ${GOOD}`));
  const s = pre(p, `${HEAD} ${WIN_ENV} -S "x" GHORC_ROLE=worker claude.exe ${GOOD}`);
  assert.ok(denied(s));
  assert.match(reasonOf(s), /env option -S/);
});

test('env wrapper start: env -i clears the role, so GHORC_ROLE=worker must follow it', () => {
  const p = project();
  for (const c of [`${HEAD} env -i claude ${GOOD}`, `${HEAD} env -i PATH=/usr/bin claude ${GOOD}`, `${HEAD} env -u FOO claude ${GOOD}`, `${HEAD} env -i GHORC_ROLE=lead claude ${GOOD}`]) {
    const r = pre(p, c);
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), /GHORC_ROLE=worker is missing in front of claude/, c);
  }
});

test('env wrapper start: an option that cannot be modelled is denied, whatever the program is', () => {
  const p = project();
  for (const opt of ['-S', '--split-string', '-C', '--chdir', '-v', '-iu', '-0', '-uFOO', '--debug']) {
    for (const prog of [`claude.exe ${GOOD}`, 'node build.js']) {
      const r = pre(p, `${HEAD} env ${opt} GHORC_ROLE=worker ${prog}`);
      assert.ok(denied(r), `${opt} ${prog}`);
      assert.match(reasonOf(r), new RegExp(`env option ${opt.replace(/-/g, '\\-')}`), `${opt} names the option`);
      assert.match(reasonOf(r), /pass plain NAME=value words after env instead/, opt);
    }
  }
  // the whole command is judged: a missing --name is reported next to it, and no corrected form echoes the option back
  const r = pre(p, 'hc run --bg --cwd . env -S x node build.js');
  assert.match(reasonOf(r), /--name is missing/);
  assert.match(reasonOf(r), /env option -S/);
  assert.doesNotMatch(reasonOf(r), /Corrected form/);
});

test('env wrapper start: a program that is not claude stays allowed behind env -i and env -u', () => {
  const p = project();
  allowed(pre(p, `${HEAD} env node build.js`));
  allowed(pre(p, `${HEAD} env -i node build.js`));
  allowed(pre(p, `${HEAD} env -i PATH=/usr/bin node build.js`));
  allowed(pre(p, `${HEAD} env -u FOO node build.js`));
  allowed(pre(p, `${HEAD} env --ignore-environment FOO=1 node build.js`));
  allowed(pre(p, `${HEAD} ${WIN_ENV} -i node build.js`));
  // a long-running process is judged on the program, not on the env option in front of it
  assert.ok(denied(pre(p, 'hc run --bg --name a-implementer --cwd . env -i npm run dev')));
  allowed(pre(p, 'hc run --bg --name a-runner --outlive-parent --cwd . env -i npm run dev'));
});

test('env wrapper start: the PowerShell tool gives the same answers as the Bash tool', () => {
  const p = project();
  for (const tool of ['Bash', 'PowerShell']) {
    const r = pre(p, `${HEAD} env -i GHORC_ROLE=worker claude.exe ${NO_MODEL}`, tool);
    assert.ok(denied(r), tool);
    assert.match(reasonOf(r), /--model is missing/, tool);
    allowed(pre(p, `${HEAD} env -i GHORC_ROLE=worker claude.exe ${GOOD}`, tool), tool);
    allowed(pre(p, `${HEAD} env -u FOO node build.js`, tool), tool);
    const s = pre(p, `${HEAD} env -S x GHORC_ROLE=worker claude.exe ${GOOD}`, tool);
    assert.ok(denied(s), tool);
    assert.match(reasonOf(s), /env option -S/, tool);
    const w = pre(p, `${HEAD} ${WIN_ENV} -i GHORC_ROLE=worker claude.exe ${NO_MODEL}`, tool);
    assert.ok(denied(w), tool);
  }
});

test('env wrapper start: parseHc records the program behind the options', () => {
  const at = (c) => tabs.parseSegment(c);
  const a = at('hc run --bg --name x env -i -u FOO --unset=BAR A=1 claude --model opus');
  assert.equal(a.claude, true);
  assert.equal(a.envBad, null);
  assert.equal(a.tokens[a.progIdx], 'claude');
  assert.deepEqual(a.assigns.map((x) => x.t), ['A=1']);
  const b = at('hc run --bg --name x env -S "a b" claude');
  assert.equal(b.claude, false);
  assert.equal(b.envBad, '-S');
  assert.equal(at('hc run --bg --name x node a.js').envBad, null);
});

test('env wrapper options: the other wrapper-skipping places see through them as well', () => {
  const peel = (c) => tabs.peelWrappers(c.split(' ')).join(' ');
  for (const opt of ['-i', '-', '--ignore-environment', '-u A', '-uA', '-iu A', '--unset=A', '--unset A', '-C /x', '--chdir=/x', 'FOO=1']) {
    assert.equal(peel(`env ${opt} herdr pane run p x`).replace(/^herdr pane run p x$/, 'ok'), 'ok', opt);
  }
  assert.equal(peel('env -S herdr pane run p x'), 'herdr pane run p x');
  assert.equal(peel('env -iu A bash -c x'), 'bash -c x');
  // the heavy-command matching peels the same options
  const heavy = [/^npm\s+test\b/i];
  for (const opt of ['', '-i ', '- ', '--ignore-environment ', '-u A ', '-iu A ', '--unset=A ', '--unset A ', '-C /x ', '--chdir=/x ', 'FOO=1 ']) {
    assert.equal(cmd.matches(`env ${opt}npm test`, heavy), true, `env ${opt}npm test`);
  }
  assert.equal(cmd.matches('env -i echo npm test', heavy), false);
});

test('env wrapper options: a send into a blocked pane behind an env option is still judged', () => {
  const p = project();
  const list = JSON.stringify({ result: { agents: [{ name: 'a1-implementer', agent_status: 'blocked', pane_id: 'w1:p2', cwd: p.cwd, agent_session: { value: 's-a1' } }] } });
  for (const w of ['env -i', 'env --ignore-environment', 'env -iu FOO', 'env -S herdr']) {
    const cmdline = w === 'env -S herdr' ? `${w} pane run w1:p2 "go on"` : `${w} herdr pane run w1:p2 "go on"`;
    const r = runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: p.sid, cwd: p.cwd, tool_input: { command: cmdline } }, { cwd: p.cwd, env: { CLAUDE_PROJECT_DIR: p.cwd, GHORC_CAPACITY_HERDR_JSON: list, GHORC_CAPACITY_HC_JSON: JSON.stringify({ terminals: [] }) } });
    assert.ok(denied(r), w);
    assert.match(reasonOf(r), /blocked on a dialog/, w);
  }
});

// ---- round 2 ----
const NO_MODEL_PS = '--effort medium -n a-implementer --permission-mode bypassPermissions "task"';
const BEHIND = /claude behind \S+ cannot be checked/;
const QUOTED = /a quoted word after env cannot be read.*write the env options and NAME=value words unquoted/;
const mustDeny = (p, c, re, tool) => {
  const r = pre(p, c, tool);
  assert.ok(denied(r), c);
  if (re) assert.match(reasonOf(r), re, c);
};

test('env wrapper F1: an attached -u / -C value is one word, a separate value only after u, C, a at the end', () => {
  // the built-in deny for subagents and workers (heavy-check-guard.cjs) and the heavy matcher
  const p = project();
  const sub = (command) => runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: p.sid, cwd: p.cwd, agent_id: 'sub1', tool_name: 'Bash', tool_input: { command } }, { cwd: p.cwd });
  for (const c of ['env -uDATA hc run --bg --name x-implementer claude', 'env -uLC herdr agent start x-implementer --kind claude', 'env -u X hc run --bg --name x-implementer claude', 'env -ua hc run --bg --name x-implementer claude', 'env -Ca hc run --bg --name x-implementer claude', 'env -iu X hc run --bg --name x-implementer claude', 'env -uCUDA hc run --bg --name x-implementer claude']) {
    assert.ok(isDeny(sub(c)), c);
  }
  const heavy = [/^npm\s+test\b/i];
  for (const c of ['env -uDATA npm test', 'env -Ca npm test', 'env -ua npm test', 'env -uLC npm test', 'env -uCUDA npm test', 'env -u X npm test', 'env -iu X npm test', 'env -C /x npm test', 'env -a x npm test', 'env -iv npm test']) {
    assert.equal(cmd.matches(c, heavy), true, c);
  }
  // the separate value of the last letter is still taken: the program after it is what is judged
  assert.equal(cmd.matches('env -iu npm test', heavy), false); // npm is the NAME to unset, `test` the program
});

test('env wrapper F2: a quoted word between env and the program is denied; a quoted value in an assignment stays allowed', () => {
  const p = project();
  const C = (mid) => `${HEAD} env ${mid} claude --effort medium -n a-implementer --permission-mode bypassPermissions "task"`;
  for (const mid of ['"-i" GHORC_ROLE=worker', "'-v' GHORC_ROLE=worker", '"-S" GHORC_ROLE=worker', '"GHORC_ROLE=worker"', '-i "GHORC_ROLE=worker"', '"-i" "GHORC_ROLE=worker"']) {
    mustDeny(p, C(mid), QUOTED, 'Bash');
  }
  mustDeny(p, `${HEAD} env "-v" GHORC_ROLE=worker claude.exe ${NO_MODEL_PS}`, QUOTED, 'PowerShell');
  mustDeny(p, `${HEAD} env -i "GHORC_ROLE=worker" claude.exe ${NO_MODEL_PS}`, QUOTED, 'PowerShell');
  mustDeny(p, `${HEAD} env "GHORC_ROLE=worker" claude.exe ${NO_MODEL_PS}`, QUOTED, 'PowerShell');
  // a quoted value inside an assignment word is read as before (the start checks run; a quoted GHORC_ROLE value is not seen, as on main)
  mustDeny(p, `${HEAD} env GHORC_ROLE=worker FOO="a b" claude ${NO_MODEL}`, /--model is missing/);
  allowed(pre(p, `${HEAD} env GHORC_ROLE=worker FOO="a b" claude ${GOOD}`));
  allowed(pre(p, `${HEAD} env GHORC_ROLE=worker FOO='a b' claude.exe ${GOOD}`, 'PowerShell'));
  mustDeny(p, `${HEAD} env GHORC_ROLE="worker" claude ${GOOD}`, /GHORC_ROLE=worker is missing/);
  // a quoted program that is not claude is not a claude start
  allowed(pre(p, `${HEAD} env -i "C:\\Program Files\\nodejs\\node.exe" build.js`));
});

test('env wrapper F3a: a second env behind the first is read like the first', () => {
  const p = project();
  const T = (mid, args = NO_MODEL) => `${HEAD} ${mid} claude.exe ${args}`;
  for (const mid of ['env -i env GHORC_ROLE=worker', 'env GHORC_ROLE=worker env', 'env env -v GHORC_ROLE=worker', 'env GHORC_ROLE=worker /usr/bin/env', `env GHORC_ROLE=worker ${WIN_ENV}`]) {
    const r = pre(p, T(mid));
    assert.ok(denied(r), mid);
    assert.match(reasonOf(r), mid.includes('-v') ? /env option -v/ : /--model is missing/, mid);
  }
  allowed(pre(p, T('env -i env GHORC_ROLE=worker', GOOD)));
  allowed(pre(p, T('env GHORC_ROLE=worker env', GOOD)));
  allowed(pre(p, T('env GHORC_ROLE=worker /usr/bin/env -u FOO', GOOD)));
  // the second env's -i empties what the first one set
  mustDeny(p, T('env GHORC_ROLE=worker env -i', GOOD), /GHORC_ROLE=worker is missing in front of claude/);
  mustDeny(p, T('env GHORC_ROLE=worker env -u GHORC_ROLE', GOOD), /GHORC_ROLE=worker is missing in front of claude/);
  allowed(pre(p, T('env GHORC_ROLE=worker env -u FOO', GOOD)));
});

test('env wrapper F3b: claude behind a program that runs another program is denied', () => {
  const p = project();
  const R = (mid, args = NO_MODEL) => `${HEAD} ${mid} ${args}`;
  for (const mid of ['env -i nohup claude.exe', 'env -i GHORC_ROLE=worker timeout 100 claude', 'env -i GHORC_ROLE=worker setsid claude', 'nohup claude.exe', 'time env -i GHORC_ROLE=worker claude', 'command env -i GHORC_ROLE=worker claude', 'exec env -i GHORC_ROLE=worker claude', 'env -i GHORC_ROLE=worker npx claude', 'env GHORC_ROLE=worker nice -n 5 claude.cmd']) {
    mustDeny(p, R(mid), BEHIND);
    mustDeny(p, R(mid, GOOD), BEHIND); // even a start that is otherwise right: it cannot be checked
  }
  // behind a program that does not run another program claude is an argument (round 2 denied these; round 4 lifts it)
  allowed(pre(p, 'hc run --bg --name a-implementer --cwd . node server.js "claude said hi"'));
  allowed(pre(p, 'hc run --bg --name a-implementer --cwd . env -i node server.js "claude said hi" claude'));
  allowed(pre(p, 'hc run --bg --name a-implementer --cwd . node server.js --label claudex'));
  allowed(pre(p, 'hc run --bg --name a-implementer --cwd . node claude-cli.js'));
});

const INSTRING = /claude inside the command string of \S+ cannot be checked/;
test('env wrapper F3c: a shell string is denied only when claude is the program of one of its commands', () => {
  const p = project();
  for (const c of [
    `${HEAD} bash -c "env -i GHORC_ROLE=worker claude.exe ${NO_MODEL}"`,
    `${HEAD} sh -c 'env -i GHORC_ROLE=worker claude ${GOOD}'`,
    `${HEAD} cmd /c "env -i GHORC_ROLE=worker claude.exe ${GOOD}"`,
    `${HEAD} cmd /c env -i GHORC_ROLE=worker claude ${GOOD}`,
    `${HEAD} bash -lc "claude --model opus"`,
    `${HEAD} bash -lc claude`,
    `${HEAD} bash -c "exec claude"`,
    `${HEAD} bash -c "ls; claude -p hi"`,
    `${HEAD} sh -c "true && claude"`,
    `${HEAD} env -i GHORC_ROLE=worker bash -c "claude ${GOOD}"`,
  ]) mustDeny(p, c, INSTRING);
  mustDeny(p, `${HEAD} pwsh -Command "env -i GHORC_ROLE=worker claude.exe ${GOOD}"`, INSTRING, 'PowerShell');
  mustDeny(p, `${HEAD} powershell.exe -Command "& claude.exe ${GOOD}"`, INSTRING, 'PowerShell');
  for (const c of [
    `${HEAD} bash -c "node s.js 'claude said hi'"`,
    `${HEAD} bash -c "grep claude x.txt"`,
    `${HEAD} bash -c "tail -f ~/.claude/logs/x.log"`,
    `${HEAD} cmd /c "type claude.txt"`,
    `${HEAD} sh ./claude`,
    'hc run --bg --name x-runner --outlive-parent --cwd . bash -c "npm run dev"',
    `${HEAD} sh -c "node build.js"`,
  ]) allowed(pre(p, c));
  allowed(pre(p, `${HEAD} pwsh -Command "node build.js"`, 'PowerShell'));
  allowed(pre(p, `${HEAD} pwsh -Command "Select-String claude x.txt"`, 'PowerShell'));
});

// ---- round 4 ----
const R1_ALLOWED = [
  'grep -r claude src', 'rg claude', 'git log --author claude', 'which claude', 'ls claude', 'node claude', 'sh ./claude',
  'npx vitest --project claude', 'docker run --name claude img', 'codex exec --label claude review', 'codex exec --model o3 claude',
  '"C:\\Program Files\\nodejs\\node.exe" claude',
];
test('env wrapper R1: a claude word behind a program that does not run another program is an argument', () => {
  const p = project();
  for (const tail of R1_ALLOWED) {
    allowed(pre(p, `hc run --bg --name a1-runner --outlive-parent --cwd . ${tail}`));
    allowed(pre(p, `hc run --bg --name a1-scout --cwd . ${tail}`));
  }
  allowed(pre(p, 'hc run --bg --name a1-scout --cwd . codex exec --model o3 claude | tail -5'));
});

test('env wrapper R2: a quoted word behind a program that runs another program does not hide claude', () => {
  const p = project();
  const R = (mid) => `${HEAD} ${mid} claude ${NO_MODEL}`;
  for (const mid of ['env GHORC_ROLE=worker timeout "60m"', 'nice -n "5"', 'sudo -u "me"', 'env GHORC_ROLE=worker nice -n \'5\'', 'doas -u "me"', 'env GHORC_ROLE=worker xargs -n "1"', 'env GHORC_ROLE=worker timeout -s "KILL" 60']) {
    mustDeny(p, R(mid), BEHIND);
  }
  mustDeny(p, `${HEAD} env GHORC_ROLE=worker timeout "60m" claude ${GOOD}`, BEHIND);
  allowed(pre(p, `${HEAD} env GHORC_ROLE=worker claude ${GOOD}`)); // the checked form stays allowed
});

test('env wrapper R2: a substitution or variable program that says claude is denied, other variables stay as they are', () => {
  const p = project();
  const SUBST = /the program is a substitution or variable that says claude/;
  for (const prog of ['$(which claude)', '`which claude`', '$CLAUDE_BIN', '${CLAUDE}', '$(command -v claude.exe)', '$claude_path']) {
    mustDeny(p, `${HEAD} env GHORC_ROLE=worker ${prog} ${NO_MODEL}`, SUBST);
    mustDeny(p, `${HEAD} ${prog} ${NO_MODEL}`, SUBST);
  }
  mustDeny(p, `${HEAD} env GHORC_ROLE=worker $env:CLAUDE_EXE ${NO_MODEL_PS}`, SUBST, 'PowerShell');
  mustDeny(p, `${HEAD} env GHORC_ROLE=worker $(Get-Command claude).Source ${NO_MODEL_PS}`, SUBST, 'PowerShell');
  // a variable or substitution without the word is not judged (a stated limit)
  allowed(pre(p, `${HEAD} env GHORC_ROLE=worker $RUNNER ${NO_MODEL}`));
  allowed(pre(p, `${HEAD} env GHORC_ROLE=worker $(which node) build.js`));
  allowed(pre(p, `${HEAD} $(which node) build.js`));
});

test('env wrapper R2: chrt, ionice and nice in front of hc are seen through; a quoted attached -S string is denied', () => {
  const p = project();
  const S = (lead, args = NO_MODEL) => `${lead} hc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${args}`;
  for (const lead of ['chrt 0', 'chrt -f 10', 'chrt --rr 5', 'ionice -c3', 'ionice -c 2 -n 4', 'ionice -n4', 'nice -n 5', 'nice', 'setsid', 'stdbuf -oL', 'timeout 60', 'nohup']) {
    mustDeny(p, S(lead), /--model is missing/);
    allowed(pre(p, S(lead, GOOD)));
  }
  mustDeny(p, `ionice -c3 herdr agent start a-implementer --kind claude --pane w1:p1 -- --effort medium`, /--model is missing/);
  const Q = /a quoted env -S string in front of hc or herdr cannot be read/;
  for (const c of [
    `env -S'hc run' --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${GOOD}`,
    `env -S"hc run" --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${GOOD}`,
    `env -S 'hc run --bg --name a-implementer --cwd .' env GHORC_ROLE=worker claude ${GOOD}`,
    `env -i -S'herdr agent start a-implementer --kind claude' --pane w1:p1`,
    `env --split-string='hc run' --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${GOOD}`,
  ]) mustDeny(p, c, Q);
  // an -S string that does not say hc or herdr is no concern of this guard
  allowed(pre(p, 'env -S "npm test" && echo done'));
});

test('env wrapper R3: the reasons say what stands in front of claude', () => {
  const p = project();
  mustDeny(p, `${HEAD} GHORC_ROLE=worker claude --model opus ${NO_MODEL}`, /GHORC_ROLE=worker in front of claude needs env: write env GHORC_ROLE=worker claude \.\.\./);
  assert.doesNotMatch(reasonOf(pre(p, `${HEAD} GHORC_ROLE=worker claude --model opus ${NO_MODEL}`)), /claude behind/);
  const r = reasonOf(pre(p, `${HEAD} sudo -u "me" claude ${NO_MODEL}`));
  assert.match(r, /claude behind sudo cannot be checked/);
  assert.doesNotMatch(r, /claude behind ""/);
  // a quoted program that is not a program-runner is no claude start: no reason at all
  allowed(pre(p, `${HEAD} "C:\\Program Files\\nodejs\\node.exe" claude`));
  allowed(pre(p, `${HEAD} "" claude --model opus ${NO_MODEL}`));
});

test('env wrapper R4: env -- is peeled by the subagent deny and the heavy matcher as it is by the tabs guard', () => {
  const p = project();
  const sub = (command) => runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: p.sid, cwd: p.cwd, agent_id: 'sub1', tool_name: 'Bash', tool_input: { command } }, { cwd: p.cwd });
  for (const c of ['env -- claude -p hi', 'env -i -- claude -p hi', '/usr/bin/env -- claude -p hi', 'env FOO=1 -- claude -p hi', 'env -u X -- claude -p hi', 'env -S "claude -p hi"']) {
    assert.ok(isDeny(sub(c)), c);
  }
  assert.ok(!isDeny(sub('env FOO=1 ls')));
  assert.ok(!isDeny(sub('env -- ls -la')));
  for (const c of ['env -- npm test', 'env -i -- npm test', 'env FOO=1 -- npm test']) {
    assert.equal(cmd.matches(c, [/^npm\s+test\b/i]), true, c);
  }
});

test('env wrapper F3d: claude.ps1 is a claude program wherever claude.cmd is', () => {
  const p = project();
  assert.match(reasonOf(pre(p, `${HEAD} env -i GHORC_ROLE=worker claude.ps1 ${NO_MODEL}`)), /--model is missing/);
  assert.match(reasonOf(pre(p, `${HEAD} env -i GHORC_ROLE=worker claude.cmd ${NO_MODEL}`)), /--model is missing/);
  allowed(pre(p, `${HEAD} env -i GHORC_ROLE=worker claude.ps1 ${GOOD}`));
  allowed(pre(p, `${HEAD} env -i GHORC_ROLE=worker C:\\tools\\claude.ps1 ${GOOD}`));
  assert.equal(tabs.parseSegment('hc run --bg --name x env claude.ps1 --model opus').claude, true);
});

test('env wrapper F3f: a wrapper in front of hc that the peel did not know', () => {
  const p = project();
  for (const lead of ['nohup env -v', 'nohup env -i', 'time env -v', 'nohup', '/usr/bin/env -v', 'nohup /usr/bin/env -u A']) {
    mustDeny(p, `${lead} hc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${NO_MODEL}`, /--model is missing/);
    allowed(pre(p, `${lead} hc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${GOOD}`));
  }
  const peel = (c) => tabs.peelWrappers(c.split(' ')).join(' ');
  assert.equal(peel('nohup env -v hc run x'), 'hc run x');
  assert.equal(peel('time -p /usr/bin/env -i herdr pane run p x'), 'herdr pane run p x');
  assert.equal(peel('constructor hc'), 'constructor hc'); // a word that is a property of Object is no wrapper
});

test('env wrapper F4: an attached -S value that holds hc or herdr is not dropped by the prefilter', () => {
  const p = project();
  mustDeny(p, `env -Shc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${NO_MODEL}`, /--model is missing/);
  allowed(pre(p, `env -Shc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${GOOD}`));
  mustDeny(p, `env -iShc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${NO_MODEL}`, /--model is missing/);
  mustDeny(p, `env --split-string=hc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude ${NO_MODEL}`, /--model is missing/);
  mustDeny(p, 'env -Sherdr agent start x-implementer --kind claude --pane w1:p1 -- --effort medium', /--model is missing/);
  mustDeny(p, `env -Shc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude.exe ${NO_MODEL_PS}`, /--model is missing/, 'PowerShell');
  // the same attached string for the subagent deny and the heavy matcher (cmd.cjs ENV_WRAPPER)
  const sub = (command) => runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: p.sid, cwd: p.cwd, agent_id: 'sub1', tool_name: 'Bash', tool_input: { command } }, { cwd: p.cwd });
  assert.ok(isDeny(sub('env -Shc run --bg --name x-implementer claude')));
  assert.ok(isDeny(sub('env -iSherdr agent start x-implementer --kind claude')));
  assert.equal(cmd.matches('env -Snpm test', [/^npm\s+test\b/i]), true);
  assert.equal(cmd.matches('env -S "npm test"', [/^npm\s+test\b/i]), true);
});

test('env wrapper F10: the deny text lists exactly the forms the parser accepts', () => {
  const p = project();
  const reason = reasonOf(pre(p, `${HEAD} env -S x node a.js`));
  for (const form of ['-i', '-', '--ignore-environment', '-u NAME', '--unset NAME', '--unset=NAME', '--']) {
    assert.ok(reason.includes(form), form);
    assert.equal(tabs.parseSegment(`hc run --bg --name x env ${form} claude`).claude, true, form);
  }
});

// ---- round 5 ----
test('env wrapper V1: a shell keyword or grouping word in front of claude does not hide it', () => {
  const p = project();
  for (const s of ['if true; then claude; fi', '{ claude; }', '! claude', 'while true; do claude; done', 'for i in 1; do claude; done', 'true && { claude; }', 'until false; do claude; done', 'if x; then echo y; elif z; then claude; else echo n; fi', 'if ! claude; then echo n; fi', '! time claude', '(claude)', 'a=1 claude']) {
    mustDeny(p, `${HEAD} bash -c "${s}"`, INSTRING);
  }
  for (const s of ['if grep -q claude x.txt; then echo yes; fi', 'for f in claude.txt; do cat $f; done', 'while read l; do echo claude; done']) {
    allowed(pre(p, `${HEAD} bash -c "${s}"`));
  }
});

// A mid-line `&` in PowerShell ends the hc run: what follows is a command of its own, run in the lead's own shell. It is no worker
// start (the old test pinned the rewrite that read it as one and allowed it).
const AMP = /`&` ends the hc run there, so the program after it would run in the lead's own shell and not in the tab: write the program \(env GHORC_ROLE=worker claude \.\.\.\) directly after the hc run options/;
test('env wrapper V2: a mid-line & between hc run and an env or claude program is denied with a reason a lead can act on', () => {
  const p = project();
  const ARGS = '-n a-implementer --effort medium --permission-mode bypassPermissions "Read the brief"';
  const ARGS_M = ARGS.replace('--effort', '--model sonnet --effort');
  for (const c of [
    `${HEAD} & ${WIN_ENV} GHORC_ROLE=worker claude.exe ${ARGS_M}`,
    `${HEAD} & env GHORC_ROLE=worker claude.exe ${ARGS_M}`,
    `${HEAD} & ${WIN_ENV} GHORC_ROLE=worker claude.exe ${ARGS}`,
    `${HEAD} & env GHORC_ROLE=worker claude.exe ${ARGS}`,
    `${HEAD} & env -i claude.exe ${ARGS_M}`,
    `${HEAD} & env -S x claude.exe ${ARGS}`,
    `${HEAD} & env GHORC_ROLE=worker timeout 5 claude.exe ${ARGS}`,
    `${HEAD} & claude.exe ${ARGS_M}`,
    `${HEAD} &env GHORC_ROLE=worker claude.exe ${ARGS_M}`,
    `${HEAD} & env FOO=1 ls`,
  ]) mustDeny(p, c, AMP, 'PowerShell');
  // a program that is neither env nor claude after the `&`, a `&` that ends the line, and the call operator first, are as before
  allowed(pre(p, `${HEAD} & ${String.raw`"C:\Program Files\nodejs\node.exe"`} claude`, 'PowerShell'));
  allowed(pre(p, 'hc run --bg --name x-scout --cwd . node a.js & echo hi', 'PowerShell'));
  allowed(pre(p, `& hc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude.exe ${GOOD}`, 'PowerShell'));
  allowed(pre(p, `& "C:\\x\\hc.exe" run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude.exe ${GOOD}`, 'PowerShell'));
  mustDeny(p, `& hc run --bg --name a-implementer --cwd . env GHORC_ROLE=worker claude.exe ${NO_MODEL}`, /--model is missing/, 'PowerShell');
  allowed(pre(p, `${HEAD} env GHORC_ROLE=worker claude.exe ${GOOD}; Get-Date`, 'PowerShell'));
  allowed(pre(p, `hc run --bg --name x-scout --cwd . node a.js\nenv FOO=1 ls`, 'PowerShell'));
  allowed(pre(p, `hc run --bg --name x-scout --cwd . node a.js ; env GHORC_ROLE=worker claude.exe ${GOOD}`, 'PowerShell'));
  // the Bash tool: `&` is an operator there as well and the guard reads it as one, so the two commands are judged as two (unchanged)
  allowed(pre(p, `${HEAD} & env GHORC_ROLE=worker claude ${ARGS_M}`, 'Bash'));
  allowed(pre(p, `${HEAD} & claude ${ARGS_M}`, 'Bash'));
});

// ---- S1: each decoded hc run is judged against its own blanked run ----
const S1_A = 'hc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude --model sonnet --effort medium -n a1-implementer --permission-mode bypassPermissions "t"';
const S1_B = 'hc run --bg --name b1-implementer --cwd . env "-i" GHORC_ROLE=worker claude --effort medium -n b1-implementer --permission-mode bypassPermissions "t"';
const S1_B_OK = S1_B.replace('env "-i" ', 'env ').replace('--effort', '--model sonnet --effort');
const S1_NPM = 'hc run --bg --name c1-runner --outlive-parent --cwd . npm run dev';
const S1_NODE = 'hc run --bg --name d1-scout --cwd . env "FOO=1" node x.js';
const SEPS = [' ; ', ' && ', '\n', ' | ', ' & '];
test('env wrapper S1: a correct visible start in one run does not switch the quoted-word check off for another run', () => {
  const p = project();
  for (const tool of ['Bash', 'PowerShell']) {
    for (const sep of SEPS) {
      const at = `${tool} ${JSON.stringify(sep)}`;
      for (const c of [S1_A + sep + S1_B, S1_B + sep + S1_A]) {
        const r = pre(p, c, tool);
        assert.ok(denied(r), at + c);
        assert.match(reasonOf(r), QUOTED, at);
      }
      allowed(pre(p, S1_A + sep + S1_B_OK, tool), `${at} two correct starts`);
      allowed(pre(p, S1_B_OK + sep + S1_A, tool), `${at} two correct starts, reversed`);
      allowed(pre(p, S1_A + sep + S1_NPM, tool), `${at} start + hc run npm`);
      allowed(pre(p, S1_NPM + sep + S1_A, tool), `${at} hc run npm + start`);
      allowed(pre(p, S1_A + sep + S1_NODE, tool), `${at} start + env "FOO=1" node`);
      allowed(pre(p, S1_NODE + sep + S1_A, tool), `${at} env "FOO=1" node + start`);
    }
    // a single run is judged as before
    mustDeny(p, S1_B, QUOTED, tool);
    allowed(pre(p, S1_A, tool));
    allowed(pre(p, S1_NODE, tool));
  }
});

test('env wrapper S1: runs that cannot be paired for certain fail closed; a hidden env option is denied as well', () => {
  const p = project();
  for (const tool of ['Bash', 'PowerShell']) {
    // three runs, the hidden one in the middle
    mustDeny(p, `${S1_A} ; ${S1_B} ; ${S1_B_OK.replace(/b1/g, 'e1')}`, QUOTED, tool);
    // a run written inside a shell string is seen by the blanked reading only: the counts differ, the hidden run has no partner
    mustDeny(p, `bash -c "${S1_A.replace('"t"', 't')}" ; ${S1_B}`, QUOTED, tool);
    // the same start twice is one blanked run, and stays allowed
    allowed(pre(p, `${S1_A} ; ${S1_A}`, tool));
    // a hidden env option (not only a hidden claude) next to a visible start
    const hid = 'hc run --bg --name f1-implementer --cwd . env "-v" GHORC_ROLE=worker claude --model sonnet --effort medium -n f1-implementer --permission-mode bypassPermissions "t"';
    mustDeny(p, `${S1_A} ; ${hid}`, QUOTED, tool);
    mustDeny(p, `${hid} ; ${S1_A}`, QUOTED, tool);
  }
  // PowerShell: a mid-line `&` ends a run too, so a hidden run after it is not lost inside the first one
  for (const c of [`${S1_A} & ${S1_B}`, `${S1_B} & ${S1_A}`]) {
    const r = pre(p, c, 'PowerShell');
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), QUOTED);
  }
});
