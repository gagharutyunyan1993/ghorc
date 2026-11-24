'use strict';
// PreToolUse(Bash|PowerShell): git commands that skip the hooks, rewrite published history or land on a protected branch
// are denied in EVERY session (lead, worker, subagent alike). Opt-in: git.guard (default false).
// Threat model: a well-meaning session writing an explicit command. Scripts, `| sh` of a file, values from variables and
// git aliases defined elsewhere are not covered (docs/hooks.md, git-guard.cjs); the server's branch protection is the real
// wall for the default branch.
const { deny, run } = require('./lib/hook-io.cjs');
const { load, optedIn } = require('./lib/config.cjs');
const { segments, variants } = require('./lib/cmd.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'git-guard.cjs: PreToolUse(Bash|PowerShell) hook, opt-in (git.guard, default false; silent in a project without ' +
      '.claude/ghorc.json). For every session it denies: --no-verify on git commit/push/merge/rebase/pull/am (and git commit -n); ' +
      'git push --force, -f, --force-with-lease, --force-if-includes and a +refspec; git push to a protected branch ' +
      '(git.protectedBranches, default main and master, in any spelling: origin main, HEAD:main, refs/heads/main, :main) and ' +
      'push --all/--mirror/--branches; git push without an explicit remote and branch (bare git push, git push origin, HEAD, @, ' +
      'a variable or a glob); writing core.hooksPath or alias.* with git config; git -c core.hooksPath=... or -c alias.*=... ' +
      'on any git command. Everything else passes (git push -u origin feat/x, reading config, --help). Commands are cut ' +
      'into segments like the heavy-check guard (shell wrappers such as bash -c are looked into). Not covered: scripts, ' +
      'commands read from files, values in variables, aliases defined elsewhere. Every deny is appended to ' +
      '<tmp>/ghorc-<user>/denials.log. Any internal error allows the call.',
  );
  process.exit(0);
}

const SAFE_PUSH = 'git push -u origin <feature-branch>';
const R = {
  noVerify: () => 'git-guard (no-verify): --no-verify and git commit -n skip the git hooks. Fix what the hook reports and run the command again without it.',
  force: () =>
    `git-guard (force push): --force, -f, --force-with-lease and a +refspec rewrite published history. Push a new commit on top instead: ${SAFE_PUSH}.`,
  protected: (list) =>
    `git-guard (protected branch): pushing to ${list.join(', ') || 'a protected branch'} (or --all, --mirror, --branches) is not allowed. ` +
    `Push a feature branch (${SAFE_PUSH}) and merge it through a pull or merge request.`,
  noBranch: () =>
    `git-guard (explicit push): git push needs an explicit remote and a literal branch name, not a bare push, HEAD, @, a variable or a glob. Use ${SAFE_PUSH}.`,
  config: () =>
    'git-guard (hooks config): writing core.hooksPath or alias.* (git config, or git -c on any command) can switch off the git hooks or hide a command from this guard. Leave them as they are and ask the owner if a change is needed.',
};

// Subcommands that take --no-verify.
const NOVERIFY_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'pull', 'am']);
// Long push options that are denied; an abbreviation (a non-empty prefix) counts as the same option.
const PUSH_FORCE = ['force', 'force-with-lease', 'force-if-includes'];
const PUSH_ALL = ['all', 'mirror', 'branches'];
// Long options with a separate value (the value is not a refspec or a flag).
const COMMIT_VAL = new Set(['message', 'file', 'reuse-message', 'reedit-message', 'template', 'author', 'date', 'cleanup', 'fixup', 'squash', 'trailer']);
const PUSH_VAL = new Set(['repo', 'receive-pack', 'exec', 'push-option']);
// git global options with a separate value.
const GLOBAL_VAL = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--exec-path', '--super-prefix']);
const CFG_VAL = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
const CFG_WRITE_VERBS = new Set(['set', 'unset', 'replace-all', 'rename-section', 'remove-section', 'edit']);
const CFG_VERBS = new Set([...CFG_WRITE_VERBS, 'get', 'get-all', 'list', 'get-regexp', 'get-urlmatch', 'get-color', 'get-colorbool']);

// core.hooksPath and aliases change what a git command runs; include.path / includeIf.<cond>.path pull in another config file
// that may set them
const guardedKey = (k) => {
  const key = String(k).toLowerCase();
  return key === 'core.hookspath' || key.startsWith('alias.') || key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'));
};

// Words of one command segment; a redirection (2>, >file, *>&1) and its target are dropped.
function words(text) {
  const out = [];
  const w = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < w.length; i++) {
    if (/^(?:\d|\*)?>>?$|^<$/.test(w[i])) {
      i++;
      continue;
    }
    if (/^(?:\d|\*)?>>?\S|^&>|^<\S/.test(w[i])) continue;
    out.push(w[i]);
  }
  return out;
}

// Options of commit/push/merge/...: { rule } on a deny, else { pos, tags }.
function options(sub, args) {
  const push = sub === 'push';
  const commit = sub === 'commit';
  const pos = [];
  let tags = false;
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (end || !a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    if (a === '--') {
      end = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const n = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      if (NOVERIFY_SUBS.has(sub) && n.length >= 4 && 'no-verify'.startsWith(n)) return { rule: 'noVerify' };
      if (push) {
        if (n && PUSH_FORCE.some((b) => b.startsWith(n))) return { rule: 'force' };
        if (n && PUSH_ALL.some((b) => b.startsWith(n))) return { rule: 'protected' };
        if (n === 'tags') tags = true;
        else if (eq < 0 && PUSH_VAL.has(n)) i++;
      } else if (commit && eq < 0 && COMMIT_VAL.has(n)) i++;
      continue;
    }
    // a bundle of short flags: -an, -fu, -m<msg>
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      if (commit && c === 'n') return { rule: 'noVerify' };
      if (push && c === 'f') return { rule: 'force' };
      if (push && c === 'o') {
        if (k === a.length - 1) i++;
        break;
      }
      if (commit && 'mFCct'.includes(c)) {
        if (k === a.length - 1) i++;
        break;
      }
      if (commit && 'Su'.includes(c)) break; // optional value, attached only
    }
  }
  return { pos, tags };
}

// One push refspec: a rule name or null.
function refspec(r, protectedList) {
  if (r.startsWith('+')) return 'force';
  if (r === '""' || r === "''") return null; // a quoted value, blanked by the segment cutter: not readable here
  if (/[*$`{}]/.test(r)) return 'noBranch';
  const colon = r.lastIndexOf(':');
  const dst = r.slice(colon + 1).replace(/^refs\//i, '').replace(/^heads\//i, '');
  if (protectedList.some((b) => b.toLowerCase() === dst.toLowerCase())) return 'protected';
  if (colon >= 0 ? dst === '' : r === 'HEAD' || r === '@') return 'noBranch';
  return null;
}

function configRule(args) {
  const pos = [];
  let flagWrite = false;
  let read = false;
  let sectionOp = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      pos.push(a);
      continue;
    }
    const n = a.split('=')[0];
    if (CFG_VAL.has(n) && !a.includes('=')) i++;
    if (/^--(?:unset|unset-all|replace-all|add)$/.test(n)) flagWrite = true;
    else if (/^--(?:remove|rename)-section$/.test(n)) sectionOp = true;
    else if (/^(?:--get\S*|--list|-l)$/.test(n)) read = true;
  }
  const verb = pos.length && CFG_VERBS.has(pos[0]) ? pos.shift() : null;
  const key = String(pos[0] || '').toLowerCase();
  if (sectionOp || verb === 'remove-section' || verb === 'rename-section') {
    // both names: renaming a harmless section to alias or include creates guarded keys
    const guardedSection = (n) => ['core', 'alias', 'include', 'includeif'].includes(String(n || '').toLowerCase().split('.')[0]);
    return guardedSection(key) || guardedSection(pos[1]) ? 'config' : null;
  }
  if (read || !guardedKey(key)) return null;
  const write = flagWrite || (verb !== null && CFG_WRITE_VERBS.has(verb)) || pos[1] !== undefined;
  return write ? 'config' : null;
}

// The words after `git`: a rule name or null.
function gitRule(t, protectedList) {
  let i = 0;
  while (i < t.length && t[i].startsWith('-')) {
    const o = t[i];
    if (o === '--help' || o === '-h') return null;
    if (o === '-c' || o === '--config-env') {
      if (guardedKey(String(t[i + 1] || '').split('=')[0])) return 'config';
      i += 2;
    } else if (/^-c\S/.test(o) || o.startsWith('--config-env=')) {
      if (guardedKey(o.replace(/^-c|^--config-env=/, '').split('=')[0])) return 'config';
      i++;
    } else i += GLOBAL_VAL.has(o) ? 2 : 1;
  }
  const sub = String(t[i] || '').toLowerCase();
  const args = t.slice(i + 1);
  // help only as the first word after the subcommand: further on, --help can be the value of an option (-m --help)
  if (args[0] === '--help' || (args[0] === '-h' && sub !== 'config')) return null;
  if (sub === 'config') return configRule(args);
  if (!NOVERIFY_SUBS.has(sub)) return null;
  const o = options(sub, args);
  if (o.rule) return o.rule;
  if (sub !== 'push') return null;
  if (!o.pos.length) return 'noBranch'; // no remote
  const refs = o.pos.slice(1);
  if (!refs.length) return o.tags ? null : 'noBranch';
  for (const r of refs) {
    const rule = refspec(r, protectedList);
    if (rule) return rule;
  }
  return null;
}

// The first rule a command breaks, or null.
function decide(command, opts = {}) {
  const protectedList = Array.isArray(opts.protectedBranches) ? opts.protectedBranches.filter((b) => typeof b === 'string' && b) : ['main', 'master'];
  for (const seg of segments(command, { powershell: Boolean(opts.powershell) })) {
    for (const v of variants(seg)) {
      const t = words(v);
      if (!t.length || !/^git(?:\.exe)?$/i.test(t[0])) continue;
      const rule = gitRule(t.slice(1), protectedList);
      if (rule) return { rule, reason: R[rule](protectedList) };
    }
  }
  return null;
}

if (require.main === module) {
  run((input) => {
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return;
    const command = input.tool_input && input.tool_input.command;
    if (typeof command !== 'string') return;
    const cwd = input.cwd || process.cwd();
    if (!optedIn(cwd)) return; // a project without .claude/ghorc.json never opted in
    const cfg = load(cwd);
    const g = cfg.git && typeof cfg.git === 'object' ? cfg.git : {};
    if (g.guard !== true) return;
    const d = decide(command, { powershell: input.tool_name === 'PowerShell', protectedBranches: g.protectedBranches });
    if (d) deny(d.reason);
  }, 'git-guard');
}

module.exports = { decide };
