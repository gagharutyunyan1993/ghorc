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

// An argument of a .cmd/.bat has one rule (docs/hooks.md):
//  - only [A-Za-z0-9_./:+@-]: bare. `=` and `,` are not in the set: cmd.exe splits a bare `--mode=ci` at `%~1`.
//  - none of & | < > ^ " ! ( ): plain "word", no carets, trailing backslashes doubled. Space, `=`, `,`, `;`, `~`, `\` and
//    the empty string end here; `%~1`, `%1` and `%*` all see the word whole.
//  - one of those: escaped twice, but only for a shim that hands `%*` on (npm, npx, pnpm, yarn, node_modules\.bin\*.cmd).
//    Any other script may read the argument into a variable (`set "X=%~1"`), where a caret-escaped metacharacter runs as
//    a command: refused, like `%`.
const SAFE = /^[A-Za-z0-9_./:+@-]+$/;
const META_ARG = /[&|<>^"!()]/;
const KNOWN_SHIM = /(?:[\\/]node_modules[\\/]\.bin[\\/][^\\/]+|(?:^|[\\/])(?:npm|npx|pnpm|yarn))\.cmd$/i;

function escapeArg(arg, double) {
  let a = `${arg}`;
  a = a.replace(/(\\*)"/g, '$1$1\\"'); // a quote is escaped, the backslashes before it are doubled
  a = a.replace(/(\\*)$/, '$1$1'); // trailing backslashes would escape the closing quote
  a = `"${a}"`;
  a = a.replace(META, '^$1');
  return double ? a.replace(META, '^$1') : a;
}

// The word of an argument for the line of a .cmd; null: it has a metacharacter and needs the double escape.
function plainArg(a) {
  if (SAFE.test(a)) return a;
  if (META_ARG.test(a)) return null;
  return `"${a.replace(/(\\*)$/, '$1$1')}"`;
}

const escapeCommand =(file) => file.replace(META, '^$1');

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

// path.win32.normalize strips a leading `.\` (`.\sh.cmd` becomes `sh.cmd`, which cmd.exe then finds on PATH only, and not
// in the current directory with NoDefaultCurrentDirectoryInExePath=1): a path that started with `.\` or `./` keeps it.
function winPath(file) {
  const n = path.win32.normalize(file);
  return /^\.[\\/]/.test(file) && !n.startsWith('.\\') ? `.\\${n}` : n;
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
  // The double escape of a metacharacter argument is consumed by a shim that re-parses its arguments (`%*` handed to
  // node: the `"&echo INJECTED` fix); it is only right for a known one.
  const known = KNOWN_SHIM.test(found);
  const words = rest.map((a) => {
    const p = plainArg(a);
    if (p !== null) return p;
    if (known) return escapeArg(a, true);
    throw new Error(`the argument ${JSON.stringify(a)} cannot be passed unchanged to ${path.basename(found)} (a cmd.exe script that is not npm, npx, pnpm, yarn or a node_modules\\.bin shim): an argument with one of & | < > ^ " ! ( ) would run as a command in a script that reads it into a variable; use the program itself, or give the whole command as one string`);
  });
  const line = [escapeCommand(winPath(found)), ...words].join(' ');
  return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
}

module.exports = { buildSpawn, escapeArg, resolveWin };
