'use strict';
// Local branches that are ahead of, or missing on, origin. Local refs only: no fetch, no network.
// Every git call goes through root.cjs git() (timeout, shared budget, kill switch).
const { git: rootGit } = require('./root.cjs');

function git(cwd, args) {
  const r = rootGit(args, cwd);
  return { ok: r.status === 0, dead: r.status === null || r.status === undefined, out: String(r.stdout || '').trim() };
}

// Does one fetch refspec (`+refs/heads/*:refs/remotes/origin/*`) map refs/heads/<branch> to refs/remotes/origin/<branch>?
function refspecCovers(spec, branch) {
  const s = String(spec).replace(/^\+/, '');
  if (s.startsWith('^')) return false;
  const i = s.indexOf(':');
  if (i < 0) return false;
  const src = s.slice(0, i);
  const dst = s.slice(i + 1);
  const star = src.indexOf('*');
  const ref = `refs/heads/${branch}`;
  if (star < 0) return src === ref && dst === `refs/remotes/origin/${branch}`;
  const head = src.slice(0, star);
  const tail = src.slice(star + 1);
  if (!ref.startsWith(head) || !ref.endsWith(tail) || ref.length < head.length + tail.length) return false;
  const mid = ref.slice(head.length, ref.length - tail.length);
  return dst.replace('*', mid) === `refs/remotes/origin/${branch}`;
}

// branches: string[] to examine, or null for every local branch.
// Returns { error: string|null, noOrigin: boolean, rows: [{ branch, state, ahead, head }] } with state:
//   'ok' (same as origin/<branch> or behind it), 'ahead' (ahead > 0), 'missing' (the fetch refspec of origin covers the
//   branch and there is no origin/<branch>), 'untracked' (the fetch refspec of origin does not cover the branch, for
//   example a --single-branch clone: the local refs cannot say whether it is pushed), 'nolocal' (no such local branch).
// No `origin` remote (no fetch refspec for it): error 'no origin remote', noOrigin true. Any git failure: an error.
function unpushed(cwd, branches) {
  const refs = git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes/origin']);
  if (refs.dead) return { error: 'git unavailable', noOrigin: false, rows: [] };
  if (!refs.ok) return { error: 'not a git repository', noOrigin: false, rows: [] };
  const spec = git(cwd, ['config', '--get-all', 'remote.origin.fetch']);
  if (spec.dead) return { error: 'git unavailable', noOrigin: false, rows: [] };
  const specs = spec.ok ? spec.out.split(/\r?\n/).filter(Boolean) : [];
  if (!specs.length) return { error: 'no origin remote', noOrigin: true, rows: [] };

  const local = new Map();
  const remote = new Map();
  for (const line of refs.out.split(/\r?\n/)) {
    const [name, sha] = line.split('\t');
    if (!name || !sha) continue;
    if (name.startsWith('refs/heads/')) local.set(name.slice('refs/heads/'.length), sha);
    else if (name.startsWith('refs/remotes/origin/')) remote.set(name.slice('refs/remotes/origin/'.length), sha);
  }
  const names = branches || [...local.keys()];
  const rows = [];
  for (const branch of names) {
    const head = local.get(branch);
    if (!head) {
      rows.push({ branch, state: 'nolocal', ahead: 0, head: '' });
      continue;
    }
    const remoteSha = remote.get(branch);
    if (!remoteSha) {
      rows.push({ branch, state: specs.some((s) => refspecCovers(s, branch)) ? 'missing' : 'untracked', ahead: 0, head });
      continue;
    }
    let ahead = 0;
    if (remoteSha !== head) {
      const n = git(cwd, ['rev-list', '--count', `refs/remotes/origin/${branch}..refs/heads/${branch}`]);
      if (n.dead) return { error: 'git unavailable', noOrigin: false, rows: [] };
      ahead = n.ok ? Number(n.out) || 0 : 0;
    }
    rows.push({ branch, state: ahead > 0 ? 'ahead' : 'ok', ahead, head });
  }
  return { error: null, noOrigin: false, rows };
}

// The rows that are not on origin (ahead or missing). A branch that does not exist locally or that origin's fetch
// refspec does not cover is not counted.
const pending = (rows) => rows.filter((r) => r.state === 'ahead' || r.state === 'missing');

// The default branch of origin (`origin/HEAD`), or null when it is not recorded.
function originDefaultBranch(cwd) {
  const r = git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  return r.ok && r.out.startsWith('origin/') ? r.out.slice('origin/'.length) : null;
}

module.exports = { unpushed, pending, originDefaultBranch, refspecCovers };
