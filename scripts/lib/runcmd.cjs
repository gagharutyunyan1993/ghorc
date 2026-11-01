'use strict';
// How heavy-slot.cjs starts its command, so that the arguments reach it unchanged.
//  - one string with whitespace ("npm run a && npm run b"): a shell line, run by the shell (sh -c / cmd /c);
//  - an argument list: no shell on POSIX. On Windows an .exe is started directly (Node quotes the arguments); a .cmd or
//    .bat shim (npm.cmd, npx.cmd) can only run through cmd.exe, so it is resolved here and its arguments are escaped for
//    cmd.exe (the scheme of the cross-spawn package). An argument with `%` cannot be passed through cmd.exe unchanged:
//    that is refused with an error instead of being expanded.
const fs = require('node:fs');
const path = require('node:path');

const META = /([()\][%!^"`<>&|;, *?])/g;

function escapeArg(arg, double) {
  let a = `${arg}`;
  a = a.replace(/(\\*)"/g, '$1$1\\"'); // a quote is escaped, the backslashes before it are doubled
  a = a.replace(/(\\*)$/, '$1$1'); // trailing backslashes would escape the closing quote
  a = `"${a}"`;
  a = a.replace(META, '^$1');
  return double ? a.replace(META, '^$1') : a;
}

const escapeCommand = (file) => file.replace(META, '^$1');

// The file for a command word on Windows: a path, or a search of PATH with PATHEXT. null when not found.
function resolveWin(word, env, exists) {
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasDir = /[\\/]/.test(word) || /^[A-Za-z]:/.test(word);
  const dirs = hasDir ? [''] : ['', ...String(env.PATH || env.Path || '').split(';').filter(Boolean)];
  const withExt = /\.[A-Za-z0-9]{1,4}$/.test(word) && exts.some((e) => word.toLowerCase().endsWith(e.toLowerCase()));
  for (const d of dirs) {
    const base = d ? path.win32.join(d, word) : word;
    for (const ext of withExt ? [''] : exts) {
      const f = base + ext;
      if (exists(f)) return f;
    }
  }
  return null;
}

// -> { file, args, options } for child_process.spawn. Throws Error for an argument that cannot be passed unchanged.
function buildSpawn(command, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const exists = opts.exists || ((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
  // One word with whitespace is a shell line, unless it is an existing file ("C:\Program Files\x\tool.exe"): then it is
  // a program path and takes the argument-list path.
  if (command.length === 1 && /\s/.test(command[0]) && !exists(command[0])) {
    return { file: command[0], args: [], options: { shell: true } };
  }
  const [word, ...rest] = command;
  if (platform !== 'win32') return { file: word, args: rest, options: {} };
  const found = resolveWin(word, env, exists);
  if (!found || !/\.(?:cmd|bat)$/i.test(found)) return { file: found || word, args: rest, options: {} };
  const bad = rest.find((a) => /[%\r\n]/.test(a));
  if (bad !== undefined) {
    throw new Error(`the argument ${JSON.stringify(bad)} cannot be passed unchanged to ${path.basename(found)} (a cmd.exe script): use the program itself, or give the whole command as one string`);
  }
  // Every shim re-reads its arguments through `%*`, so a metacharacter is escaped twice for any shim, not only the ones
  // under node_modules\.bin (this is also what cross-spawn does for a shim it cannot read).
  const line = [escapeCommand(path.win32.normalize(found)), ...rest.map((a) => escapeArg(a, true))].join(' ');
  return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
}

module.exports = { buildSpawn, escapeArg, resolveWin };
