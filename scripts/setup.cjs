'use strict';
// ghorc setup: --check reports what differs from the recommended setup; --apply <all|id,id,...> fixes chosen items.
// No npm dependencies (git is used by lib/root.cjs to find the main root and here for the exclude path); GHORC_HOME overrides HOME/USERPROFILE (used by tests).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRoot, git } = require('./lib/root.cjs');
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

// Project root of a CLI tool: git toplevel of cwd (--cwd overrides cwd); CLAUDE_PROJECT_DIR is ignored (lib/root.cjs).
function findRoot(cwd) {
  return cliRoot(cwd);
}

function leadDefaults(root) {
  const tpl = readJson(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'defaults.json')) || {};
  const proj = readJson(path.join(root, '.claude', 'ghorc.json')) || {};
  return { ...(tpl.lead || {}), ...(proj.lead || {}) };
}

function perModelEffort(settings, model) {
  const ms = settings.modelSettings && typeof settings.modelSettings === 'object' ? settings.modelSettings[model] : null;
  return ms && typeof ms === 'object' ? ms.effortLevel : undefined;
}

// A missing top-level effortLevel is fine. Not ok: a per-model value that differs, or (without one) a differing top-level value.
function effortOk(settings, model, want) {
  const pm = perModelEffort(settings, model);
  if (pm !== undefined) return pm === want;
  return settings.effortLevel === undefined || settings.effortLevel === want;
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

// Where `apply` saves the status line it replaces: next to the settings file it edits.
function statusLineBackup(settingsFile) {
  return path.join(path.dirname(settingsFile), 'ghorc-statusline-backup.json');
}

// `--restore statusline`: puts the saved previous statusLine back (removes the key when there was none) and deletes the backup.
function restoreStatusLine(cwd) {
  const c = check(cwd);
  const bakFile = statusLineBackup(c.settingsFile);
  const saved = readJson(bakFile);
  if (saved === null || typeof saved !== 'object') throw new Error(`no saved previous status line (${bakFile} is missing)`);
  if (c.settingsError) throw new Error(`${c.settingsFile}: ${c.settingsError}; fix it by hand first`);
  const exists = fs.existsSync(c.settingsFile);
  const settings = exists ? readJson(c.settingsFile) : {};
  const diff = [];
  if (exists) {
    const bak = `${c.settingsFile}.ghorc-${stamp()}.bak`;
    fs.copyFileSync(c.settingsFile, bak);
    diff.push(`backup: ${bak}`);
  }
  const had = saved.had === true;
  diff.push(`- statusLine: ${JSON.stringify(settings.statusLine ?? null)}\n+ statusLine: ${had ? JSON.stringify(saved.value) : '(removed)'}`);
  if (had) settings.statusLine = saved.value;
  else delete settings.statusLine;
  fs.mkdirSync(path.dirname(c.settingsFile), { recursive: true });
  fs.writeFileSync(c.settingsFile, JSON.stringify(settings, null, 2) + '\n');
  fs.rmSync(bakFile, { force: true });
  diff.push(`deleted ${bakFile}`);
  return { diff };
}

// Path of info/exclude as git sees it (right also in a linked worktree); falls back to <root>/.git/info/exclude.
function excludePath(root) {
  try {
    const r = git(['rev-parse', '--git-path', 'info/exclude'], root);
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

// Names of package.json scripts that look heavy (test, e2e, build, lint) in the root and in app/.
const HEAVY_NAME = /(^|[:_-])(tests?|e2e|full|build|lint|typecheck)([:_-]|$)/i;
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Proposed heavyCommands regexes from package.json scripts; patterns that match checks.fast are left out
// (agents run fast, so it must never be denied). Returns string[].
function proposeHeavy(root, fast) {
  const names = [];
  for (const dir of [root, path.join(root, 'app')]) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg || typeof pkg.scripts !== 'object' || pkg.scripts === null) continue;
    for (const n of Object.keys(pkg.scripts)) if (HEAVY_NAME.test(n) && !names.includes(n)) names.push(n);
  }
  // one regex per script (`npm test` for test); a script already covered by an earlier regex adds nothing
  const f = typeof fast === 'string' ? fast.trim() : '';
  const out = [];
  for (const n of names) {
    const re = n === 'test' ? String.raw`^npm\s+(?:run\s+)?test\b(?!:)` : String.raw`^npm\s+run\s+${escRe(n)}\b`;
    const cmd = n === 'test' ? 'npm test' : `npm run ${n}`;
    if (f && cmdlib.matches(f, cmdlib.compile([re]))) continue;
    if (out.length && cmdlib.matches(cmd, cmdlib.compile(out))) continue;
    out.push(re);
  }
  return out;
}

// Reads <root>/.claude/ghorc.json (creating it from the template when missing), applies mutate(obj), writes it back.
function editProjectConfig(root, mutate) {
  const dst = path.join(root, '.claude', 'ghorc.json');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) fs.copyFileSync(path.join(PLUGIN_ROOT, 'templates', 'ghorc.json'), dst);
  const obj = readJson(dst);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${dst} is not valid JSON; fix it by hand first`);
  mutate(obj);
  fs.writeFileSync(dst, JSON.stringify(obj, null, 2) + '\n');
  return dst;
}

// Builds the item list: { id, scope, what, current, recommended, why, ok, owner, warn }.
// opts.project: the autocompact item targets <root>/.claude/settings.local.json instead of the global user settings.
// warn items do not make the setup unclean and are not part of "all"; with applicable they can still be applied by name.
function check(cwd, opts = {}) {
  const root = findRoot(cwd);
  const settingsFile = path.join(home(), '.claude', 'settings.json');
  let settings = {};
  let settingsError = null;
  let settingsWarning = null; // --project: a broken global file only disables the global items, it never blocks
  if (fs.existsSync(settingsFile)) {
    settings = readJson(settingsFile);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      if (opts.project) settingsWarning = `${settingsFile} is not valid JSON; global items are not checked`;
      else settingsError = 'settings.json is not valid JSON';
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
    what: `${settingsFile}: modelSettings.${lead.model ?? 'opus'}.effortLevel`,
    current: perModelEffort(settings, lead.model ?? 'opus') ?? null,
    recommended: lead.effort ?? 'medium',
    why: 'matches lead.effort in ghorc.json (owner decision); a missing top-level effortLevel is fine',
    ok: effortOk(settings, lead.model ?? 'opus', lead.effort ?? 'medium'),
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

  // Does the heavy guard guard anything, does it cover checks.full? Proposal from package.json scripts; applied only by name.
  let projCfg = {};
  if (fs.existsSync(cfgFile)) projCfg = readJson(cfgFile) || {};
  const heavy = cmdlib.compile(Array.isArray(projCfg.heavyCommands) ? projCfg.heavyCommands : []);
  const full = projCfg.checks && typeof projCfg.checks.full === 'string' ? projCfg.checks.full.trim() : '';
  const proposed = proposeHeavy(root, projCfg.checks && projCfg.checks.fast).filter(
    (p) => !(Array.isArray(projCfg.heavyCommands) && projCfg.heavyCommands.includes(p)),
  );
  let heavyWhy = '';
  if (fs.existsSync(cfgFile)) {
    if (!heavy.length) heavyWhy = 'heavyCommands is empty: the heavy-check guard denies nothing';
    else if (full && !cmdlib.matches(full, heavy)) heavyWhy = 'no heavyCommands regex matches checks.full: subagents can run the full check';
  }
  add({
    id: 'heavy',
    scope: 'project',
    warn: true,
    applicable: true,
    owner: true,
    what: `${cfgFile}: heavyCommands vs checks.full`,
    current: heavyWhy ? 'not covering' : 'ok',
    recommended: proposed.length ? `add ${proposed.length} proposed regex(es), listed below (apply: --apply heavy)` : 'a regex that matches checks.full',
    why: heavyWhy || 'heavyCommands covers checks.full',
    ok: !heavyWhy,
    proposed,
  });
  const wdOn = Boolean(projCfg.watchdog && projCfg.watchdog.autostart === true);
  add({
    id: 'watchdog',
    scope: 'project',
    warn: true,
    applicable: true,
    what: `${cfgFile}: watchdog.autostart`,
    current: wdOn ? 'on' : 'off',
    recommended: 'on only if you want SessionStart to start the transcript watchdog (opt-in)',
    why: 'the watchdog is a detached background process that warns about transcripts that grow without bound; stop it with scripts/watchdog.cjs --stop',
    ok: wdOn,
  });
  const real = items.filter((i) => !i.warn);
  const slState = !sl ? 'none' : items[0].ok ? (fs.existsSync(statusLineBackup(settingsFile)) ? 'ghorc (previous saved)' : 'ghorc') : 'other';
  return { items, settingsFile, settingsError, settingsWarning, statusLineState: slState, root, clean: real.every((i) => i.ok) && !settingsError };
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
  const todo = c.items.filter((i) => want.has(i.id) && !i.ok && (!i.warn || i.applicable));
  const diff = [];
  const userItems = todo.filter((i) => i.scope === 'user');
  if (userItems.length) {
    if (c.settingsError) throw new Error(`${c.settingsFile}: ${c.settingsError}; fix it by hand first`);
    if (c.settingsWarning) throw new Error(`${c.settingsWarning}; fix it by hand, or apply only project items (pct, config, claudemd, exclude, heavy, watchdog)`);
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
        // remember what is replaced, once, and never a ghorc status line (that is not a "previous" worth restoring)
        const bakFile = statusLineBackup(c.settingsFile);
        const prev = settings.statusLine;
        const prevCmd = prev && typeof prev === 'object' ? String(prev.command || '') : '';
        if (!fs.existsSync(bakFile) && !(/ghorc/i.test(prevCmd) && /statusline\.cjs/.test(prevCmd))) {
          fs.mkdirSync(path.dirname(bakFile), { recursive: true });
          fs.writeFileSync(bakFile, JSON.stringify({ had: 'statusLine' in settings, value: prev ?? null, savedAt: new Date().toISOString() }, null, 2) + '\n');
          diff.push(`saved previous statusLine: ${bakFile} (restore: setup.cjs --restore statusline)`);
        }
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
        const m = leadDefaults(c.root).model ?? 'opus';
        const ms = settings.modelSettings && typeof settings.modelSettings === 'object' ? settings.modelSettings : {};
        const entry = ms[m] && typeof ms[m] === 'object' ? ms[m] : {};
        set(`modelSettings.${m}.effortLevel`, entry.effortLevel, it.recommended);
        settings.modelSettings = { ...ms, [m]: { ...entry, effortLevel: it.recommended } };
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
    if (it.id === 'heavy') {
      if (!it.proposed.length) {
        diff.push('heavy: no proposal (no test/e2e/build/lint scripts found in package.json or app/package.json); set heavyCommands by hand');
        continue;
      }
      diff.push(`heavy: adding ${it.proposed.length} regex(es) to heavyCommands: ${JSON.stringify(it.proposed)}`);
      const dst = editProjectConfig(c.root, (o) => {
        const have = Array.isArray(o.heavyCommands) ? o.heavyCommands : [];
        o.heavyCommands = [...have, ...it.proposed.filter((p) => !have.includes(p))];
      });
      diff.push(`+ ${dst}: heavyCommands`);
    } else if (it.id === 'watchdog') {
      const dst = editProjectConfig(c.root, (o) => {
        o.watchdog = o.watchdog && typeof o.watchdog === 'object' ? o.watchdog : {};
        o.watchdog.autostart = true;
      });
      diff.push(`+ ${dst}: watchdog.autostart = true (stop a running one with scripts/watchdog.cjs --stop)`);
    } else if (it.id === 'config') {
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

// Lines for /ghorc:status: role, guards, heavy patterns, watchdog, last denials.
function statusBlock(cwd) {
  const tmp = require('./lib/tmp.cjs');
  const cfg = require('./lib/config.cjs').load(cwd, { cli: true });
  const root = findRoot(cwd);
  const role = (process.env.GHORC_ROLE || '').trim() || 'lead';
  const rg = cfg.readGuard || {};
  const heavy = Array.isArray(cfg.heavyCommands) ? cfg.heavyCommands : [];
  const version = require(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version;
  const w = cfg.watchdog || {};
  const ws = tmp.watchdogStatus(root, version, Number(w.intervalSec ?? 30));
  const d = tmp.denials(5);
  const out = [
    `status: role=${role}${process.env.GHORC_ROLE ? '' : ' (GHORC_ROLE not set)'}`,
    `status: read-guard on (maxRepeat=${rg.maxRepeat}, media blocked for the lead: ${rg.leadNoMedia !== false && process.env.GHORC_ROLE === 'lead' ? 'yes' : 'no'}), ` +
      `heavy-check-guard on (${heavy.length ? `${heavy.length} patterns` : 'no patterns: it denies nothing'})`,
    `status: watchdog autostart=${w.autostart === true ? 'on' : 'off'}, ${ws.alive ? `running pid ${ws.pid}` : `not running (${ws.reason})`}`,
    `status: denials ${d.total} total` + (d.total ? ` (${Object.entries(d.counts).map(([k, v]) => `${k}=${v}`).join(', ')}), last ${d.last.length}:` : ''),
    ...d.last.map((l) => `  ${l}`),
  ];
  if (cfg.invalid) out.push(`status: config invalid: ${cfg.invalid}`);
  return out;
}

module.exports = { check, apply, restoreStatusLine, statusBlock, findRoot, proposeHeavy, MARKER };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const cwd = opt('--cwd') || process.cwd();
  const project = args.includes('--project');
  if (args.includes('--help') || (!args.includes('--check') && !args.includes('--apply') && !args.includes('--restore'))) {
    console.log(
      'setup.cjs --check [--project] [--cwd <dir>]: report each setup item (scope, current -> recommended, why) as human lines plus a final JSON line. ' +
        'Items marked WARN (heavy, watchdog) never make the setup unclean and are applied only when named (not by "all"); ' +
        'heavy prints a proposed regex list from the package.json scripts (root and app/). --status adds the role, guards, watchdog and recent denials.\n' +
        'setup.cjs --apply <all|statusLine,statusLineStale,pct,idle,model,effort,config,claudemd,exclude,heavy,watchdog> [--project] [--cwd <dir>]: apply the chosen items; ' +
        'backs up ~/.claude/settings.json first, touches only the listed keys and prints a diff. ' +
        'pct is written GLOBALLY (every project) unless --project, which writes <root>/.claude/settings.local.json instead. ' +
        'model and effort are owner-level decisions: name them only after the owner says yes. GHORC_HOME overrides the home directory. ' +
        'Applying statusLine saves the replaced status line (once) in ~/.claude/ghorc-statusline-backup.json; ' +
        'setup.cjs --restore statusline puts it back (or removes the key when there was none) and deletes the backup. ' +
        '--check prints "statusline: ghorc (previous saved)", "ghorc", "other" or "none". ' +
        'With --project a broken global settings.json is only a WARN line: project items still apply.',
    );
    process.exit(0);
  }
  try {
    if (args.includes('--restore')) {
      const what = String(opt('--restore') || '').toLowerCase();
      if (what !== 'statusline') throw new Error('--restore knows only: statusline');
      console.log(restoreStatusLine(cwd).diff.join('\n'));
    }
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
    const hv = c.items.find((i) => i.id === 'heavy');
    if (hv && hv.proposed.length) {
      console.log('proposed heavyCommands (from package.json scripts; checks.fast is never proposed):');
      for (const p of hv.proposed) console.log(`  ${p}`);
    }
    console.log(`statusline: ${c.statusLineState}`);
    if (c.settingsWarning) console.log(`WARN: ${c.settingsWarning}`);
    if (c.settingsError) console.log(`ERROR: ${c.settingsError}`);
    if (args.includes('--status')) console.log(statusBlock(cwd).join('\n'));
    console.log(JSON.stringify({ clean: c.clean, root: c.root, statusLine: c.statusLineState, items: c.items }));
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
