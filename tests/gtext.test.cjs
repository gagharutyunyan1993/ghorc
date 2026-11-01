'use strict';
// Wave 2 text worker: opt-in guards in setup, candidatePermissionArgs info line, review.maxFixRounds default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript } = require('./helpers.cjs');

const REPO = path.join(__dirname, '..');
const GUARDS = { capacity: ['capacity', 'enabled', true], heavySlots: ['heavySlots', 'slots', 2], pushGuard: ['handoff', 'pushGuard', true], stickyOnCompact: ['handoff', 'stickyOnCompact', true] };
const lastJson = (o) => JSON.parse(o.trim().split('\n').pop());

function proj(cfg) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-gtext-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-gtext-home-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  if (cfg !== undefined) {
    fs.mkdirSync(path.join(d, '.claude'));
    fs.writeFileSync(path.join(d, '.claude', 'ghorc.json'), JSON.stringify(cfg));
  }
  return { d, home, env: { GHORC_HOME: home }, cfgFile: path.join(d, '.claude', 'ghorc.json'), done: () => [d, home].forEach((x) => fs.rmSync(x, { recursive: true, force: true })) };
}
const run = (p, ...a) => runScript('setup.cjs', '', { args: [...a, '--cwd', p.d], env: p.env });
const item = (p, id) => lastJson(run(p, '--check').out).items.find((i) => i.id === id);

test('guards show in --check as off, and as on when the key is set', () => {
  const off = proj({ other: 1 });
  const on = proj({ capacity: { enabled: true }, heavySlots: { slots: 2 }, handoff: { pushGuard: true, stickyOnCompact: true } });
  try {
    for (const id of Object.keys(GUARDS)) {
      assert.equal(item(off, id).current, 'off', id);
      assert.equal(item(off, id).ok, false);
      assert.equal(item(on, id).current, 'on', id);
      assert.equal(item(on, id).ok, true);
    }
    assert.match(run(off, '--check').out, /WARN\s+capacity .*off/);
  } finally {
    off.done();
    on.done();
  }
});

test('guard items read their key like the guard does: absent, default and invalid are off', () => {
  const d = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'defaults.json'), 'utf8'));
  for (const [sec, key] of Object.values(GUARDS)) assert.ok(!d[sec][key], `default ${sec}.${key} is off`);
  const cases = [
    ['heavySlots', { slots: 0 }, 'off'],
    ['heavySlots', { slots: 1.5 }, 'off'],
    ['heavySlots', { slots: 'x' }, 'off'],
    ['heavySlots', { slots: '' }, 'off'],
    ['heavySlots', { slots: 12 }, 'on'], // clipped to 8 by the wrapper, still on
    ['capacity', { enabled: 'true' }, 'off'],
    ['handoff', { pushGuard: 1 }, 'off'],
    ['handoff', { stickyOnCompact: 'true' }, 'off'],
    ['handoff', { stickyOnCompact: true }, 'on'],
  ];
  for (const [sec, val, want] of cases) {
    const p = proj({ [sec]: val });
    try {
      const id = sec === 'handoff' ? Object.keys(val)[0] : sec;
      assert.equal(item(p, id).current, want, JSON.stringify({ [sec]: val }));
    } finally {
      p.done();
    }
  }
});

test('--apply <guard> sets exactly that key and keeps the rest of the file', () => {
  for (const [id, [sec, key, val]] of Object.entries(GUARDS)) {
    const p = proj({ keep: { a: 1 }, handoff: { statePath: 'S.md' } });
    try {
      const r = run(p, '--apply', id);
      assert.equal(r.code, 0, r.out + r.err);
      const j = JSON.parse(fs.readFileSync(p.cfgFile, 'utf8'));
      assert.equal(j[sec][key], val);
      assert.deepEqual(j.keep, { a: 1 });
      if (sec === 'handoff') assert.equal(j.handoff.statePath, 'S.md');
      for (const other of Object.keys(GUARDS).filter((x) => x !== id)) assert.equal(item(p, other).current, 'off', other);
    } finally {
      p.done();
    }
  }
});

test('--apply all leaves every guard off', () => {
  const p = proj({ x: 1 });
  try {
    const r = run(p, '--apply', 'all');
    assert.equal(r.code, 0, r.out + r.err);
    for (const id of Object.keys(GUARDS)) assert.equal(item(p, id).current, 'off', id);
    const j = JSON.parse(fs.readFileSync(p.cfgFile, 'utf8'));
    assert.equal(j.capacity, undefined);
    assert.equal(j.heavySlots, undefined);
    assert.equal(j.handoff && j.handoff.pushGuard, undefined);
    assert.equal(j.handoff && j.handoff.stickyOnCompact, undefined);
  } finally {
    p.done();
  }
});

test('--apply <guard> with a missing ghorc.json creates it from the template', () => {
  const p = proj(undefined);
  try {
    const r = run(p, '--apply', 'pushGuard');
    assert.equal(r.code, 0, r.out + r.err);
    const j = JSON.parse(fs.readFileSync(p.cfgFile, 'utf8'));
    assert.equal(j.handoff.pushGuard, true);
    assert.ok(j.checks, 'template content kept');
    assert.equal(item(p, 'capacity').current, 'off');
  } finally {
    p.done();
  }
});

test('candidatePermissionArgs: --check reports it, --apply never writes it', () => {
  const p = proj({ handoff: { statePath: 'S.md' } });
  const q = proj({ handoff: { candidatePermissionArgs: ['--permission-mode', 'acceptEdits'] } });
  try {
    assert.match(run(p, '--check').out, /info: handoff\.candidatePermissionArgs is not set/);
    assert.match(run(q, '--check').out, /info: handoff\.candidatePermissionArgs is set/);
    const before = fs.readFileSync(q.cfgFile, 'utf8');
    for (const a of ['all', 'config,claudemd,exclude,heavy,watchdog,capacity,heavySlots,pushGuard,stickyOnCompact']) run(q, '--apply', a);
    const j = JSON.parse(fs.readFileSync(q.cfgFile, 'utf8'));
    assert.deepEqual(j.handoff.candidatePermissionArgs, ['--permission-mode', 'acceptEdits']);
    assert.ok(before.length > 0);
    run(p, '--apply', 'all,pushGuard,stickyOnCompact');
    const k = JSON.parse(fs.readFileSync(p.cfgFile, 'utf8'));
    assert.equal(k.handoff.candidatePermissionArgs, undefined, 'apply does not add the key');
  } finally {
    p.done();
    q.done();
  }
});

test('review.maxFixRounds defaults to 2 and the old texts are gone', () => {
  const d = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'defaults.json'), 'utf8'));
  assert.equal(d.review.maxFixRounds, 2);
  for (const f of ['skills/lead/SKILL.md', 'docs/workflow.md', 'templates/CLAUDE-section.md', 'examples/demo/CLAUDE.md']) {
    const t = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(!/3 rounds/.test(t), f);
    assert.ok(!/herdr agent start\|prompt`/.test(t), f);
  }
});
