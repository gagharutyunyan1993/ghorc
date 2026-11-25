'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, tmpProject } = require('./helpers.cjs');

const parse = (o) => JSON.parse(o.trim().split('\n').pop());

function setup(proj, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-ltc-'));
  try {
    return runScript('setup.cjs', '', { args: [...args, '--cwd', proj], env: { GHORC_HOME: home, CLAUDE_PROJECT_DIR: '' } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const row = (proj) => parse(setup(proj, ['--check']).out).items.find((i) => i.id === 'leadTabClose');
const cfgOf = (proj) => JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'ghorc.json'), 'utf8'));

test('leadTabClose check row: chosen (true or false) is ok, absent or invalid is a non-failing WARN', () => {
  const t = row(tmpProject({ handoff: { allowSendKeysExit: true } }));
  assert.equal(t.ok, true);
  assert.match(t.current, /the new lead closes the old lead tab after a handoff/);
  const f = row(tmpProject({ handoff: { allowSendKeysExit: false } }));
  assert.equal(f.ok, true);
  assert.match(f.current, /the owner closes the old lead tab after a handoff \(chosen\)/);
  for (const cfg of [{ handoff: {} }, {}, { handoff: [1] }]) {
    const r = row(tmpProject(cfg));
    assert.equal(r.ok, false);
    assert.equal(r.warn, true);
    assert.match(r.current, /^not chosen: the owner closes the old lead tab after each handoff \(default\)$/);
    assert.match(r.recommended, /ask the owner: --apply leadTabClose --closer <lead\|owner>/);
  }
  const bad = row(tmpProject({ handoff: { allowSendKeysExit: 'true' } }));
  assert.equal(bad.ok, false);
  assert.equal(bad.warn, true);
  assert.match(bad.current, /handoff\.allowSendKeysExit is "true", not true or false/);
});

test('leadTabClose: the check is clean while the row is WARN', () => {
  const proj = tmpProject({ handoff: {} });
  fs.mkdirSync(path.join(proj, '.git', 'info'), { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-ltc-'));
  const env = { GHORC_HOME: home, CLAUDE_PROJECT_DIR: '' };
  try {
    const ap = runScript('setup.cjs', '', { args: ['--apply', 'all', '--cwd', proj], env });
    assert.equal(ap.code, 0, ap.out + ap.err);
    const c = parse(runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out);
    assert.equal(c.items.find((i) => i.id === 'leadTabClose').ok, false);
    assert.equal(c.clean, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('leadTabClose apply: lead writes true, owner writes false, other keys survive', () => {
  const proj = tmpProject({ handoff: { readyTimeoutMin: 7, allowSendKeysExit: false }, heavyCommands: ['x'] });
  const a = setup(proj, ['--apply', 'leadTabClose', '--closer', 'lead']);
  assert.equal(a.code, 0, a.out + a.err);
  let c = cfgOf(proj);
  assert.equal(c.handoff.allowSendKeysExit, true);
  assert.equal(c.handoff.readyTimeoutMin, 7);
  assert.deepEqual(c.heavyCommands, ['x']);
  assert.equal(row(proj).ok, true);
  assert.ok(fs.readFileSync(path.join(proj, '.claude', 'ghorc.json'), 'utf8').endsWith('}\n'));
  const b = setup(proj, ['--apply', 'leadTabClose', '--closer', 'owner']);
  assert.equal(b.code, 0, b.out + b.err);
  c = cfgOf(proj);
  assert.equal(c.handoff.allowSendKeysExit, false);
  assert.equal(c.handoff.readyTimeoutMin, 7);
  assert.equal(row(proj).ok, true, 'an explicit owner choice is a choice');
});

test('leadTabClose apply: a missing or unknown --closer fails and writes nothing', () => {
  const proj = tmpProject({ handoff: { allowSendKeysExit: false } });
  const file = path.join(proj, '.claude', 'ghorc.json');
  const before = fs.readFileSync(file, 'utf8');
  for (const args of [['--apply', 'leadTabClose'], ['--apply', 'leadTabClose', '--closer', 'nobody']]) {
    const r = setup(proj, args);
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /leadTabClose needs --closer <lead\|owner>/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('leadTabClose is never applied by --apply all', () => {
  const proj = tmpProject({ handoff: { allowSendKeysExit: false } });
  assert.equal(setup(proj, ['--apply', 'all', '--project']).code, 0);
  assert.equal(cfgOf(proj).handoff.allowSendKeysExit, false);
  const on = tmpProject({ handoff: { allowSendKeysExit: true } });
  assert.equal(setup(on, ['--apply', 'all', '--project']).code, 0);
  assert.equal(cfgOf(on).handoff.allowSendKeysExit, true);
});

test('leadTabClose apply: no project config creates it from the template with the chosen value', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-ltc-proj-'));
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    assert.equal(row(proj).ok, false);
    const r = setup(proj, ['--apply', 'leadTabClose', '--closer', 'lead']);
    assert.equal(r.code, 0, r.out + r.err);
    const c = cfgOf(proj);
    assert.equal(c.handoff.allowSendKeysExit, true);
    assert.ok(c.watchdog, 'the rest of the template is there');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('leadTabClose apply: an invalid-JSON config fails and stays byte-identical', () => {
  const proj = tmpProject({});
  const file = path.join(proj, '.claude', 'ghorc.json');
  fs.writeFileSync(file, '{ not json');
  const r = setup(proj, ['--apply', 'leadTabClose', '--closer', 'lead']);
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('leadTabClose apply: a handoff value that is an array becomes a plain object with the choice', () => {
  const proj = tmpProject({ handoff: [1] });
  const r = setup(proj, ['--apply', 'leadTabClose', '--closer', 'owner']);
  assert.equal(r.code, 0, r.out + r.err);
  const c = cfgOf(proj);
  assert.equal(Array.isArray(c.handoff), false);
  assert.deepEqual(c.handoff, { allowSendKeysExit: false });
});
