'use strict';
// Lists local branches that are ahead of, or missing on, origin (local refs only, no network). Exit 1 when there are any.
const { unpushed, pending } = require('./lib/unpushed.cjs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'unpushed.cjs [--branches a,b] [--cwd <dir>]: lists local branches that are ahead of origin/<branch> or have no ' +
      'origin/<branch>, one line each with the head SHA; compares local refs only (no fetch, no network, so run ' +
      '`git fetch` first if origin may have moved). Without --branches every local branch is examined and only the ' +
      'unpushed ones are printed; with --branches every named branch is printed (ok, ahead, missing, no local branch). ' +
      'A branch that the fetch refspec of origin does not cover (for example a --single-branch clone) is reported as ' +
      '"cannot tell" and does not count. ' +
      'Exit 0: nothing unpushed. Exit 1: at least one branch is unpushed or a named branch does not exist locally. ' +
      'Exit 2: not a git repository, no origin remote or git unavailable. Used by ghorc:handoff before the candidate is launched and by handoff.pushGuard.',
  );
  process.exit(0);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = opt('--branches');
const branches = list === undefined ? null : list.split(',').map((b) => b.trim()).filter(Boolean);
const { error, rows } = unpushed(opt('--cwd') || process.cwd(), branches);
if (error) {
  console.log(`unpushed: ${error}`);
  process.exit(2);
}
const sha = (r) => (r.head ? r.head.slice(0, 12) : '');
let bad = 0;
for (const r of rows) {
  if (r.state === 'missing') console.log(`${r.branch}: not on origin (no origin/${r.branch}), head ${sha(r)}`);
  else if (r.state === 'ahead') console.log(`${r.branch}: ${r.ahead} commit(s) ahead of origin/${r.branch}, head ${sha(r)}`);
  else if (r.state === 'nolocal') console.log(`${r.branch}: no local branch`);
  else if (r.state === 'untracked') console.log(`${r.branch}: not tracked by the fetch refspec of origin, cannot tell (head ${sha(r)})`);
  else if (branches) console.log(`${r.branch}: pushed, head ${sha(r)}`);
  if (r.state !== 'ok' && r.state !== 'untracked') bad++;
}
if (!bad && !branches) console.log('all local branches are on origin');
process.exit(bad ? 1 : 0);
