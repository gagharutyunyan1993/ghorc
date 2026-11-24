'use strict';
// Model guide package: setup item `explore`, CASCADE out of the first-round rate, no pinned model versions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, tmpProject } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    return fn({ GHORC_HOME: home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('setup explore: a WARN item, not part of all; apply writes a haiku Explore, never overwrites one', () => {
  withHome((env) => {
    const proj = tmpProject({});
    const run = (...a) => runScript('setup.cjs', '', { args: [...a, '--cwd', proj], env }).out;
    const file = path.join(proj, '.claude', 'agents', 'Explore.md');
    assert.match(run('--check'), /WARN\s+explore \[project\]: "built-in \(runs on the lead model\)"/);
    run('--apply', 'all');
    assert.equal(fs.existsSync(file), false, 'all does not write Explore');
    const out = run('--apply', 'explore');
    assert.match(out, /Explore\.md \(copied from templates\/Explore\.md: model haiku\)/);
    assert.match(fs.readFileSync(file, 'utf8'), /^model: haiku$/m);
    assert.match(run('--check'), /ok\s+explore \[project\]: "haiku \/ medium"/);
    fs.writeFileSync(file, '---\nname: Explore\nmodel: sonnet\n---\nmine\n');
    run('--apply', 'explore');
    assert.equal(fs.readFileSync(file, 'utf8'), '---\nname: Explore\nmodel: sonnet\n---\nmine\n', 'an existing file is kept');
  });
});

test('setup claudemd: the project roles table leaves out Explore', () => {
  withHome((env) => {
    const proj = tmpProject({});
    const dir = path.join(proj, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Explore.md'), '---\nname: Explore\nmodel: haiku\n---\n');
    fs.writeFileSync(path.join(dir, 'fixer.md'), '---\nname: fixer\nmodel: sonnet\neffort: medium\ndescription: Fixes things.\n---\n');
    runScript('setup.cjs', '', { args: ['--apply', 'claudemd', '--cwd', proj], env });
    const md = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
    assert.match(md, /\| fixer \| sonnet \/ medium \|/);
    assert.doesNotMatch(md, /\| Explore \|/);
  });
});

test('ledger: a package whose first verdict is CASCADE stays out of the first-round ACCEPT rate', () => {
  const dir = tmpProject();
  const env = { CLAUDE_PROJECT_DIR: dir };
  const v = (...a) => runScript('ledger.cjs', '', { args: ['verdict', ...a], env, cwd: dir });
  v('A', '1', 'ACCEPT');
  v('B', '1', 'CHANGES_REQUIRED', 'CASCADE');
  v('B', '2', 'ACCEPT');
  v('C', '1', 'CHANGES_REQUIRED', 'REASONING_FAILURE');
  const j = JSON.parse(runScript('ledger.cjs', '', { args: ['report', '--json'], env, cwd: dir }).out);
  assert.equal(j.firstRoundAcceptRate, 0.5, 'A and C count, B does not');
  assert.equal(j.causes.CASCADE, 1);
});

test('no model version is pinned outside the price table', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'tests', '.claude'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|cjs|json)$/.test(e.name) && e.name !== 'CHANGELOG.md' && e.name !== 'prices.cjs') files.push(p);
    }
  };
  walk(ROOT);
  const re = /claude-(opus|sonnet|haiku|fable)-\d|\b(Opus|Sonnet|Haiku|Fable) \d/;
  const hits = files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test('setup pct: the shipped thresholds recommend 30% of a 1M window', () => {
  withHome((env) => {
    const proj = tmpProject(); // no project config: the shipped defaults (ctxHandoff 265K)
    const out = runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out;
    assert.match(out, /MISSING pct \[global\]: null -> "30"/);
  });
});
