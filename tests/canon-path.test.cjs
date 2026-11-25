'use strict';
// One root, two spellings (a link or junction here; a Windows 8.3 short name such as RUNNER~1 on CI): the ctx hash, the
// session root and the handoff path comparison all take the canonical path, so the status line and the hooks agree.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonPath } = require('../scripts/lib/root.cjs');
const { rootHash } = require('../scripts/lib/tmp.cjs');

test('canonPath: a linked spelling, a missing file under it and the target give one path and one root hash', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-canon-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'real-project');
  fs.mkdirSync(real);
  const link = path.join(base, 'link');
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch (e) {
    t.skip(`no link support here: ${e.code}`);
    return;
  }
  assert.equal(canonPath(link), canonPath(real));
  assert.equal(rootHash(link), rootHash(real));
  assert.equal(canonPath(path.join(link, 'HANDOFF.md')), canonPath(path.join(real, 'HANDOFF.md')), 'a file not written yet');
  assert.equal(canonPath(path.join(link, 'a', 'b')), canonPath(path.join(real, 'a', 'b')));
  assert.notEqual(rootHash(real), rootHash(base));
});
