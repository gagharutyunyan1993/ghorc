'use strict';
// A .cmd/.bat with separate arguments on Windows (heavy-slot.cjs run -- npm.cmd run test). Node cannot start a batch file
// without a shell (EINVAL), so the program is started as `cmd.exe /d /s /v:off /c ""prog" arg ..."` with the command line built
// here and passed verbatim. Nothing from the arguments reaches cmd.exe unquoted unless it is made of safe characters only.
// The rule (cmd.exe has no way to escape a double quote or a percent sign on a command line, so those are refused):
//   - an argument of [A-Za-z0-9_ - . : \ / + @] only is written as it is;
//   - any other argument is wrapped in double quotes: inside them & | < > ^ ( ) ! ; , = and spaces are plain text for cmd.exe
//     and arrive in %1 / %* with their quotes, as a program started by the script reads them (node, npm);
//   - refused (clear message, nothing runs, no slot taken): a double quote, a percent sign, a line break or NUL in any word
//     (cmd.exe expands %NAME% even inside quotes and cannot escape ", so the word could change or end the quoting), and a word
//     that needs quotes and ends in a backslash (the closing quote would be read as escaped by the program that gets it).
//   - the program (the first word) must end in .cmd or .bat. It is written as it is when it is made of safe characters only
//     (a quoted "npm.cmd" found through PATH makes %~dp0 the current directory, so npm.cmd would not find its node_modules),
//     else quoted; forward slashes become backslashes (cmd.exe reads ./x.cmd as a switch).
const BARE = /^[A-Za-z0-9_\-.:\\/+@]+$/;
const BATCH = /\.(?:cmd|bat)$/i;

const isBatch = (word) => BATCH.test(String(word));

// -> { ok: true, text } | { ok: false, reason }
function quoteWord(word) {
  const w = String(word);
  if (/["%\r\n\0]/.test(w)) {
    const c = /"/.test(w) ? 'a double quote' : /%/.test(w) ? 'a percent sign' : 'a line break or NUL';
    return { ok: false, reason: `contains ${c}, which cmd.exe cannot be given safely` };
  }
  if (w !== '' && BARE.test(w)) return { ok: true, text: w };
  if (w.endsWith('\\')) return { ok: false, reason: 'needs quotes and ends in a backslash (the closing quote would be read as escaped)' };
  return { ok: true, text: `"${w}"` };
}

// command: [program, ...args] with program ending in .cmd/.bat. -> { file, args, options } or throws Error with the reason.
function plan(command, comspec = process.env.ComSpec || 'cmd.exe') {
  const parts = [];
  for (let i = 0; i < command.length; i++) {
    const q = quoteWord(i === 0 ? String(command[i]).replace(/\//g, '\\') : command[i]);
    if (!q.ok) {
      const what = i === 0 ? 'the program' : `argument ${i}`;
      const shown = JSON.stringify(String(command[i]).slice(0, 60));
      throw new Error(`${what} ${shown} cannot be passed to ${command[0]} safely: ${q.reason}. Give the whole command as one string instead (run -- "${command.join(' ').replace(/"/g, '')}") or change the argument`);
    }
    parts.push(q.text);
  }
  return { file: comspec, args: ['/d', '/s', '/v:off', '/c', `"${parts.join(' ')}"`], options: { windowsVerbatimArguments: true } };
}

module.exports = { isBatch, quoteWord, plan };
