'use strict';
// Runs the plugin's own tests only (tests/*.test.cjs), so examples/ and other folders are never picked up.
// A plain list of files works on Node 20 and later (a directory argument or a glob does not on every version).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'tests');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.cjs'))
  .sort()
  .map((f) => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
