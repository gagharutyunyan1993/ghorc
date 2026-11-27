'use strict';
// The herdr fixes of 0.11.4: the send checks, the --cwd rule, the own workspace of a moved pane, GONE, the tab close form,
// the hc close check, the verdict cache, the stderr reason, herdr status and the HERDR_BIN_PATH fallback, and the texts of
// the skills and docs. herdr and hc are fakes here; nothing starts a real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript, isDeny, tmpProject, TEST_TMP } = require('./helpers.cjs');
process.env.GHORC_TMP = TEST_TMP; // the cache and state files of this process equal the ones of the hook processes
const backend = require('../scripts/lib/backend.cjs');
const cap = require('../scripts/lib/capacity.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- helpers (the same shapes as tests/tabs-guard.test.cjs) ----
const hdr = (agents) => JSON.stringify({ result: { agents } });
const NONE = hdr([]);
const row = (name, status, extra = {}) => ({ name, agent_status: status, pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', cwd: '/x', agent_session: { value: `s-${name}` }, ...extra });
const hcl = (terminals) => JSON.stringify({ terminals });
const term = (name, status) => ({ address: `t-${name}`, name, parent: 'self1', state: 'live', status, agent: 'claude-code' });

let seq = 0;
function project() {
  const cwd = fs.realpathSync.native(tmpProject({ tabs: {}, worker: { permissionArgs: ['--permission-mode', 'bypassPermissions'] } }));
  return { cwd, sid: `${String(++seq).padStart(4, '0')}-herdr-fix-x` };
}
// PreToolUse of the lead; kind 'herdr' gives the herdr seam (list text), 'hc' the hc seam, null neither
function pre(p, command, { tool = 'Bash', list = NONE, kind = 'herdr', env = {} } = {}) {
  const seam = kind === 'herdr' ? { GHORC_CAPACITY_HERDR_JSON: list } : kind === 'hc' ? { GHORC_CAPACITY_HC_JSON: list } : {};
  return runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: tool, session_id: p.sid, cwd: p.cwd, tool_input: { command } }, { cwd: p.cwd, env: { CLAUDE_PROJECT_DIR: p.cwd, HERDR_WORKSPACE_ID: 'w1', ...seam, ...env } });
}
const mon = (p, event, env) => runScript('tabs-guard.cjs', { hook_event_name: event, session_id: p.sid, cwd: p.cwd }, { cwd: p.cwd, env: { CLAUDE_PROJECT_DIR: p.cwd, ...env } });
const reasonOf = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
const ctx = (r) => (r.out.trim() ? JSON.parse(r.out).hookSpecificOutput.additionalContext : '');
const denied = (r) => {
  assert.equal(r.code, 0);
  return isDeny(r);
};
function allowed(r, msg) {
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '', `${msg || ''} ${r.out}`);
}

// ---- X2: a pane send is one line without " or a backtick ----
test('tabs-guard: multiline-deny: a herdr pane run|send-text with a newline, a double quote or a backtick is denied, in bash and PowerShell', () => {
  const p = project();
  const bash = [
    'herdr pane run w1:p2 "line one\nline two"',
    "herdr pane run w1:p2 $'line one\\nline two'",
    'herdr pane run w1:p2 "say \\"hi\\""',
    "herdr pane send-text w1:p2 'a `b` c'",
    'MSYS_NO_PATHCONV=1 herdr pane run w1:p2 "x\ny"',
  ];
  for (const c of bash) {
    const r = pre(p, c);
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), /a pane send must be one line/, c);
    assert.match(reasonOf(r), /MSYS_NO_PATHCONV=1 herdr pane run <pane_id> "Read <file> and follow it\."/, c);
  }
  const ps = ['herdr pane run w1:p2 "line one`nline two"', "herdr pane run w1:p2 'say \"hi\"'", 'herdr pane run w1:p2 "a ``b`` c"'];
  for (const c of ps) {
    const r = pre(p, c, { tool: 'PowerShell' });
    assert.ok(denied(r), c);
    assert.doesNotMatch(reasonOf(r), /MSYS_NO_PATHCONV/, c); // msys-hint per shell
    assert.match(reasonOf(r), / herdr pane run <pane_id> "Read <file> and follow it\."/, c);
  }
  // one line, and send-keys (a key name, not text) stay allowed
  allowed(pre(p, 'MSYS_NO_PATHCONV=1 herdr pane run w1:p2 "Read .claude/ghorc-out/a.md and do the task in it."'));
  allowed(pre(p, "herdr pane run w1:p2 'one line'", { tool: 'PowerShell' }));
  allowed(pre(p, 'herdr pane send-keys w1:p2 enter'));
  // the quotes of the shell itself are not the text: a quoted one-line text is fine
  allowed(pre(p, 'echo "a\nb" && herdr pane run w1:p2 "one line"'));
});

test('tabs-guard: documented-forms-pass: every herdr pane send of the lead and handoff skills is allowed as written', () => {
  const p = project();
  const forms = new Set();
  for (const f of ['skills/lead/SKILL.md', 'skills/handoff/SKILL.md', 'docs/with-herdr.md', 'docs/hooks.md', 'docs/handoff.md', 'docs/workflow.md']) {
    for (const m of read(f).matchAll(/(?:MSYS_NO_PATHCONV=1 )?herdr pane (?:run|send-text|send-keys) <pane_id> (?:"[^"\n]*"|enter)/g)) forms.add(m[0]);
  }
  assert.ok(forms.size >= 5, [...forms].join('\n'));
  for (const f of forms) {
    const bash = f.replace(/<pane_id>/g, 'w1:p2').replace(/<[^>]+>/g, 'x');
    assert.match(bash, /^MSYS_NO_PATHCONV=1 /, `${f}: a documented form carries the Git Bash prefix`);
    allowed(pre(p, bash), bash);
    const ps = bash.replace(/^MSYS_NO_PATHCONV=1 /, '');
    allowed(pre(p, ps, { tool: 'PowerShell' }), ps);
  }
});

// ---- X4: the Git Bash forms carry MSYS_NO_PATHCONV=1, the PowerShell forms none ----
test('tabs-guard: msys-hint: the runner form of a dev command has the prefix in bash and none in PowerShell', () => {
  const p = project();
  assert.match(reasonOf(pre(p, 'npm run dev')), /then MSYS_NO_PATHCONV=1 herdr pane run <pane_id> "npm run dev"/);
  const ps = reasonOf(pre(p, 'npm run dev', { tool: 'PowerShell' }));
  assert.match(ps, /, then herdr pane run <pane_id> "npm run dev"/);
  assert.doesNotMatch(ps, /MSYS_NO_PATHCONV/);
});

// ---- X3: nothing goes to a blocked pane; unknown is allowed ----
test('tabs-guard: blocked-deny and unknown-allowed: a send to a pane the list shows blocked is denied, by pane id or agent name', () => {
  const p = project();
  const list = hdr([row('a1-implementer', 'blocked'), row('b1-reviewer', 'unknown', { pane_id: 'w1:p3', tab_id: 'w1:t3' })]);
  for (const c of ['MSYS_NO_PATHCONV=1 herdr pane run w1:p2 "go on"', 'herdr pane send-keys w1:p2 hello enter', 'herdr pane send-text a1-implementer "2"', 'herdr pane run --pane w1:p2 "go on"']) {
    const r = pre(p, c, { list });
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), /is blocked on a dialog \(herdr agent list\)/, c);
    assert.match(reasonOf(r), /herdr pane read w1:p2 --source recent --lines 40/, c);
  }
  allowed(pre(p, 'MSYS_NO_PATHCONV=1 herdr pane run w1:p3 "go on"', { list }));
  allowed(pre(p, 'herdr pane send-keys b1-reviewer enter', { list }));
  allowed(pre(p, 'MSYS_NO_PATHCONV=1 herdr pane run w1:p9 "go on"', { list })); // not in the list
  allowed(pre(p, 'MSYS_NO_PATHCONV=1 herdr pane run w1:p2 "go on"', { list: 'junk' })); // unreadable list: allowed
});

// a fake herdr whose `agent list` answer is the file LIST_FILE, so two runs see two lists
const FAKE = path.join(TEST_TMP, 'fake-herdr-list.cjs');
fs.writeFileSync(FAKE, "const fs=require('fs');const a=process.argv.slice(2).join(' ');if(a==='agent list'){process.stdout.write(fs.readFileSync(process.env.LIST_FILE,'utf8'));process.exit(0);}console.error('unscripted: '+a);process.exit(3);\n");
test('tabs-guard: blocked-deny uses fresh list: the second send reads the list again, not a cached one', () => {
  const p = project();
  const lf = path.join(fs.mkdtempSync(path.join(TEST_TMP, 'list-')), 'list.json');
  const env = { HERDR_ENV: '1', GHORC_HERDR_BIN: JSON.stringify([process.execPath, FAKE]), LIST_FILE: lf };
  const cmd = 'MSYS_NO_PATHCONV=1 herdr pane run w1:p2 "go on"';
  fs.writeFileSync(lf, hdr([row('a1-implementer', 'working')]));
  allowed(pre(p, cmd, { kind: null, env }));
  fs.writeFileSync(lf, hdr([row('a1-implementer', 'blocked')]));
  assert.ok(denied(pre(p, cmd, { kind: null, env })));
  fs.writeFileSync(lf, hdr([row('a1-implementer', 'idle')]));
  allowed(pre(p, cmd, { kind: null, env }));
});

// ---- X6: the own workspace of a pane the owner moved ----
test('tabs-guard: moved-pane: the workspace of this session\'s list row wins over HERDR_PANE_ID', () => {
  const p = project();
  const list = hdr([row('lead-x', 'working', { pane_id: 'w9:p1', tab_id: 'w9:t1', workspace_id: 'w9', agent_session: { value: p.sid } })]);
  const env = { HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1' };
  const tab = (ws) => `herdr tab create --workspace ${ws} --no-focus --label a-implementer --cwd . --env GHORC_ROLE=worker`;
  allowed(pre(p, tab('w9'), { list, env }));
  assert.ok(denied(pre(p, tab('w1'), { list, env })));
  // without the own row the env decides, as before
  allowed(pre(p, tab('w1'), { env }));
});

// ---- X10: --cwd inside the project ----
test('tabs-guard: no-cwd: a herdr tab create without --cwd, or outside the project, is denied', () => {
  const p = project();
  const base = 'herdr tab create --workspace w1 --no-focus --label a-implementer --env GHORC_ROLE=worker';
  const r = pre(p, base);
  assert.ok(denied(r));
  assert.match(reasonOf(r), /--cwd <dir>/);
  const outside = path.dirname(p.cwd).replace(/\\/g, '/');
  assert.ok(denied(pre(p, `${base} --cwd ${outside}`)));
  assert.ok(denied(pre(p, `${base} --cwd ..`)));
  allowed(pre(p, `${base} --cwd .`));
  allowed(pre(p, `${base} --cwd ${p.cwd.replace(/\\/g, '/')}/.claude/worktrees/a`));
  allowed(pre(p, `${base} --cwd .claude/worktrees/a`));
});

// ---- X5 and X15: GONE and the close form ----
test('tabs-guard: gone-flag: a worker that left the list without a result line is flagged once', () => {
  const p = project();
  const list = hdr([row('a1-implementer', 'working', { cwd: p.cwd })]);
  assert.doesNotMatch(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list })), /GONE/);
  const gone = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: NONE }));
  assert.match(gone, /tabs GONE: a1-implementer left herdr agent list without a result line/);
  assert.match(gone, /\.claude\/ghorc-out\/a1-implementer\.md/);
  assert.doesNotMatch(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: NONE })), /GONE/);
});

test('tabs-guard: close-form: a finished herdr worker is closed with herdr tab close and its tab_id', () => {
  const p = project();
  const f = path.join(p.cwd, '.claude', 'ghorc-out', 'a1-implementer.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const list = hdr([row('a1-implementer', 'idle', { tab_id: 'w1:t7', cwd: p.cwd })]);
  mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list });
  fs.writeFileSync(f, '# report\n\nDONE a1-implementer\n');
  const out = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list }));
  assert.match(out, /herdr tab close w1:t7/);
  assert.doesNotMatch(out, /herdr tab list/);
});

// ---- X19: an hc close that did not take ----
test('tabs-guard: hc-close-missing: a name still in hc ls after hc kill / hc rm is reported as CLOSE?', () => {
  const p = project();
  const list = hcl([term('a1-implementer', 'idle')]);
  allowed(pre(p, 'hc kill a1-implementer; hc rm a1-implementer', { kind: 'hc', list }));
  const out = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HC_JSON: list }));
  assert.match(out, /tabs CLOSE\?: a1-implementer is still listed by hc ls after hc kill \/ hc rm/);
  // a name that is gone gives no line
  const q = project();
  allowed(pre(q, 'hc kill b1-implementer; hc rm b1-implementer', { kind: 'hc', list: hcl([]) }));
  assert.doesNotMatch(ctx(mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HC_JSON: hcl([]) })), /CLOSE\?/);
});

// ---- backend: X7, X12, X13 ----
const BIN = path.join(TEST_TMP, 'fake-herdr-dir.cjs');
fs.writeFileSync(
  BIN,
  "const fs=require('fs'),path=require('path');const k=process.argv.slice(2).join('_');const f=(e)=>path.join(process.env.FAKE_DIR,k+'.'+e);\n" +
    "if(fs.existsSync(f('out')))process.stdout.write(fs.readFileSync(f('out'),'utf8'));if(fs.existsSync(f('err')))process.stderr.write(fs.readFileSync(f('err'),'utf8'));\n" +
    "process.exit(fs.existsSync(f('code'))?Number(fs.readFileSync(f('code'),'utf8')):(fs.existsSync(f('out'))?0:3));\n",
);
function fakeDir(files) {
  const d = fs.mkdtempSync(path.join(TEST_TMP, 'hfake-'));
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(d, n), b);
  return d;
}
const HENV = { HC_TERMINAL_ID: '', HERDR_ENV: '1', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '', HERDR_TAB_ID: '', HERDR_BIN_PATH: '', GHORC_TOOL_TIMEOUT_MS: '30000', GHORC_TMP: TEST_TMP };

test('backend: stale-server: backend.cjs on herdr prints herdr status and warns when server_binary_stale is yes', () => {
  const run = (status) => {
    const d = fakeDir({ 'agent_list.out': NONE, 'status.out': status });
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backend.cjs')], { encoding: 'utf8', env: { ...process.env, ...HENV, GHORC_HERDR_BIN: JSON.stringify([process.execPath, BIN]), FAKE_DIR: d } });
    return JSON.parse(r.stdout);
  };
  const stale = run('client version: 0.6.2\nserver version: 0.6.1\nserver_binary_stale: yes\n');
  assert.equal(stale.backend, 'herdr');
  assert.equal(stale.herdr_status.server_binary_stale, 'yes');
  assert.equal(stale.herdr_status.client_version, '0.6.2');
  assert.match(stale.warning, /server_binary_stale.*restart the herdr server/);
  const fresh = run('client version: 0.6.2\nserver version: 0.6.2\nserver_binary_stale: no\n');
  assert.equal(fresh.warning, undefined);
  assert.equal(fresh.herdr_status.server_version, '0.6.2');
});

test('backend: stderr-reason: an odd exit of herdr agent list carries its stderr, cut to 200 characters', () => {
  const d = fakeDir({ 'agent_list.err': `boom:\n  ${'x'.repeat(300)}`, 'agent_list.code': '7' });
  process.env.FAKE_DIR = d; // the probe runs with the environment of this process
  const r = backend.detect({ env: { ...HENV, GHORC_HERDR_BIN: JSON.stringify([process.execPath, BIN]) } });
  delete process.env.FAKE_DIR;
  assert.equal(r.backend, 'none');
  assert.equal(r.failed, true);
  assert.match(r.reason, /^herdr agent list exited with 7: boom: x+$/);
  assert.equal(r.reason.length, 'herdr agent list exited with 7: '.length + 200);
});

test('backend: cache-verdict-only: a probe that fails within 30 s of an answer keeps herdr without a list; capacity is unknown, not 0', () => {
  const session = `cache-${process.pid}-${Date.now()}`;
  const env = { ...HENV };
  let calls = 0;
  const ok = () => {
    calls++;
    return hdr([row('a1-implementer', 'working')]);
  };
  const timeout = () => {
    calls++;
    const e = new Error('spawnSync herdr ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    throw e;
  };
  assert.equal(backend.detect({ env, exec: ok, session }).backend, 'herdr');
  const before = calls;
  const v = backend.detect({ env, exec: ok, session, verdictOnly: true });
  assert.equal(v.backend, 'herdr');
  assert.equal(calls, before, 'verdictOnly answers from the cache without a call');
  const f = backend.detect({ env, exec: timeout, session });
  assert.deepEqual([f.backend, f.failed, f.raw], ['herdr', true, undefined]);
  assert.match(f.reason, /less than 30 s ago/);
  assert.equal(cap.liveWorkers(session, 'lead-', () => {}, { env, exec: timeout }), null);
  // without a session (no cache) a timeout is none/failed, as before
  assert.deepEqual([backend.detect({ env, exec: timeout }).backend, backend.detect({ env, exec: timeout }).failed], ['none', true]);
  // a stopped server is an answer and drops the cache
  backend.detect({ env, exec: () => '{"error":{"code":"server_not_running"}}', session });
  assert.equal(backend.detect({ env, exec: timeout, session }).backend, 'none');
});

test('backend: HERDR_BIN_PATH is tried only when herdr is not on PATH', () => {
  const seen = [];
  const exec = (file) => {
    seen.push(file);
    if (file === 'herdr') {
      const e = new Error('not found');
      e.code = 'ENOENT';
      throw e;
    }
    return NONE;
  };
  const d = backend.detect({ env: { ...HENV, GHORC_HERDR_BIN: '', HERDR_BIN_PATH: '/opt/herdr/bin/herdr' }, exec });
  assert.equal(d.backend, 'herdr');
  assert.deepEqual(seen, ['herdr', '/opt/herdr/bin/herdr']);
  seen.length = 0;
  backend.detect({ env: { ...HENV, GHORC_HERDR_BIN: '', HERDR_BIN_PATH: '/opt/herdr/bin/herdr' }, exec: (file) => (seen.push(file), NONE) });
  assert.deepEqual(seen, ['herdr'], 'herdr on PATH is used, the fallback is not asked');
  seen.length = 0;
  assert.equal(backend.detect({ env: { ...HENV, GHORC_HERDR_BIN: '', HERDR_BIN_PATH: '' }, exec }).backend, 'none');
});

// ---- the texts: X5, X9, X11, X16, X17, X19 ----
test('texts: agent name, not tab label, and GHORC_ROLE=lead for a lead started by hand (X9)', () => {
  for (const f of ['skills/lead/SKILL.md', 'skills/handoff/SKILL.md', 'docs/configuration.md', 'docs/with-herdr.md']) {
    const t = read(f);
    assert.doesNotMatch(t, /herdr: tab label starting|herdr tab label starting|the tab label starts with that prefix/, f);
    assert.match(t, /agent name/, f);
  }
  assert.match(read('skills/lead/SKILL.md'), /a lead started by hand has no agent name, so start it with `GHORC_ROLE=lead`/);
  assert.match(read('docs/with-herdr.md'), /start it with `GHORC_ROLE=lead`/);
});

test('texts: wait-output for the shell prompt uses a single-quoted regex that also matches the zsh % (X11)', () => {
  for (const f of ['skills/lead/SKILL.md', 'skills/handoff/SKILL.md', 'docs/with-herdr.md']) {
    assert.ok(read(f).includes("herdr pane wait-output <pane_id> --regex '[>$#%] ?$' --timeout 15000"), f);
    assert.doesNotMatch(read(f), /--regex "\[/, f);
  }
});

test('texts: tested herdr version, UNVERIFIED hc forms and the not_found answer (X5, X17, X19)', () => {
  const h = read('docs/with-herdr.md');
  assert.match(h, /Tested versions: the live checks quoted on this page ran on herdr 0\.9\.5/);
  assert.match(h, /UNVERIFIED/);
  const lead = read('skills/lead/SKILL.md');
  assert.match(lead, /The `hc` forms are UNVERIFIED/);
  assert.match(lead, /`not_found` on `herdr agent wait <n>` means the tab was closed/);
  assert.match(lead, /\| `herdr tab close <tab_id>` \(`tab_id` of its `herdr agent list` row/);
});

test('lead-tab-close: empty-tab: after the old lead\'s pane close the handoff closes an empty old tab (X16)', () => {
  const t = read('skills/handoff/SKILL.md');
  assert.match(t, /after it run `herdr tab list` and `herdr pane list`; if the old tab id from `old_lead:` is still listed and no pane of that tab is, close it with `herdr tab close <old_tab_id>`/);
});

// ---- review round: R1 to R11 ----
const stop = (p, env) => runScript('tabs-guard.cjs', { hook_event_name: 'Stop', session_id: p.sid, cwd: p.cwd, stop_hook_active: false }, { cwd: p.cwd, env: { CLAUDE_PROJECT_DIR: p.cwd, ...env } });

test('tabs-guard: R1: CLOSE? and GONE survive a Stop that does not block, and show at the next prompt once', () => {
  const p = project();
  const hl = hcl([term('a1-implementer', 'idle')]);
  allowed(pre(p, 'hc kill a1-implementer; hc rm a1-implementer', { kind: 'hc', list: hl }));
  assert.equal(stop(p, { GHORC_CAPACITY_HC_JSON: hl }).out.trim(), '');
  assert.match(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HC_JSON: hl })), /tabs CLOSE\?: a1-implementer/);
  assert.doesNotMatch(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HC_JSON: hl })), /CLOSE\?/);
  const q = project();
  mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([row('b1-implementer', 'working', { cwd: q.cwd })]) });
  assert.equal(stop(q, { GHORC_CAPACITY_HERDR_JSON: NONE }).out.trim(), '');
  assert.match(ctx(mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: NONE })), /tabs GONE: b1-implementer/);
  assert.doesNotMatch(ctx(mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: NONE })), /GONE/);
});

test('tabs-guard: R2: single keys to a blocked pane stay allowed, text is denied and the deny names the key form', () => {
  const p = project();
  const list = hdr([row('a1-implementer', 'blocked')]);
  for (const c of ['MSYS_NO_PATHCONV=1 herdr pane send-keys w1:p2 2 enter', 'herdr pane send-keys w1:p2 y', 'herdr pane send-keys a1-implementer escape', 'herdr pane send-keys w1:p2 down enter', 'herdr pane send-keys w1:p2 ctrl-c']) {
    allowed(pre(p, c, { list }), c);
  }
  const r = pre(p, 'herdr pane send-keys w1:p2 yes please enter', { list });
  assert.ok(denied(r));
  assert.match(reasonOf(r), /send it as single keys: MSYS_NO_PATHCONV=1 herdr pane send-keys w1:p2 <key> enter/);
  assert.ok(denied(pre(p, 'herdr pane run w1:p2 2', { list })));
});

test('tabs-guard: R3: a --cwd with an escaped space is decoded (bash backslash, PowerShell backtick)', () => {
  const base = project();
  const spaced = path.join(path.dirname(base.cwd), `proj x ${process.pid}-${Date.now()}`);
  fs.cpSync(base.cwd, spaced, { recursive: true });
  const p = { cwd: spaced, sid: base.sid };
  const fwd = spaced.replace(/\\/g, '/');
  const head = 'herdr tab create --workspace w1 --no-focus --label a-implementer --env GHORC_ROLE=worker --cwd ';
  allowed(pre(p, head + fwd.replace(/ /g, '\\ ') + '/.claude/worktrees/p2'));
  allowed(pre(p, head + fwd.replace(/ /g, '` ') + '/.claude/worktrees/p2', { tool: 'PowerShell' }));
  allowed(pre(p, head + '"' + fwd + '"'));
  const other = path.dirname(fwd) + '/other\\ dir';
  const r = pre(p, head + other);
  assert.ok(denied(r));
  assert.match(reasonOf(r), /other dir is outside the project/);
});

test('tabs-guard: R4: a comment after a send is not part of its text', () => {
  const p = project();
  allowed(pre(p, 'MSYS_NO_PATHCONV=1 herdr pane run w1:p3 "Read b.md" # it\'s fine\necho done'));
  assert.ok(denied(pre(p, '# a note\nMSYS_NO_PATHCONV=1 herdr pane run w1:p3 "a \\"b\\""')));
});

test('tabs-guard: R5: the send checks look through timeout, nice, stdbuf, setsid, env, command and exec', () => {
  const p = project();
  const list = hdr([row('a1-implementer', 'blocked')]);
  for (const w of ['timeout 30', 'timeout -s KILL 5s', 'nice -n 5', 'stdbuf -oL', 'setsid', 'env -u FOO', 'command', 'exec', 'nice timeout 3']) {
    assert.ok(denied(pre(p, `${w} herdr pane run w1:p3 "a\nb"`)), `${w}: newline`);
    assert.ok(denied(pre(p, `${w} herdr pane run w1:p2 "go on"`, { list })), `${w}: blocked`);
    allowed(pre(p, `${w} herdr pane run w1:p3 "go on"`, { list }), `${w}: fine`);
  }
});

test('tabs-guard: R6: no GONE for a long-lived tab or for a worker that is still listed', () => {
  const p = project();
  mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([row('t-runner', 'working', { cwd: p.cwd }), row('b1-implementer', 'working', { cwd: p.cwd, pane_id: 'w1:p4' })]) });
  // the runner closed; the worker moved its cwd out of the project but is still in the list
  const out = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([row('b1-implementer', 'working', { cwd: '/elsewhere', pane_id: 'w1:p4' })]) }));
  assert.doesNotMatch(out, /GONE/);
});

test('backend: R8: a fresh verdict is not rewritten, and old cache files are pruned with the tabs state', () => {
  const tabs = require('../scripts/lib/tabs.cjs');
  const session = `rw-${process.pid}-${Date.now()}`;
  const env = { ...HENV };
  const file = path.join(TEST_TMP, `backend-${session}.json`);
  backend.detect({ env, exec: () => NONE, session });
  const first = JSON.parse(fs.readFileSync(file, 'utf8')).at;
  const t0 = Date.now();
  while (Date.now() - t0 < 20); // a later clock
  backend.detect({ env, exec: () => NONE, session });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at, first);
  const old = path.join(TEST_TMP, 'backend-very-old-session.json');
  fs.writeFileSync(old, '{}');
  const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  tabs.writeTabState(`prune-${session}`, { workers: {} });
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(file), true);
});

test('tabs-guard: R11: after a pane move the variable form of --workspace is denied and the row id is shown', () => {
  const p = project();
  const list = hdr([row('lead-x', 'working', { pane_id: 'w9:p1', tab_id: 'w9:t1', workspace_id: 'w9', agent_session: { value: p.sid } })]);
  const env = { HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1' };
  const tab = (ws) => `herdr tab create --workspace ${ws} --no-focus --label a-implementer --cwd . --env GHORC_ROLE=worker`;
  const r = pre(p, tab('"$HERDR_WORKSPACE_ID"'), { list, env });
  assert.ok(denied(r));
  assert.match(reasonOf(r), /still expands to w1, but this pane is now in w9/);
  assert.match(reasonOf(r), /--workspace w9/);
  allowed(pre(p, tab('"$HERDR_WORKSPACE_ID"'), { env })); // no row: the variable is the own workspace
  allowed(pre(p, tab('w9'), { list, env }));
});

test('texts: R9: the forms in docs/handoff.md, docs/workflow.md and the with-herdr table carry the prefix and --cwd', () => {
  assert.doesNotMatch(read('docs/handoff.md'), /(?<!MSYS_NO_PATHCONV=1 )herdr pane run <pane_id> "/);
  assert.match(read('docs/workflow.md'), /MSYS_NO_PATHCONV=1 herdr pane send-keys <pane_id> enter/);
  assert.match(read('skills/lead/SKILL.md'), /press Enter once with `MSYS_NO_PATHCONV=1 herdr pane send-keys <pane_id> enter`/);
  assert.match(read('docs/with-herdr.md'), /--no-focus --label n --cwd d --env GHORC_ROLE=worker` \+ `herdr agent start`/);
});

test('tabs-guard: --cwd forms: the session directory and plain paths pass; variables, expansions and ~ are denied', () => {
  const p = project();
  const head = 'herdr tab create --workspace w1 --no-focus --label a-implementer --env GHORC_ROLE=worker --cwd ';
  const ok = ['.', '$PWD', '${PWD}', '"$PWD"', '$(pwd)', '$PWD/.claude/worktrees/a', '"$PWD/.claude/worktrees/a b"', '${PWD}/sub', '$(pwd)/sub', '.claude/worktrees/a'];
  for (const v of ok) allowed(pre(p, head + v), v);
  for (const v of ['$PWD', '"$PWD\\sub"', '.']) allowed(pre(p, head + v, { tool: 'PowerShell' }), `ps ${v}`);
  const bad = ['$HOME/x', '"$HOME/x"', '%TEMP%', '~', '~/x', '$(echo /tmp)', '$PWD/../x', '"$OTHER"', '${HOME}', '`pwd`/x'];
  for (const v of bad) {
    const r = pre(p, head + v);
    assert.ok(denied(r), v);
    assert.match(reasonOf(r), /--cwd .*(cannot|leaves|outside)/, v);
    assert.match(reasonOf(r), /plain absolute or relative path inside the project|outside the project/, v);
  }
  for (const v of ['$env:PWD', '$env:TEMP', '$HOME', '%TEMP%']) assert.ok(denied(pre(p, head + v, { tool: 'PowerShell' })), `ps ${v}`);
});

test('tabs-guard: --cwd parser differential: wrapped commands and two tab creates are judged on their own values', () => {
  const p = project();
  const tc = (label, cwd) => `herdr tab create --workspace w1 --no-focus --label ${label} --env GHORC_ROLE=worker --cwd ${cwd}`;
  // wrappers
  assert.ok(denied(pre(p, `timeout 5 ${tc('a-implementer', '"/tmp/x"')}`)));
  allowed(pre(p, `timeout 5 ${tc('a-implementer', '"."')}`));
  assert.ok(denied(pre(p, `bash -c "${tc('a-implementer', "'/tmp/x'")}"`)));
  allowed(pre(p, `bash -c "${tc('a-implementer', '.')}"`));
  // two tab creates, one outside: the inside one must not stand in for the other
  for (const c of [
    `${tc('a-implementer', '"."')}; bash -c "${tc('b-implementer', "'/tmp/x'")}"`,
    `${tc('a-implementer', '.')}; ${tc('b-implementer', '/tmp/x')}`,
    `${tc('a-implementer', '"."')}; ${tc('b-implementer', '"/tmp/x"')}`,
    `${tc('a-implementer', '"/tmp/x"')} && ${tc('b-implementer', '.')}`,
  ]) assert.ok(denied(pre(p, c)), c);
  allowed(pre(p, `${tc('a-implementer', '.')}; ${tc('b-implementer', '.claude/worktrees/b')}`));
});

test('tabs-guard: --cwd one parser: each tab create is judged on its own decoded words, never on another --cwd in the line', () => {
  const base = project();
  const spaced = path.join(path.dirname(base.cwd), `proj y ${process.pid}-${Date.now()}`);
  fs.cpSync(base.cwd, spaced, { recursive: true });
  const p = { cwd: spaced, sid: base.sid };
  const fwd = spaced.replace(/\\/g, '/');
  const outside = path.dirname(fwd) + '/other y';
  const tc = (label, cwd) => `herdr tab create --workspace w1 --no-focus --label ${label} --env GHORC_ROLE=worker --cwd ${cwd}`;
  const tick = (x) => x.replace(/ /g, '` ');
  // PowerShell, one tab create with a backtick-escaped space, and another --cwd elsewhere in the line
  allowed(pre(p, `${tc('a-implementer', tick(fwd) + '/.claude/worktrees/p2')}; Write-Output "--cwd /tmp"`, { tool: 'PowerShell' }));
  assert.ok(denied(pre(p, `${tc('a-implementer', tick(outside))}; Write-Output "--cwd ${fwd}"`, { tool: 'PowerShell' })));
  assert.ok(denied(pre(p, `Write-Output "--cwd ${fwd}"; ${tc('a-implementer', tick(outside))}`, { tool: 'PowerShell' })));
  // a quoted outside path next to an in-project path of another tab create, both orders and both shells
  for (const tool of ['Bash', 'PowerShell']) {
    assert.ok(denied(pre(p, `${tc('a-implementer', '"/tmp/x"')}; ${tc('b-implementer', '"."')}`, { tool })), tool);
    assert.ok(denied(pre(p, `${tc('a-implementer', '"."')}; ${tc('b-implementer', "'/tmp/x'")}`, { tool })), tool);
  }
  // --cwd after -- is not an option of the tab create
  const head = 'herdr tab create --workspace w1 --no-focus --label a-implementer --env GHORC_ROLE=worker';
  assert.ok(denied(pre(p, `${head} -- --cwd .`)));
  assert.ok(denied(pre(p, `${head} --cwd /tmp/x -- --cwd .`)));
  allowed(pre(p, `${head} --cwd . -- --cwd /tmp/x`));
  // a quote that is not closed
  assert.match(reasonOf(pre(p, `${head} --cwd "/tmp/x`)), /plain absolute or relative path inside the project|outside the project/);
});

test('tabs-guard: --cwd review cases: blocks, heredocs fed to a shell, .., cd, escaped quotes and $env:PWD are judged; legit forms pass', () => {
  const tabs = require('../scripts/lib/tabs.cjs');
  const s = tabs.settings({});
  const root = 'D:/proj/app';
  const verdict = (cmd, ps) => (tabs.checkCommand(cmd, { powershell: ps, s, list: () => [], root, cwd: root, self: '', session: 'x', workspace: 'w1', envWorkspace: 'w1' }) ? 'deny' : 'allow');
  const B = 'herdr tab create --workspace w1 --no-focus --label a-implementer --env GHORC_ROLE=worker';
  const P = 'herdr tab create --workspace $env:HERDR_WORKSPACE_ID --no-focus --label a-implementer --env GHORC_ROLE=worker';
  const T = (ws, cwd, extra = '') => `herdr tab create --workspace ${ws} --no-focus --label a-implementer --cwd ${cwd} --env GHORC_ROLE=worker${extra}`;
  const BW = '"$HERDR_WORKSPACE_ID"';
  const PW = '$env:HERDR_WORKSPACE_ID';
  // [id, command, powershell, verdict]
  const cases = [
    // R-1: tab creates in blocks, substitutions, xargs, Start-Process and heredocs fed to a shell
    ['G1', `{ ${B} --cwd /tmp; }`, false, 'deny'],
    ['R4', `{ ${B} --cwd /tmp; } > out.json`, false, 'deny'],
    ['G5', `echo \`${B} --cwd /tmp\``, false, 'deny'],
    ['G7', `echo x | xargs ${B} --cwd /tmp`, false, 'deny'],
    ['P1', `if ($true) { ${P} --cwd C:/tmp }`, true, 'deny'],
    ['P2', `1..2 | ForEach-Object { ${P} --cwd C:/tmp }`, true, 'deny'],
    ['P3', `& { ${P} --cwd C:/tmp }`, true, 'deny'],
    ['R1', `foreach ($d in @('C:/tmp')) { ${P} --cwd $d }`, true, 'deny'],
    ['R3', `try { ${P} --cwd C:/tmp } catch { $_ }`, true, 'deny'],
    ['P9', `Start-Process herdr -ArgumentList 'tab create --workspace w1 --no-focus --label a-implementer --env GHORC_ROLE=worker --cwd C:/tmp'`, true, 'deny'],
    ['H2', `Write-Output x # <<EOF\n${P} --cwd C:/tmp\nEOF`, true, 'deny'],
    ['H3', `bash <<EOF\n${B} --cwd /tmp\nEOF`, false, 'deny'],
    ['R5', `bash <<'EOF'\nset -e\n${B} --cwd /tmp\nEOF`, false, 'deny'],
    ['H4', `cat <<EOF | sh\n${B} --cwd /tmp\nEOF`, false, 'deny'],
    ['P4', `<# c #> ${P} --cwd C:/tmp`, true, 'deny'],
    ['N1', `cmd /c start "" ${B} --cwd C:/tmp`, false, 'deny'], // seen by parseCommand only: the count check denies it
    // R-2: absolute values are normalized
    ['A1', `${B} --cwd D:/proj/app/..`, false, 'deny'],
    ['A2', `${B} --cwd D:/proj/app/.claude/worktrees/../../..`, false, 'deny'],
    ['A3', `${P} --cwd 'D:\\proj\\app\\..\\other'`, true, 'deny'],
    ['A4', `${B} --cwd /d/proj/app/../other`, false, 'deny'],
    ['A5', `${B} --cwd D:/proj/app/x/../..`, false, 'deny'],
    ['A6', `${B} --cwd D:/proj/app/.claude/worktrees/a/../b`, false, 'allow'],
    ['A7', `${P} --cwd d:\\proj\\APP`, true, 'allow'],
    // R-3: $env:PWD is the client's environment, not the session's directory
    ['Q4', `${P} --cwd "$env:PWD"`, true, 'deny'],
    ['F17', T(PW, '"$env:PWD"'), true, 'deny'],
    // R-4: a cd earlier in the same command
    ['C1', `cd .. && ${B} --cwd .`, false, 'deny'],
    ['C2', `cd D:/other; ${B} --cwd "$PWD"`, false, 'deny'],
    ['C3', `Set-Location C:/; ${P} --cwd .`, true, 'deny'],
    ['C4', `pushd /tmp && ${B} --cwd $PWD`, false, 'deny'],
    ['K1', `cd D:/proj/app && ${B} --cwd D:/proj/app/.claude/worktrees/a`, false, 'allow'],
    // R-5: escaped quotes inside sh -c "..." and pwsh -c "..."
    ['R6', `sh -c "${B} --cwd \\"D:/other proj\\""`, false, 'deny'],
    ['W2', `sh -c "${B} --cwd \\"/tmp\\""`, false, 'deny'],
    ['E1', `sh -c "${B} --cwd \\"D:/proj/app/x y\\""`, false, 'allow'],
    ['E2', `pwsh -c "${P} --cwd \`"C:/other\`""`, true, 'deny'],
    // R-6: bash $pwd is another variable
    ['L1', `${B} --cwd $pwd/sub`, false, 'deny'],
    ['L2', `${B} --cwd $Pwd`, false, 'deny'],
    ['L4', `${P} --cwd $pwd`, true, 'allow'],
    // R-7: an unclosed-looking quote outside a tab create
    ['F13', "git commit -m @'\nfix(tabs): herdr tab create --cwd, don't miss it\n'@", true, 'allow'],
    ['F15', "echo herdr tab create docs; echo it's", false, 'allow'],
    ['U1', `${B} --cwd 'D:/proj/app`, false, 'deny'],
    // legit forms of the skills and docs
    ['F1', T(BW, 'D:/proj/app/.claude/worktrees/a'), false, 'allow'],
    ['F2', T(PW, 'D:\\proj\\app\\.claude\\worktrees\\a'), true, 'allow'],
    ['F3', T(BW, "'D:\\proj\\app'"), false, 'allow'],
    ['F4', T(BW, '/d/proj/app/.claude/worktrees/a'), false, 'allow'],
    ['F5', T(BW, '"$PWD"'), false, 'allow'],
    ['F6', T(PW, '$PWD'), true, 'allow'],
    ['F8', T(PW, '"$PWD\\.claude\\worktrees\\a"'), true, 'allow'],
    ['F9', 'MSYS_NO_PATHCONV=1 ' + T(BW, '.'), false, 'allow'],
    ['F10', 'PANE=$(' + T(BW, '"$PWD"') + " | jq -r '.result.root_pane.pane_id') && herdr pane wait-output \"$PANE\" --regex '[>$#%] ?$' --timeout 15000", false, 'allow'],
    ['F12', T(BW, '.claude/worktrees/a', ' # start the worker'), false, 'allow'],
    ['F14', 'git commit -m "$(cat <<\'EOF\'\nfix: herdr tab create --cwd, don\'t miss it\nEOF\n)"', false, 'allow'],
    ['F16', T(BW, '"D:/proj/app/.claude/worktrees/\u0422\u0435\u0441\u0442 x"'), false, 'allow'],
    ['G9', `TAB="$(${B} --cwd "$PWD" | jq -r .id)"`, false, 'allow'],
    ['Q1', `${B} --cwd "$PWD"`, false, 'allow'],
    ['Q2', `${B} --cwd "$(pwd)/.claude/worktrees/x"`, false, 'allow'],
    ['Q3', `${P} --cwd $PWD`, true, 'allow'],
    ['Q5', `${P} --cwd $PWD/.claude/worktrees/x`, true, 'allow'],
    ['Q6', `${B} --cwd .claude/worktrees/x`, false, 'allow'],
    ['Y1', `{ ${B} --cwd D:/proj/app; } > out.json`, false, 'allow'],
    ['Y2', `foreach ($d in 1) { ${P} --cwd D:/proj/app/.claude/worktrees/a }`, true, 'allow'],
    ['Y3', `echo {a,b} && ${B} --cwd .`, false, 'allow'],
  ];
  const wrong = cases.filter(([, c, ps, want]) => verdict(c, ps) !== want).map(([id, , , want]) => `${id} (want ${want})`);
  assert.deepEqual(wrong, []);
  // the count check and a tokenizer error deny with the plain-path hint
  const r = tabs.checkCommand(`cmd /c start "" ${B} --cwd C:/tmp`, { powershell: false, s, list: () => [], root, cwd: root, self: '', session: 'x', workspace: 'w1', envWorkspace: 'w1' });
  assert.match(r, /cannot read the --cwd of a tab create in this command/);
});
