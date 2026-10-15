'use strict';
// ghorc setup: --check reports what differs from the recommended setup; --apply <all|id,id,...> fixes chosen items.
// No npm dependencies (git is used by lib/root.cjs to find the main root and here for the exclude path); GHORC_HOME overrides HOME/USERPROFILE (used by tests).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { projectRoot } = require('./lib/root.cjs');
const cmdlib = require('./lib/cmd.cjs');

const PLUGIN_ROOT = path.join(__dirname, '..');
const MARKER = '<!-- ghorc -->';
const EXCLUDE_LINES = ['.claude/ctx-*.json', '.claude/ghorc-out/'];
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

// Project root: the single rule of lib/root.cjs (CLAUDE_PROJECT_DIR, else the main git root, else cwd).
function findRoot(cwd) {
  return projectRoot(cwd);
}

function leadDefaults(root) {
  const tpl = readJson(path.join(PLUGIN_ROOT, 'templates', 'ghorc.json')) || {};
  const proj = readJson(path.join(root, '.claude', 'ghorc.json')) || {};
  return { ...(tpl.lead || {}), ...(proj.lead || {}) };
}

function statusLineCommand() {
  return `node "${path.join(PLUGIN_ROOT, 'scripts', 'statusline.cjs').replace(/\\/g, '/')}"`;
}

// True when settings point at a plugin-cache copy of statusline.cjs that is not the running copy (older version).
function statusLineStale(slCmd) {
  const norm = (x) => String(x).split('\\').join('/').toLowerCase();
  const cmd = norm(slCmd);
  const mine = norm(path.join(PLUGIN_ROOT, 'scripts', 'statusline.cjs'));
  if (!norm(PLUGIN_ROOT).includes('/.claude/plugins/')) return false;
  if (!/\/\.claude\/plugins\/.*statusline\.cjs/.test(cmd)) return false;
  return !cmd.includes(mine);
}

// Path of info/exclude as git sees it (right also in a linked worktree); falls back to <root>/.git/info/exclude.
function excludePath(root) {
  try {
    const r = cp.spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8', timeout: 1500, windowsHide: true });
    if (r.status === 0 && String(r.stdout).trim()) return { file: path.resolve(root, String(r.stdout).trim()), git: true };
  } catch {
    /* no git */
  }
  let isDir = false;
  try {
    isDir = fs.statSync(path.join(root, '.git')).isDirectory();
  } catch {
    /* no .git */
  }
  return { file: path.join(root, '.git', 'info', 'exclude'), git: isDir };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Builds the item list: { id, scope, what, current, recommended, why, ok, owner, warn }.
// opts.project: the autocompact item targets <root>/.claude/settings.local.json instead of the global user settings.
// warn items are reported but never applied and do not make the setup unclean.
function check(cwd, opts = {}) {
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
  const localFile = path.join(root, '.claude', 'settings.local.json');
  let pctFile = settingsFile;
  let pctEnv = null; // null: use the global env
  if (opts.project) {
    pctFile = localFile;
    pctEnv = {};
    if (fs.existsSync(localFile)) {
      const j = readJson(localFile);
      if (j === null || typeof j !== 'object' || Array.isArray(j)) settingsError = `${localFile} is not valid JSON`;
      else pctEnv = j.env && typeof j.env === 'object' ? j.env : {};
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
    id: 'statusLineStale',
    scope: 'user',
    what: `${settingsFile}: statusLine plugin version`,
    current: slCmd || null,
    recommended: statusLineCommand(),
    why: 'statusLine points to an older plugin version than the running one; re-run setup after plugin update',
    ok: !statusLineStale(slCmd),
  });
  const pctNow = (pctEnv || env).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  add({
    id: 'pct',
    scope: opts.project ? 'project' : 'user',
    what: `${pctFile}: env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (${opts.project ? 'this project only' : 'GLOBAL, every project; use --project for this project only'})`,
    current: pctNow ?? null,
    recommended: PCT,
    why: 'compacts early so a lead session never works near a full context',
    ok: String(pctNow) === PCT,
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
  const { file: excludeFile, git: hasGit } = excludePath(root);
  const ex = readText(excludeFile);
  const exLines = ex === null ? [] : ex.split(/\r?\n/);
  const hasExclude = EXCLUDE_LINES.every((l) => exLines.includes(l));
  add({
    id: 'exclude',
    scope: 'project',
    what: `${excludeFile}: ${EXCLUDE_LINES.join(', ')}`,
    current: hasExclude ? 'present' : hasGit ? 'missing' : 'n/a (not a git repository)',
    recommended: 'present',
    why: 'keeps the per-session ctx files and the agent output dir out of git without touching .gitignore',
    ok: !hasGit || hasExclude,
  });

  // Warning only: does the heavy guard guard anything, and does it cover checks.full?
  let projCfg = {};
  if (fs.existsSync(cfgFile)) projCfg = readJson(cfgFile) || {};
  const heavy = cmdlib.compile(Array.isArray(projCfg.heavyCommands) ? projCfg.heavyCommands : []);
  const full = projCfg.checks && typeof projCfg.checks.full === 'string' ? projCfg.checks.full.trim() : '';
  let heavyWhy = '';
  if (fs.existsSync(cfgFile)) {
    if (!heavy.length) heavyWhy = 'heavyCommands is empty: the heavy-check guard denies nothing';
    else if (full && !cmdlib.matches(full, heavy)) heavyWhy = 'no heavyCommands regex matches checks.full: subagents can run the full check';
  }
  add({
    id: 'heavy',
    scope: 'project',
    warn: true,
    owner: true,
    what: `${cfgFile}: heavyCommands vs checks.full`,
    current: heavyWhy ? 'not covering' : 'ok',
    recommended: 'a regex that matches checks.full',
    why: heavyWhy || 'heavyCommands covers checks.full',
    ok: !heavyWhy,
  });
  const real = items.filter((i) => !i.warn);
  return { items, settingsFile, settingsError, root, clean: real.every((i) => i.ok) && !settingsError };
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = readText(file) || '';
  fs.writeFileSync(file, old + (old && !old.endsWith('\n') ? '\n' : '') + line + '\n');
}

function apply(cwd, ids, opts = {}) {
  const c = check(cwd, opts);
  const want = new Set(ids.includes('all') ? c.items.filter((i) => !i.warn).map((i) => i.id) : ids);
  const unknown = [...want].filter((id) => !c.items.some((i) => i.id === id));
  if (unknown.length) throw new Error(`unknown item(s): ${unknown.join(', ')}`);
  const todo = c.items.filter((i) => want.has(i.id) && !i.ok && !i.warn);
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
      if (it.id === 'statusLine' || it.id === 'statusLineStale') {
        const next = { type: 'command', command: statusLineCommand(), refreshInterval: 30 };
        set('statusLine', settings.statusLine, next);
        settings.statusLine = next;
      } else if (it.id === 'pct') {
        settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
        set('env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (global)', settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, PCT);
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
    if (it.id === 'pct') {
      const file = path.join(c.root, '.claude', 'settings.local.json');
      if (c.settingsError) throw new Error(`${c.settingsError}; fix it by hand first`);
      const exists = fs.existsSync(file);
      const settings = exists ? readJson(file) : {};
      if (exists) {
        const bak = `${file}.ghorc-${stamp()}.bak`;
        fs.copyFileSync(file, bak);
        diff.push(`backup: ${bak}`);
      }
      settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
      diff.push(`- env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (project): ${JSON.stringify(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? null)}\n+ env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (project): ${JSON.stringify(PCT)}`);
      settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = PCT;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
      continue;
    }
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
      const dst = excludePath(c.root).file;
      const have = (readText(dst) || '').split(/\r?\n/);
      for (const line of EXCLUDE_LINES) {
        if (have.includes(line)) continue;
        appendLine(dst, line);
        diff.push(`+ ${dst}: ${line}`);
      }
    }
  }
  return { applied: todo.map((i) => i.id), diff };
}

module.exports = { check, apply, findRoot, MARKER };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const cwd = opt('--cwd') || process.cwd();
  const project = args.includes('--project');
  if (args.includes('--help') || (!args.includes('--check') && !args.includes('--apply'))) {
    console.log(
      'setup.cjs --check [--project] [--cwd <dir>]: report each setup item (scope, current -> recommended, why) as human lines plus a final JSON line. ' +
        'Items marked WARN (heavy) are only reported.\n' +
        'setup.cjs --apply <all|statusLine,statusLineStale,pct,idle,model,effort,config,claudemd,exclude> [--project] [--cwd <dir>]: apply the chosen items; ' +
        'backs up ~/.claude/settings.json first, touches only the listed keys and prints a diff. ' +
        'pct is written GLOBALLY (every project) unless --project, which writes <root>/.claude/settings.local.json instead. ' +
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
      const r = apply(cwd, list, { project });
      console.log(r.diff.length ? r.diff.join('\n') : 'nothing to change');
    }
    const c = check(cwd, { project });
    for (const i of c.items) {
      console.log(
        `${i.ok ? 'ok     ' : i.warn ? 'WARN   ' : 'MISSING'} ${i.id} [${i.scope === 'user' ? 'global' : 'project'}]${i.owner && !i.warn ? ' (owner decision)' : ''}: ${JSON.stringify(i.current)} -> ${JSON.stringify(i.recommended)}  [${i.why}]`,
      );
    }
    if (c.settingsError) console.log(`ERROR: ${c.settingsError}`);
    console.log(JSON.stringify({ clean: c.clean, items: c.items }));
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
