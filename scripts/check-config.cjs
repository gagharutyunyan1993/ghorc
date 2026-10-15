'use strict';
// node scripts/check-config.cjs [--cwd <dir>] [--sample "<command>"]...
const { check } = require('./lib/validate.cjs');
const { load } = require('./lib/config.cjs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'check-config.cjs [--cwd <dir>] [--sample "<command>"]: checks .claude/ghorc.json (JSON, keys, types, ' +
      'heavyCommands compilation). --sample (repeatable) shows which patterns match a command. ' +
      'Exit code 1 on errors.',
  );
  process.exit(0);
}
const cwd = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : process.cwd();
const samples = args.flatMap((a, i) => (a === '--sample' && args[i + 1] !== undefined ? [args[i + 1]] : []));

const { path: file, problems } = check(cwd);
console.log(file ? `config: ${file}` : 'config not found (defaults are used)');
for (const p of problems) console.log(`ERROR: ${p}`);

const patterns = (load(cwd).heavyCommands || []).filter((p) => typeof p === 'string');
for (const s of samples) {
  const hit = patterns.filter((p) => {
    try {
      return new RegExp(p, 'i').test(s);
    } catch {
      return false;
    }
  });
  console.log(`sample "${s}": ${hit.length ? 'HEAVY (' + hit.join(' ; ') + ')' : 'ordinary'}`);
}
if (!problems.length) console.log('no errors');
process.exit(problems.length ? 1 : 0);
