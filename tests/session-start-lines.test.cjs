'use strict';
// session-start builds its output from whole lines with a fixed drop priority (LIMIT 299) and never cuts inside a line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, tmpProject } = require('./helpers.cjs');
const config = require('../scripts/lib/config.cjs');
const tmpLib = require('../scripts/lib/tmp.cjs');

const MORE = '+more: run ctx';
// every line the script can print here, with its drop priority (higher goes first)
const KNOWN = [
  [/^\d+ watchdog alerts pending, run ctx$/, 7],
  [/^ {2}2026-01-01T00:00:0\dZ x+\d$/, 8],
  [/^ghorc \S+ session=\S+ role=\S+$/, 0],
  [/^handoff\.stickyOnCompact is on, but GHORC_ROLE is not set: .*otherwise set GHORC_ROLE=lead$/, 3],
  [/^config: ok$/, 2],
  [/^lead: load skill ghorc:lead$/, 0],
  [/^CLAUDE\.md is missing, so it has no ghorc section: paste templates\/CLAUDE-section\.md$/, 6],
  [/^run \/ghorc:setup$/, 5],
];
const prio = (l) => {
  const k = KNOWN.find(([re]) => re.test(l));
  assert.ok(k, `a whole known line, not a cut one: [${l}]`);
  return k[1];
};

function start(cfg, session, alerts = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-ssl-'));
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const proj = tmpProject(cfg);
    const rows = Array.from({ length: alerts }, (_, i) => `2026-01-01T00:00:0${i + 1}Z ${'x'.repeat(120)}${i + 1}`);
    if (rows.length) fs.writeFileSync(tmpLib.alertsFile(config.projectRoot(proj)), rows.join('\n') + '\n');
    return runScript('session-start.cjs', { cwd: proj, session_id: session }, { env: { GHORC_TMP: dir, GHORC_ROLE: '' } }).out;
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lines = (out) => out.replace(/\n$/, '').split('\n');

test('two watchdog alerts: the lead line and identity stay, only the alert details go, the output says so', () => {
  const out = start(undefined, 's-two');
  const ls = lines(out);
  assert.ok(ls.includes('lead: load skill ghorc:lead'), out);
  assert.ok(ls.some((l) => /^ghorc \S+ session=s-two role=lead$/.test(l)));
  assert.ok(ls.includes('2 watchdog alerts pending, run ctx'), 'the count outlives the details');
  assert.ok(!ls.some((l) => /^ {2}2026/.test(l)), 'the two detail lines are dropped first');
  assert.equal(ls[ls.length - 1], MORE);
});

test('drop order: everything printed is a whole line, and no kept line has a lower priority than a dropped one', () => {
  const out = start({ handoff: { stickyOnCompact: true } }, 's-order');
  const body = lines(out).filter((l) => l !== MORE);
  const kept = body.map(prio);
  assert.ok(body.includes('lead: load skill ghorc:lead'));
  assert.equal(lines(out).pop(), MORE, 'something was dropped, so the marker is there');
  assert.ok(!kept.includes(8) && !kept.includes(7) && !kept.includes(6), 'alert lines and the CLAUDE.md hint went first');
  assert.deepEqual(kept.slice().sort((a, b) => b - a), [5, 3, 2, 0, 0], 'dropped 8, 8, 7, 6 in that order; the setup hint (5), the sticky notice (3), config ok (2), identity and the lead line stay');
});

test('the output never exceeds 299 characters and never ends mid-line, with and without drops', () => {
  for (const [cfg, n, s] of [[undefined, 0, 's-none'], [undefined, 3, 's-three'], [{ handoff: { stickyOnCompact: true } }, 3, 's-sticky']]) {
    const out = start(cfg, s, n);
    assert.ok(out.endsWith('\n'));
    assert.ok(out.length - 1 <= 299, `length ${out.length - 1} for ${s}`);
    for (const l of lines(out)) if (l !== MORE) prio(l);
    assert.ok(lines(out).includes('lead: load skill ghorc:lead'), s);
  }
  assert.ok(!lines(start(undefined, 's-fits', 0)).includes(MORE), 'nothing dropped, no marker');
});
