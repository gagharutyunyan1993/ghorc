'use strict';
// Command forms ported from the vids heavy-check classifier into scripts/lib/cmd.cjs (gh-heavy, step 2). Every family has the forms
// that must be found (deny) and a neighbouring harmless command of the same shape (allow). The heavy patterns stand for a
// project's heavyCommands. The full comparison table is docs-free: it lives with the task report (gh-heavy-forms.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('../scripts/lib/cmd.cjs');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');

const HEAVY = ['^npm\\s+(?:run\\s+)?test\\b', '^npm\\s+run\\s+test:e2e\\b', '^vitest\\b', '^playwright\\s+test\\b'];
const re = cmd.compile(HEAVY);
const heavy = (c, ps = false) => cmd.matches(c, re, { powershell: ps });

// family: [deny forms, allow forms]; a form is a string (Bash tool) or { ps: string } (PowerShell tool)
const FAMILIES = {
  'stdin script: heredoc to a shell, echo|printf piped into a shell': [
    ['bash <<EOF\nnpm test\nEOF', "bash <<'EOF'\nnpm test\nEOF", 'sh <<-EOF\n\tnpm test\n\tEOF', 'cat <<EOF | bash\nnpm test\nEOF', 'bash -s <<EOF\nnpm test\nEOF', "echo 'npm test' | bash", "printf 'npm test\\n' | sh", 'cat <<EOF | tee x.sh | sh\nnpm test\nEOF'],
    ['cat <<EOF\nnpm test\nEOF', 'git commit -F - <<EOF\nnpm test\nEOF', 'bash script.sh <<EOF\nnpm test\nEOF', 'bash -c "echo hi" <<EOF\nnpm test\nEOF', 'bash < run.sh', "echo 'npm test' | cat", 'cat <<EOF | tee x.md\nnpm test\nEOF', 'cat <<EOF | bash\necho hi\nEOF'],
  ],
  'cmd /r, @ prefix, -ec/-lc style shell flags, ksh': [
    ['cmd /r npm test', '@npm test', "sh -ec 'npm test'", "bash -lc 'npm test'", "ksh -c 'npm test'"],
    ['cmd /r echo npm test', '@echo npm test', "sh -ec 'echo npm test'", "ksh -c 'ls'"],
  ],
  'Start-Process: -FilePath .cmd, quoted path, positional arguments, saps': [
    [{ ps: 'Start-Process -FilePath npm.cmd -ArgumentList "run","test"' }, { ps: 'Start-Process -FilePath "C:\\Program Files\\nodejs\\npm.cmd" -ArgumentList test' }, { ps: 'saps npm test' }, { ps: 'Start-Process npm test' }],
    [{ ps: 'Start-Process notepad' }, { ps: 'Start-Process npm -ArgumentList "run lint"' }, { ps: 'saps notepad test' }, { ps: 'Start-Process -FilePath git -ArgumentList status' }],
  ],
  'call operator and a quoted program or path': [
    [{ ps: '& "C:\\Program Files\\nodejs\\npm.cmd" test' }, { ps: "& 'C:\\Program Files\\nodejs\\npm.cmd' test" }, { ps: '& npm.cmd test' }, { ps: '& "npm" test' }, { ps: '&"C:\\x\\npm.cmd" test' }, { ps: '& ".\\node_modules\\.bin\\vitest.cmd" run' }, '"C:\\Program Files\\nodejs\\npm.cmd" test', '"npm" test', "'npm' test"],
    [{ ps: '& git status' }, { ps: '& "C:\\Program Files\\nodejs\\node.exe" --version' }, { ps: '& "C:\\Program Files\\nodejs\\npm.cmd" run lint' }, '"C:\\Program Files\\Git\\bin\\git.exe" status', '"npm" run lint', 'echo "npm test"', 'git commit -m "run npm test"'],
  ],
  'program with a directory or extension: npm.cmd, C:\\x\\npm.cmd, ./node_modules/.bin/vitest, any case': [
    ['npm.cmd test', 'C:\\x\\npm.cmd test', './node_modules/.bin/vitest run', 'Npm.CMD test', { ps: '.\\node_modules\\.bin\\vitest.cmd run' }, 'timeout 5 ./node_modules/.bin/vitest run'],
    ['npm.cmd run lint', 'C:\\x\\npm.cmd install', './node_modules/.bin/eslint .', 'cat npm test.txt', 'ls > npm.txt'],
  ],
  'PowerShell assignment and sub-expressions': [
    [{ ps: '$x = npm test' }, { ps: '$x += npm test' }, { ps: '$x=npm test' }, { ps: '$a, $b = npm test' }, { ps: '$out = (npm test 2>&1)' }, { ps: '[void](npm test)' }],
    [{ ps: '$x = "npm test"' }, { ps: '$x = Get-Content npm.txt' }, { ps: 'Write-Output "npm test"' }, { ps: '$x = Get-Date' }],
  ],
  'powershell without -Command, and -EncodedCommand': [
    ['powershell "npm test"', 'powershell -NoProfile "npm test"', 'powershell -EncodedCommand bgBwAG0AIAB0AGUAcwB0AA==', 'powershell -ec bgBwAG0AIAB0AGUAcwB0AA=='],
    ['powershell "Get-Date"', 'powershell -NoProfile "Get-Date"', 'powershell -File test.ps1', 'powershell -ec ZQBjAGgAbwAgAGgAaQA='],
  ],
  'wrappers wsl, eval, env -S, corepack, cross-env, coproc, builtin, gtimeout': [
    ["wsl bash -c 'npm test'", 'wsl npm test', 'eval "npm test"', "eval 'npm test'", "env -S 'npm test'", 'corepack npm test', 'cross-env CI=1 vitest run', 'coproc npm test', 'builtin command npm test', 'gtimeout 5 npm test'],
    ['wsl ls', 'eval "echo npm test"', "env -S 'ls -la'", 'corepack enable', 'cross-env CI=1 node build.js', 'coproc ls', 'gtimeout 5 ls'],
  ],
  'echo/printf piped into xargs': [
    ['echo test | xargs npm', 'printf "test\\n" | xargs -n1 npm', 'echo x | xargs npm test'],
    ['echo test | xargs echo', 'echo test | xargs echo npm', 'printf "x\\n" | cat'],
  ],
  'shell flow keywords': [
    ['if true; then npm test; fi', 'while true; do npm test; done', 'for i in 1 2; do npm test; done', '! npm test', 'if npm test; then echo ok; fi'],
    ['if true; then echo npm test; fi', 'if true; then echo ok; fi', 'for i in 1 2; do ls; done'],
  ],
  'quote glue, backslash escape, line continuation': [
    ['n\\pm test', 'np""m test', "np''m test", '"np"m test', 'npm "test"', "npm 'test'", 'npm run "test"', 'npm \\\ntest', { ps: 'npm `\ntest' }],
    ['npm run lint \\\n  --fix', 'npm run "lint"', "echo it's fine; ls", 'echo "a;" npm test', 'echo npm \\\ntest'],
  ],
  'redirection in front of the command': [
    ['> out.txt npm test', '2>/dev/null npm test'],
    ['> out.txt echo npm test', '2>/dev/null ls'],
  ],
  'npm aliases and runners: t, tst, exec, x, npx options, node vitest.mjs': [
    ['npm t', 'npm tst', 'npm exec vitest', 'npm exec -- vitest run', 'npm x vitest', 'npm exec -c "vitest run"', 'npx -y vitest run', 'npx --yes vitest@2.1.0 run', 'npx -p vitest vitest run', 'npx --no-install vitest run', 'npx -c "vitest run"', 'npx -- vitest run', 'node node_modules/vitest/vitest.mjs run', 'node ./node_modules/vitest/dist/cli.js run'],
    ['npx -y prettier --check .', 'npm exec -- eslint .', 'npm exec eslint', 'node scripts/build.js', 'node node_modules/eslint/bin/eslint.js .', 'npm view vitest'],
  ],
};

for (const [name, [deny, allow]] of Object.entries(FAMILIES)) {
  test(`form family: ${name}`, () => {
    for (const f of deny) {
      const [c, ps] = typeof f === 'string' ? [f, false] : [f.ps, true];
      assert.equal(heavy(c, ps), true, `deny ${ps ? 'ps' : 'sh'}: ${JSON.stringify(c)}`);
    }
    for (const f of allow) {
      const [c, ps] = typeof f === 'string' ? [f, false] : [f.ps, true];
      assert.equal(heavy(c, ps), false, `allow ${ps ? 'ps' : 'sh'}: ${JSON.stringify(c)}`);
    }
  });
}

test('the ported forms reach a subagent through the hook; the lead and an ordinary command are not denied', () => {
  const cwd = tmpProject({ heavyCommands: HEAVY });
  const call = (command, agent, tool = 'Bash') =>
    runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: sid(), cwd, agent_id: agent, tool_name: tool, tool_input: { command } });
  for (const c of ['bash <<EOF\nnpm test\nEOF', "echo 'npm test' | bash", 'if true; then npm test; fi', 'eval "npm test"', 'npm.cmd test', 'npx -y vitest run']) {
    assert.equal(isDeny(call(c, 'ag1')), true, `agent: ${c}`);
    assert.equal(isDeny(call(c, undefined)), false, `lead: ${c}`);
  }
  for (const c of ['Start-Process -FilePath "C:\\Program Files\\nodejs\\npm.cmd" -ArgumentList test', '& "C:\\Program Files\\nodejs\\npm.cmd" test', '$x = npm test']) {
    assert.equal(isDeny(call(c, 'ag1', 'PowerShell')), true, `agent ps: ${c}`);
  }
  for (const c of ['cat <<EOF\nnpm test\nEOF', 'git commit -m "npm test"', 'npm run lint', 'echo test | xargs echo']) {
    assert.equal(isDeny(call(c, 'ag1')), false, `agent, ordinary: ${c}`);
  }
});

test('the built-in agent-start deny also sees the new wrappers and flow keywords; hc send stays a send', () => {
  const deny = ['if true; then hc run claude; fi', 'wsl hc run claude', 'cross-env X=1 hc run claude', 'bash <<EOF\nhc run claude\nEOF', "echo 'herdr pane run p x' | bash", 'C:\\x\\hc.exe run claude', 'coproc hc keys t5 enter'];
  const ok = ['hc ls', 'wsl hc ls', 'if true; then hc ls; fi', 'cat <<EOF\nhc run claude\nEOF', 'hc send t5 "run"', 'timeout 5 hc send t5 "run"', "echo 'hc run claude' | cat"];
  for (const c of deny) assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), true, c);
  for (const c of ok) assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), false, c);
});

test('a parse problem never throws and never denies more: odd, broken and huge input', () => {
  const odd = [
    '',
    ' ',
    '"',
    "'",
    '`',
    '$(',
    '<<',
    'cat <<',
    'bash <<EOF',
    'bash <<EOF\nnpm test',
    '<<<<<<<<',
    '\\',
    '\\\n',
    '`\n',
    'powershell -ec',
    'powershell -ec !!!!!!!!!!!!',
    'powershell -ec AAAA AAAA',
    'echo | xargs',
    '| | |',
    '& & &',
    '(((((((((((',
    '{{{{{{{{',
    '$x =',
    'saps',
    'Start-Process',
    'Start-Process -FilePath',
    '"unterminated npm test',
    "'unterminated npm test",
    'wsl',
    'eval',
    'env -S',
    'npx -c',
    'a'.repeat(5000),
    '"'.repeat(3000),
    ('echo "x"; ').repeat(400),
    '\u0000\u0001\ud800',
    'npm test'.repeat(500),
  ];
  const t0 = Date.now();
  for (const c of odd) {
    for (const ps of [false, true]) {
      assert.doesNotThrow(() => cmd.matches(c, re, { powershell: ps }), JSON.stringify(c.slice(0, 40)));
      assert.doesNotThrow(() => cmd.hcSendTargets(c, { powershell: ps }));
      assert.doesNotThrow(() => cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY, { powershell: ps }));
    }
  }
  assert.ok(Date.now() - t0 < 10000, 'no catastrophic backtracking');
  // nothing in the harmless ones is a heavy command
  for (const c of ['', ' ', '"', '$(', '<<', 'cat <<', 'bash <<EOF', 'echo | xargs', '| | |', '$x =', 'saps', 'wsl', 'eval', 'env -S', 'npx -c', 'a'.repeat(5000)]) {
    assert.equal(heavy(c), false, JSON.stringify(c.slice(0, 30)));
  }
  // the hook itself survives them
  const cwd = tmpProject({ heavyCommands: HEAVY });
  for (const c of ['bash <<EOF\nnpm test', 'powershell -ec !!!!!!!!!!!!', '`\n', '"'.repeat(2000)]) {
    const r = runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: sid(), cwd, agent_id: 'ag1', tool_name: 'Bash', tool_input: { command: c } });
    assert.equal(r.code, 0, c.slice(0, 30));
  }
});
