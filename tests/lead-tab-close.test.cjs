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

test('leadTabClose check row: false and absent recommend the choice, true is ok', () => {
  for (const handoff of [{ allowSendKeysExit: false }, {}]) {
    const r = row(tmpProject({ handoff }));
    assert.equal(r.ok, false);
    assert.equal(r.warn, true, 'a recommendation, never a failure of the whole check');
    assert.match(r.current, /the owner closes the old lead tab after each handoff \(handoff\.allowSendKeysExit false\)/);
    assert.match(r.recommended, /--apply leadTabClose --closer lead/);
  }
  const proj = tmpProject({ handoff: { allowSendKeysExit: true } });
  const r = row(proj);
  assert.equal(r.ok, true);
  assert.match(r.current, /the new lead closes the old lead tab after a handoff/);
  assert.equal(parse(setup(proj, ['--check']).out).items.find((i) => i.id === 'permissions').warn, true);
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
  assert.equal(row(proj).ok, false);
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
  setup(proj, ['--apply', 'all', '--project']);
  assert.equal(cfgOf(proj).handoff.allowSendKeysExit, false);
  const on = tmpProject({ handoff: { allowSendKeysExit: true } });
  setup(on, ['--apply', 'all', '--project']);
  assert.equal(cfgOf(on).handoff.allowSendKeysExit, true);
});
