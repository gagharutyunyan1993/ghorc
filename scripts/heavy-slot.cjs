'use strict';
// Heavy-check slot wrapper: the real lock behind heavySlots (the heavy-check hook is only an early hint).
//   heavy-slot.cjs run [--label <text>] [--session <id>] [--minutes <n>] -- <command...>
//   heavy-slot.cjs status
//   heavy-slot.cjs release --session <id>
// run: takes a free slot, runs the command with the terminal attached, refreshes the heartbeat while it runs, passes its
// exit code and releases the slot on exit (also on a signal). No free slot: nothing runs, exit 75, the message names the
// holders. heavySlots.slots = 0 (the default): the command just runs, no claim.
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const slots = require('./lib/slots.cjs');
const runcmd = require('./lib/runcmd.cjs');
const { load } = require('./lib/config.cjs');
const { gitTimedOut, GIT_TIMEOUT_MS } = require('./lib/root.cjs');

const EXIT_BUSY = 75;
const argv = process.argv.slice(2);
const cmdName = argv[0];
// --help and -h are looked for before `--` only: after it they belong to the command
const dashAt = argv.indexOf('--');
const ownArgs = dashAt >= 0 ? argv.slice(0, dashAt) : argv;

if (ownArgs.includes('--help') || ownArgs.includes('-h') || !cmdName) {
  console.log(
    'heavy-slot.cjs run [--label <text>] [--session <id>] [--minutes <n>] -- <command...>\n' +
      '  Takes a heavy-check slot (heavySlots in .claude/ghorc.json), runs the command, passes its exit code, releases the\n' +
      '  slot. Exit 75: no free slot (the message names the holder, its label and age). slots = 0: runs the command as is.\n' +
      '  The command is an argument list (no shell) or one string with spaces (run by the shell). On Windows a .cmd/.bat\n' +
      '  first word (npm.cmd) runs through cmd.exe with each argument quoted; one that cannot be quoted safely (a " or %) is refused.\n' +
      '  The session defaults to --session, $GHORC_SESSION, $CLAUDE_CODE_SESSION_ID, else pid-<parent pid>.\n' +
      '  --minutes <n>: how long the check should take; status reports a claim past it (it is not removed).\n' +
      'heavy-slot.cjs status                    slots, holders, free RAM\n' +
      'heavy-slot.cjs release --session <id>    removes every claim of a session (a stuck slot)',
  );
  process.exit(cmdName ? 0 : 2);
}

function opt(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function status(sc) {
  if (sc.warning) console.error(`warning: ${sc.warning}`);
  if (!sc.slots) return console.log('heavy slots: off (heavySlots.slots = 0)');
  const now = Date.now();
  console.log(`heavy slots: ${sc.slots}, minFreeRamGb ${sc.minFreeRamGb}, free RAM ${slots.freeRamGb().toFixed(1)} GB`);
  for (let i = 1; i <= sc.slots; i++) {
    const r = slots.readClaim(slots.slotFile(i));
    const c = r && r.claim;
    if (!r) console.log(`slot ${i}: free`);
    else if (!c) console.log(`slot ${i}: unreadable claim (${slots.isLive(r, now) ? 'being written' : 'dead'})`);
    else {
      const beat = Number(c.heartbeat) || Number(c.ts);
      console.log(
        `${slots.holderText(i, c, now)}, pid ${c.pid}, heartbeat ${Math.round((now - beat) / 1000)}s ago, ${slots.isLive(r, now) ? 'live' : 'dead'}`,
      );
    }
  }
}

// One string with whitespace that is not an existing file: a shell line. Anything else: the argument list, no shell. A
// .cmd/.bat argument list on Windows runs through cmd.exe with every argument quoted by lib/runcmd.cjs; an argument that cannot
// be quoted safely makes launchPlan throw, before any slot is taken.
function launchPlan(command, win = process.platform === 'win32') {
  const [word, ...rest] = command;
  if (command.length === 1 && /\s/.test(word) && !fs.existsSync(word)) return { file: word, args: [], options: { shell: true } };
  if (win && runcmd.isBatch(word)) return runcmd.plan(command);
  return { file: word, args: rest, options: {} };
}

function run(sc) {
  const command = dashAt >= 0 ? argv.slice(dashAt + 1) : [];
  if (!command.length) {
    console.error('heavy-slot.cjs run: no command (usage: run [--label <text>] -- <command...>)');
    process.exit(2);
  }
  const head = argv.slice(1, dashAt);
  if (sc.warning) console.error(`warning: ${sc.warning}`);

  let launch;
  try {
    launch = launchPlan(command);
  } catch (e) {
    console.error(`heavy-slot.cjs: ${e.message}`);
    process.exit(2);
  }

  let got = null;
  if (sc.slots) {
    got = slots.acquire(sc, {
      session:
        opt(head, '--session') ||
        (process.env.GHORC_SESSION || '').trim() ||
        (process.env.CLAUDE_CODE_SESSION_ID || '').trim() ||
        `pid-${process.ppid}`,
      label: opt(head, '--label') || command.join(' ').slice(0, 80),
      minutes: Number(opt(head, '--minutes')) || 0,
    });
    if (!got.slot) {
      console.error(got.message);
      process.exit(EXIT_BUSY);
    }
  }

  let done = false;
  const free = () => {
    if (got && !done) {
      done = true;
      try {
        slots.release(got.slot, got.nonce);
      } catch {
        /* a stale claim is removed by the next taker */
      }
    }
  };
  let timer = null;
  if (got) {
    timer = setInterval(() => {
      if (!slots.heartbeat(got.slot, got.claim)) clearInterval(timer);
    }, slots.heartbeatMs());
    timer.unref();
  }

  const win = process.platform === 'win32';
  const child = spawn(launch.file, launch.args, { stdio: 'inherit', windowsHide: true, ...launch.options });
  const killChild = () => {
    try {
      if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  };
  // Windows: only Ctrl-C / Ctrl-Break / closing the console reach these handlers; process.kill(pid, 'SIGTERM') ends the
  // process at once without them (the claim then goes stale and expires).
  const signals = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, ...(win ? { SIGBREAK: 21 } : {}) };
  for (const [sig, n] of Object.entries(signals)) {
    process.on(sig, () => {
      killChild();
      free();
      process.exit(128 + n);
    });
  }
  process.on('exit', free);
  child.on('error', (e) => {
    free();
    const hint =
      win && e.code === 'ENOENT'
        ? ` (on Windows a bare npm is not found in an argument list: write npm.cmd, or give the whole command as one string, run -- "${command.join(' ')}")`
        : '';
    console.error(`heavy-slot.cjs: cannot run "${command[0]}": ${e.message}${hint}`);
    process.exit(127);
  });
  child.on('close', (code, signal) => {
    free();
    process.exit(code === null ? (signal ? 128 + 15 : 1) : code);
  });
}

try {
  const sc = slots.slotConfig(load(process.cwd())); // the same lookup as the hook
  if (gitTimedOut()) {
    // the config may have been looked up in the wrong place (a linked worktree reads the main checkout's): heavy slots may
    // read as off. The command still runs and the exit code is the command's.
    console.error(`heavy-slot.cjs: warning: git did not answer within ${GIT_TIMEOUT_MS} ms (GHORC_HOOK_GIT_TIMEOUT_MS), so the project config may not have been found: heavy slots may read as off and the command may run without a claim`);
  }
  if (cmdName === 'run') run(sc);
  else if (cmdName === 'status') status(sc);
  else if (cmdName === 'release') {
    const session = opt(argv, '--session');
    if (!session) {
      console.error('heavy-slot.cjs release: --session <id> is required');
      process.exit(2);
    }
    console.log(`released ${slots.releaseSession(session)} claim(s) of session ${session}`);
  } else {
    console.error(`heavy-slot.cjs: unknown command "${cmdName}" (run | status | release)`);
    process.exit(2);
  }
} catch (e) {
  console.error(`heavy-slot.cjs: ${e && e.message ? e.message : e}`);
  process.exit(1);
}
