'use strict';
// ghorc setup: --check reports what differs from the recommended setup; --apply <all|id,id,...> fixes chosen items.
// No git calls and no npm dependencies; GHORC_HOME overrides HOME/USERPROFILE (used by tests).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..');
const MARKER = '<!-- ghorc -->';
const EXCLUDE_LINE = '.claude/ctx-*.json';
const PCT = '18';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function home() {
  return process.env.GHORC_HOME && process.env.GHORC_HOME.trim() ? process.env.GHORC_HOME : os.homedir();
}

// Project root without git: CLAUDE_PROJECT_DIR, else the nearest ancestor holding .git (dir or file), else cwd.
function findRoot(cwd) {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env && env.trim()) return path.resolve(env);
  let dir = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(cwd || process.cwd());
}

function leadDefaults(root) {
  const tpl = readJson(path.join(PLUGIN_ROOT, 'templates', 'ghorc.json')) || {};
  const proj = readJson(path.join(root, '.claude', 'ghorc.json')) || {};
  return { ...(tpl.lead || {}), ...(proj.lead || {}) };
}

function statusLineCommand() {
  return `node "${path.join(PLUGIN_ROOT, 'scripts', 'statusline.cjs').replace(/\\/g, '/')}"`;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Builds the item list: { id, scope, what, current, recommended, why, ok, owner }.
function check(cwd) {
  const root = findRoot(cwd);
  const settingsFile = path.join(home(), '.claude', 'settings.json');
  let settings = {};
  let settingsError = null;
  if (fs.existsSync(settingsFile)) {
    settings = readJson(settingsFile);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      settingsError = 'settings.json is not valid JSON';
      settings = {};
    }
  }
  const lead = leadDefaults(root);
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const sl = settings.statusLine;
  const slCmd = sl && typeof sl === 'object' ? String(sl.command || '') : '';
  const items = [];
  const add = (it) => items.push({ owner: false, ...it });

  add({
    id: 'statusLine',
    scope: 'user',
    what: `${settingsFile}: statusLine`,
    current: sl ? slCmd || JSON.stringify(sl) : null,
    recommended: statusLineCommand(),
    why: 'shows model, effort, context, rate limits and writes the ctx file the lead reads',
    ok: /ghorc/i.test(slCmd) && /statusline\.cjs/.test(slCmd),
  });
  add({
    id: 'pct',
    scope: 'user',
    what: `${settingsFile}: env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
    current: env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? null,
    recommended: PCT,
    why: 'compacts early so a lead session never works near a full context',
    ok: String(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) === PCT,
  });
  add({
    id: 'idle',
    scope: 'user',
    what: `${settingsFile}: idleCompaction`,
    current: settings.idleCompaction ?? null,
    recommended: false,
    why: 'prevents compaction while the lead waits for workers',
    ok: settings.idleCompaction === false,
  });
  add({
    id: 'model',
    scope: 'user',
    owner: true,
    what: `${settingsFile}: model`,
    current: settings.model ?? null,
    recommended: lead.model ?? 'opus',
    why: 'matches lead.model in ghorc.json (owner decision)',
    ok: settings.model === (lead.model ?? 'opus'),
  });
  add({
    id: 'effort',
    scope: 'user',
    owner: true,
    what: `${settingsFile}: effortLevel`,
    current: settings.effortLevel ?? null,
    recommended: lead.effort ?? 'medium',
    why: 'matches lead.effort in ghorc.json (owner decision)',
    ok: settings.effortLevel === (lead.effort ?? 'medium'),
  });

  const cfgFile = path.join(root, '.claude', 'ghorc.json');
  add({
    id: 'config',
    scope: 'project',
    what: cfgFile,
    current: fs.existsSync(cfgFile) ? 'present' : 'missing',
    recommended: 'present',
    why: 'project thresholds, checks and guards; copied from templates/ghorc.json',
    ok: fs.existsSync(cfgFile),
  });
  const mdFile = path.join(root, 'CLAUDE.md');
  const md = readText(mdFile);
  add({
    id: 'claudemd',
    scope: 'project',
    what: `${mdFile}: ${MARKER} section`,
    current: md === null ? 'no CLAUDE.md' : md.includes(MARKER) ? 'present' : 'missing',
    recommended: 'present',
    why: 'gives every agent the ghorc working rules (templates/CLAUDE-section.md)',
    ok: md !== null && md.includes(MARKER),
  });
  const gitPath = path.join(root, '.git');
  const excludeFile = path.join(gitPath, 'info', 'exclude');
  const ex = readText(excludeFile);
  const hasExclude = ex !== null && ex.split(/\r?\n/).includes(EXCLUDE_LINE);
  let hasGitDir = false;
  try {
    hasGitDir = fs.statSync(gitPath).isDirectory();
  } catch {
    /* no .git */
  }
  add({
    id: 'exclude',
    scope: 'project',
    what: `${excludeFile}: ${EXCLUDE_LINE}`,
    current: hasExclude ? 'present' : hasGitDir ? 'missing' : 'n/a (no .git directory)',
    recommended: 'present',
    why: 'keeps the per-session ctx files out of git without touching .gitignore',
    ok: !hasGitDir || hasExclude,
  });
  return { items, settingsFile, settingsError, root, clean: items.every((i) => i.ok) && !settingsError };
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = readText(file) || '';
  fs.writeFileSync(file, old + (old && !old.endsWith('\n') ? '\n' : '') + line + '\n');
}

function apply(cwd, ids) {
  const c = check(cwd);
  const want = new Set(ids.includes('all') ? c.items.map((i) => i.id) : ids);
  const unknown = [...want].filter((id) => !c.items.some((i) => i.id === id));
  if (unknown.length) throw new Error(`unknown item(s): ${unknown.join(', ')}`);
  const todo = c.items.filter((i) => want.has(i.id) && !i.ok);
  const diff = [];
  const userItems = todo.filter((i) => i.scope === 'user');
  if (userItems.length) {
    if (c.settingsError) throw new Error(`${c.settingsFile}: ${c.settingsError}; fix it by hand first`);
    const exists = fs.existsSync(c.settingsFile);
    const settings = exists ? readJson(c.settingsFile) : {};
    if (exists) {
      const bak = `${c.settingsFile}.ghorc-${stamp()}.bak`;
      fs.copyFileSync(c.settingsFile, bak);
      diff.push(`backup: ${bak}`);
    }
    const set = (label, oldV, newV) =>
      diff.push(`- ${label}: ${JSON.stringify(oldV ?? null)}\n+ ${label}: ${JSON.stringify(newV)}`);
    for (const it of userItems) {
      if (it.id === 'statusLine') {
        const next = { type: 'command', command: statusLineCommand(), refreshInterval: 30 };
        set('statusLine', settings.statusLine, next);
        settings.statusLine = next;
      } else if (it.id === 'pct') {
        settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
        set('env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, PCT);
        settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = PCT;
      } else if (it.id === 'idle') {
        set('idleCompaction', settings.idleCompaction, false);
        settings.idleCompaction = false;
      } else if (it.id === 'model') {
        set('model', settings.model, it.recommended);
        settings.model = it.recommended;
      } else if (it.id === 'effort') {
        set('effortLevel', settings.effortLevel, it.recommended);
        settings.effortLevel = it.recommended;
      }
    }
    fs.mkdirSync(path.dirname(c.settingsFile), { recursive: true });
    fs.writeFileSync(c.settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  for (const it of todo.filter((i) => i.scope === 'project')) {
    if (it.id === 'config') {
      const dst = path.join(c.root, '.claude', 'ghorc.json');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(PLUGIN_ROOT, 'templates', 'ghorc.json'), dst);
      diff.push(`+ ${dst} (copied from templates/ghorc.json)`);
    } else if (it.id === 'claudemd') {
      const dst = path.join(c.root, 'CLAUDE.md');
      const section = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'CLAUDE-section.md'), 'utf8');
      const old = readText(dst) || '';
      fs.writeFileSync(dst, old + (old && !old.endsWith('\n') ? '\n' : '') + (old ? '\n' : '') + section);
      diff.push(`+ ${dst} (appended templates/CLAUDE-section.md)`);
    } else if (it.id === 'exclude') {
      const dst = path.join(c.root, '.git', 'info', 'exclude');
      appendLine(dst, EXCLUDE_LINE);
      diff.push(`+ ${dst}: ${EXCLUDE_LINE}`);
    }
  }
  return { applied: todo.map((i) => i.id), diff };
}

module.exports = { check, apply, findRoot, MARKER };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const cwd = opt('--cwd') || process.cwd();
  if (args.includes('--help') || (!args.includes('--check') && !args.includes('--apply'))) {
    console.log(
      'setup.cjs --check [--cwd <dir>]: report each setup item (current -> recommended, why) as human lines plus a final JSON line.\n' +
        'setup.cjs --apply <all|statusLine,pct,idle,model,effort,config,claudemd,exclude> [--cwd <dir>]: apply the chosen items; ' +
        'backs up ~/.claude/settings.json first, touches only the listed keys and prints a diff. ' +
        'model and effort are owner-level decisions: name them only after the owner says yes. GHORC_HOME overrides the home directory.',
    );
    process.exit(0);
  }
  try {
    if (args.includes('--apply')) {
      const list = (opt('--apply') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!list.length) throw new Error('--apply needs "all" or a comma-separated item list');
      const r = apply(cwd, list);
      console.log(r.diff.length ? r.diff.join('\n') : 'nothing to change');
    }
    const c = check(cwd);
    for (const i of c.items) {
      console.log(
        `${i.ok ? 'ok     ' : 'MISSING'} ${i.id}${i.owner ? ' (owner decision)' : ''}: ${JSON.stringify(i.current)} -> ${JSON.stringify(i.recommended)}  [${i.why}]`,
      );
    }
    if (c.settingsError) console.log(`ERROR: ${c.settingsError}`);
    console.log(JSON.stringify({ clean: c.clean, items: c.items }));
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
