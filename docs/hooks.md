# Hooks, status line, watchdog and scripts

ghorc registers six hook scripts (the call ledger has two entries) in `hooks/hooks.json`. They are plain Node.js, make no network calls and never
rewrite a command or a file: a PreToolUse hook either stays silent (the call proceeds) or prints a deny decision with a
reason. Every deny is also appended to the denial log (below).

**Who is a subagent.** A hook input with `agent_id` is a subagent; a call without it counts as the main session.
`GHORC_ROLE=worker` (a herdr worker session) counts as a subagent for the heavy guard. `GHORC_ROLE` is optional for the
lead; `GHORC_ROLE=lead` only switches on the strict mode (`readGuard.leadNoMedia`, `heavyGuard.requireLeadEnv`).

**Failure behavior.** A hook that fails internally (bad stdin, unreadable state, an exception) allows the call. The
only deliberate deny on an error is the "config invalid" one of the heavy guard.

## read-guard.cjs

**When it fires.** PreToolUse on `Read` and on MCP screenshot, snapshot and read_page tools (the matcher is in
`hooks/hooks.json`); PostToolUse on `Edit|Write|NotebookEdit`.

**What it checks (PreToolUse).** It counts reads per agent and per resolved path (lower-cased on Windows; `offset`,
`limit` and `pages` do not make a new key) and denies:

- more than `readGuard.maxRepeat` (3) reads of one path between edits of it; a changed mtime or size (an edit by
  anyone) also starts a new count, and a file that cannot be stat-ed still counts as a read;
- a PDF without `pages`;
- PDF pages above `pdfPageBudget` (60) per agent; image bytes above `mediaByteBudget` (8 MiB) per agent; an image
  above `maxImageBytes` (2 MiB);
- any PDF or image for a subagent whose `agent_type` is not in `mediaRoles` (default `ghorc:media`, `media`);
- any PDF or image for a main session started with `GHORC_ROLE=lead` while `leadNoMedia` is true (the default).
  A plain main session, without `GHORC_ROLE`, reads images and PDFs (a PDF still needs `pages`);
- more than `maxScreenshots` (60) MCP screenshot, snapshot or read_page calls per agent (heap snapshots excluded).

Images are `.png .jpg .jpeg .gif .webp .bmp`; extensions match case-insensitively. Counters live in
`<tmp>/ghorc-<user>/<session_id>/read-<agent>.json` (written atomically); without `session_id` none is kept.

**What it checks (PostToolUse).** Nothing is denied; an Edit, Write or NotebookEdit resets the counter of that path
only. Bash and PowerShell never reset a counter.

**What it prints** (the `permissionDecisionReason`), for example:

```
slugify.js was already read 3 times: do not re-read it, use what you have or edit it first.
media is read by the media role: hand this file to ghorc:media.
the lead (GHORC_ROLE=lead) does not read media: hand it to the media role.
Do not read a PDF without pages: run pdftotext/pdftoppm or set pages, or better hand it to the media role.
```

**How to disable or loosen.** Raise `readGuard.maxRepeat` or the budgets in `.claude/ghorc.json`; set
`readGuard.leadNoMedia: false`; add an agent type to `readGuard.mediaRoles`. To switch every hook off, disable the
plugin (`claude plugin disable ghorc@ghorc`).

## heavy-check-guard.cjs

**When it fires.** PreToolUse on `Bash|PowerShell`.

**What it checks.**

- Always, for subagents and workers: `claude -p`, `herdr agent start|prompt|send-keys`,
  `herdr pane run|send-keys|send-text` and `hc run|exec|keys|interrupt` are denied. `hc send` is denied too, except for
  a worker (not a subagent) sending to its own parent terminal (`hc get $HC_TERMINAL_ID`, field `parent`): that is how a
  worker reports; an unreadable parent or target means deny. The lead may use all of them (it sends prompts and the
  handoff ACTIVATE with `herdr pane run` or `hc send`). An env prefix, `env`, `bash -c`, a path to the binary and herdr's bare or `=` global options
  (`--no-color`, `--session=x`) do not get around the deny. For `heavyCommands` the same shell wrappers are looked
  through, and so is the command after `--` of `heavy-slot.cjs run`.
- With `heavySlots.slots` above 0 ([configuration.md](configuration.md#heavyslots)): the lead too is denied a command
  matching `heavyCommands` while every slot holds a live claim of another session. The text names the holder, its
  label and age. A claim of the lead's own session does not block it. Claims that cannot be read fail open. This is an
  early hint; the lock itself is `scripts/heavy-slot.cjs` (below).
- A command matching `heavyCommands` is denied when a subagent or a `GHORC_ROLE=worker` session runs it. The lead
  runs it freely, unless `heavyGuard.requireLeadEnv` is true and the session lacks `GHORC_ROLE=lead`.
- `heavyGuard.agentsWhenFree` (default false): with `true` and `heavySlots.slots` above 0, a subagent or worker may start
  a heavy command while a slot is free, and is denied only when every slot holds a live claim (the text says
  "heavy-check slots are full" and names the holders). Unlike the lead, an agent is never exempted by a claim of its own
  parent session. With slots off the key does nothing: agents stay denied. `requireLeadEnv` does not apply to agents then.
  The lock is still `heavy-slot.cjs`: an agent should start its check through it.
- If `.claude/ghorc.json` is invalid (JSON error, wrong type, bad regex), it denies every heavy command for everyone,
  the lead too, using the valid configured patterns plus a built-in default list, and says why.
- With no project config, or an empty `heavyCommands` (the default), it denies nothing except the agent starts above.

**What it prints**, for example:

```
only the lead runs heavy checks.
only the lead runs heavy checks (GHORC_ROLE=lead is not set).
subagents and workers may not start other agents (claude -p, herdr agent start/prompt/send-keys, herdr pane run/send-keys/send-text, hc run/exec/keys/interrupt/send): ask the lead.
config invalid: <reason>. Heavy-command rules cannot be trusted: fix .claude/ghorc.json (node scripts/check-config.cjs).
no free heavy-check slot (1 configured): slot 1: session 5f3a91c2, "full", 214s ago. Wait for a slot (node scripts/heavy-slot.cjs status).
```

**How to disable.** Leave `heavyCommands` empty, or remove the pattern. Fix an invalid config with `check-config.cjs`;
the fix is seen at once.

### The agent-start deny is a seat belt, not a sandbox

The built-in deny reads the command text. It stops honest mistakes and the usual ways of writing the command; it does
not stop a subagent that wants to get around it. Forms that stay open:

- another binary or alias for herdr or hc (herdr options with a value, `--session x`, `-s x`, are seen since 0.9.0);
- a command built at run time: a variable (`$H pane run`), `eval`, `base64 -d | sh`, a script file or `node -e` that
  runs herdr or `claude -p` inside, `python -c`, `ssh host herdr ...`;
- the path of a program in a variable (`& $path`, `$H pane run`) and any wrapper not listed below. Looked through since
  0.9.0, for `heavyCommands` as well: `timeout` (with its options, also combined such as `-vk 1`, and `inf`), `nice`
  (`-n N`, `-N`, `--N`), `stdbuf`, `sudo` (options are case-sensitive: `-H` and `-P` take no value, `-u U`, `-D dir` do),
  `doas`, `setsid`, `xargs`, `env`, `chroot DIR`, `watch [-n N]`, `parallel [-j N]`, `ionice -c N`, `chrt N`,
  `taskset MASK`, `flock FILE` (also `flock FILE -c "cmd"`), `script -c "cmd"`, `find ... -exec|-execdir|-ok cmd`,
  `cmd /c start ["title"]`, PowerShell `Start-Process` and `Invoke-Expression`/`iex "cmd"` (a quoted command only; `iex $x`
  is a run-time built command);
- `node` options that take a separate value before `heavy-slot.cjs` (`node -r x heavy-slot.cjs`; bare options such as
  `--no-warnings` and `--opt=value` are looked through), and the names of the wrappers in a path or an alias;
- writing into the herdr socket or the pane input by any means other than the herdr CLI.

For a hard boundary use the permission rules of Claude Code (`permissions.deny` for `Bash(herdr pane run:*)` and so on)
or run workers without a herdr socket. Treat this deny as a second line of defence.

### Heavy-check slots: scripts/heavy-slot.cjs

Off by default (`heavySlots.slots` 0). With slots on, the lock is the wrapper, not the hook:

```
node "<plugin>/scripts/heavy-slot.cjs" run --label full -- "npm run test:full"
node "<plugin>/scripts/heavy-slot.cjs" status
node "<plugin>/scripts/heavy-slot.cjs" release --session <id>
```

- `run [--label <text>] [--session <id>] [--minutes <n>] -- <command...>` takes the first free slot, runs the command
  with the terminal attached, refreshes the heartbeat every 15 s, passes the exit code and releases the slot when the
  command ends (also on a non-zero exit and a failed start). No free slot: the command does not run, the exit code is
  75 and stderr names each holder with its full session id, label and age, for example
  `no free heavy-check slot (1 configured): slot 1: session 5f3a91c2-..., "full", 214s ago`. With `slots` 0 the command
  just runs. Run it from the project directory: the config is looked up exactly as the hook does (project root, then
  the main checkout of a linked worktree). `--help` and `-h` count only before `--`.
- The command is one of two things. An argument list (no shell: `--` `git` `status` reaches `git` as written, `&&` is
  an argument), or one string with spaces (`-- "npm run a && npm run b"`), which the shell runs (`sh -c`, `cmd /c`). A
  single word that is an existing file (`"/opt/my dir/tool"`) is a program path, not a shell line. On Windows an
  argument list whose first word ends in `.cmd` or `.bat` (case does not matter) runs through
  `cmd.exe /d /s /v:off /c` with the arguments still separate: `run -- npm.cmd run test`, `run -- .\x.cmd "a b"`. Each
  argument made of `A-Z a-z 0-9 _ - . : \ / + @` is written as it is; any other argument is wrapped in double quotes, so
  `& | < > ^ ( ) ; , = !` and spaces are plain text and arrive as one argument, never as a second command. An argument
  that cannot be quoted safely is refused: exit 2, nothing runs, no slot taken, and the message names the argument and
  says to give the whole command as one string. Refused: a double quote and a percent sign (cmd.exe expands `%NAME%`
  inside quotes and has no escape for `"`), a line break, and an argument that needs quotes and ends in a backslash. A
  bare `npm` in an argument list is not found on Windows (exit 127): write `npm.cmd`. A command that cannot start ends
  with a message and a non-zero exit, and the slot is released. The hook blanks quoted text before it matches, so it does not read
  inside a quoted one-string command; the wrapper still takes the lock.
- The session of the claim is `--session`, else `$GHORC_SESSION`, else `$CLAUDE_CODE_SESSION_ID` (Claude Code sets it
  in the environment of the shell tools, and it equals the `session_id` the hook receives), else `pid-<parent pid>`.
  With the default, a check the lead starts counts as the lead's own: the hook does not block it.
- The claim is the file `<tmp>/ghorc-<user>/heavy-slots/slot-<n>.json` (under `GHORC_TMP` when set), created
  exclusively, with `{ session, pid, ts, heartbeat, minutes, label }` (and a `nonce`). Every change of a slot (take,
  remove a dead claim, heartbeat, release) happens under a per-slot lock file `slot-<n>.lock`, so of any number of
  processes racing for a slot one wins, and the removal of a dead claim cannot touch a live one. A claim is live
  while its pid is alive and the heartbeat is younger than 2 minutes; a dead one is removed by the next taker. The
  heartbeat stops only when the file holds another claim; a missing or unreadable file does not stop it.
- A claim the hook cannot parse (empty, cut in the middle) does not block the hook; the wrapper treats it as live for
  2 minutes by the age of the file.
- `--minutes <n>` announces how long the check should take. `status` and the "no free slot" text mark a live claim
  past it ("over its n min"); it is reported, never removed. `release --session <id>` (the id as `status` prints it)
  removes the claims of a session at once; a command that is still running then runs without a slot.
- The slots above the first need `heavySlots.minFreeRamGb` of free RAM (`os.freemem()`, which counts cache, so it is
  a weak signal). A claim of the lead's own session on any slot lets the hook pass whatever the RAM. `status` prints the
  slots, the holders and the free RAM.
- Signals: on POSIX SIGINT, SIGTERM and SIGHUP stop the command, release the slot and exit 130, 143 and 129. On Windows
  only Ctrl-C, Ctrl-Break and closing the console reach the handlers; `process.kill(pid, 'SIGTERM')` ends the wrapper
  at once, the command may keep running, and the claim goes stale and expires after 2 minutes.
- Known limits: the claim follows the wrapper process, not the command tree, so a command that outlives a killed
  wrapper is not counted; the pid check can be fooled by pid reuse until the heartbeat goes stale; a machine that sleeps
  longer than 2 minutes makes the live wrapper's claim stale, and the next taker may remove it on wake; a lock file left
  by a crash is broken after its owner is gone. That break is a check followed by a rename, so one case is not
  covered: a process killed while it holds the lock (a lock held for milliseconds), and then three racers at once (a
  breaker that read the old lock, a second one that broke it and entered, a third that took the lock name). The claim
  is then not guaranteed to be exclusive: the third racer can run without a claim, and a put-back can delay others for
  up to 10 s. Not seen in 40 rounds of 8 racers on a planted stale lock.

### heavyCommands semantics

Each string is a JavaScript regex compiled with flag `i` (case-insensitive). A command is cut into segments at `&&`,
`||`, `;`, `|`, `&`, newlines, `( ) { }`, `$(` and backticks; quoted text is blanked first, except the quoted argument
of a shell wrapper (`bash -c "..."`, `cmd /c "..."`, `powershell -Command "..."`) and `$(...)` or backticks inside
double quotes. The regex must match at the START of a segment, after optional env assignments (`FOO=1 `) and wrappers
(`cmd /c`, `bash -c`, `powershell -Command`, `call`, `time`, `exec`, `env`, `command`, `nohup`, and the command
after `--` of `heavy-slot.cjs run`; and, since 0.9.0, `timeout` with its options, `nice`, `stdbuf`, `sudo`, `doas`, `setsid`, `xargs`, `chroot`, `watch`, `parallel`, `ionice`, `chrt`, `taskset`, `flock`, `script -c`, `find -exec`, `iex`, `cmd /c start`, which are also tried peeled while a pattern on the wrapper itself (`^timeout`) keeps matching). npm global options (`--prefix app`, `-C app`, `-w x`,
`--silent`) are dropped, `run-script` reads as `run`, and a leading `npm run ` or `npx ` is also tried off, so
`^vitest` matches `npx vitest`. Hence `git commit -m "run npm test"` and `echo npm test` are ordinary, while
`cd app && npm test` is heavy. Write patterns for the segment start (`^npm\s+test\b`); backslashes are doubled in
JSON. An empty string matches everything; a pattern that does not compile makes the config invalid. Test patterns:

```
node "<plugin>/scripts/check-config.cjs" --sample "npm test | tail -5" --sample "npm run lint"
```

Bash heredoc bodies (`cat > x.md <<'EOF' ... EOF`, also `<<EOF` and `<<-EOF`) are not commands and are skipped; the line
that opens the heredoc and everything after the terminator are matched as usual, and an unterminated heredoc hides
nothing. For the PowerShell tool and `powershell`/`pwsh` wrappers the command is also read with PowerShell quoting
(a backtick escapes, a backslash is plain text, so `cd "D:\a\"; npm test` still exposes `npm test`); a segment found
either way counts.

Since this version the matcher also reads forms that the plain cut missed (ported from a project classifier; each only
adds matches). Text sent to a shell on stdin is a script: `bash <<EOF ... EOF`, `cat <<EOF | bash`, `echo 'npm test' | sh`;
`echo test | xargs npm` runs `npm test`. A program is read without its directory and `.cmd`/`.exe`/`.bat`/`.ps1`/`.com`
(`C:\x\npm.cmd test`, `./node_modules/.bin/vitest run`), also in quotes (`& "C:\Program Files\nodejs\npm.cmd" test`,
`"npm" test`) and with glued quotes or escapes (`np""m`, `npm "test"`, `n\pm`). A backslash or backtick at the end of a
line continues the command. Also peeled: shell keywords (`if`, `then`, `do`, `while`, `!`), a PowerShell assignment
(`$x = npm test`), a redirection in front (`> out npm test`), `@`, `wsl`, `corepack`, `cross-env`, `eval "..."`,
`env -S "..."`, `gtimeout`, `cmd /r`, `sh -ec`, `ksh`, a bare `powershell "npm test"` and `-EncodedCommand`;
`Start-Process`/`saps` with a quoted path or positional arguments; `npm t`/`tst`, `npm exec|x`, `npx -y|-p x|-c "..."`
and `node .../node_modules/vitest/vitest.mjs`. A command text that cannot be read is matched as before: this never
throws and never denies more because of a parse failure. Still open: a program in a variable (`& $npm test`), `iex $x`,
a script file or `node -e` that runs the check inside.

It prints `config: <path>`, any `ERROR:` lines (invalid JSON, unknown key, wrong type, bad regex) and, per sample,
`HEAVY (<pattern>)` or `ordinary`. On a config error SessionStart prints one `config invalid:` line and the heavy guard
denies as above; an unknown key alone prints `config warning:` and denies nothing. Validation results are cached by
file mtime and size in `<tmp>/ghorc-<user>/config-valid.json`.

## context-guard.cjs

**When it fires.** SessionStart (matcher `compact`), UserPromptSubmit, PreToolUse on every tool, and Stop; for the lead
only (no `agent_id`, not `GHORC_ROLE=worker`). A worker session gets a reminder only. The compaction entry is inert
unless `handoff.stickyOnCompact` is true.

**What it does.** See [handoff.md](handoff.md#the-context-guard): stage lines at `ctxPrepare` / `ctxWarn`; handoff mode
at `ctxHandoff` (flag; denies a new Agent and edits outside STATE/HANDOFF; Stop blocks until STATE is newer, at most 2
times). With `handoff.stickyOnCompact` also after any compaction (the flag is cleared only by HANDOFF `status: SENT`
of this session; Stop blocks once per turn until SENT; only a session with `GHORC_ROLE=lead` is denied or blocked for
a compaction, others get a reminder). With `handoff.pushGuard` also `herdr agent start` and `hc run ... claude` while in-flight branches are
unpushed. Secondary signals that never block: transcript size against `watchdog.warnMiB` and unread watchdog
alerts (PreToolUse at most every 5 minutes). Without a fresh ctx file (younger than 10 minutes) and without a flag it
only warns. The flag and its throttle state live in `<tmp>/ghorc-<user>`; a deny is logged to `denials.log`.

**How to disable or loosen.** Raise `thresholds.ctxHandoff`, or disable the plugin.

## capacity-guard.cjs

**When it fires.** Stop, UserPromptSubmit, SubagentStart and SubagentStop. Off by default: without
`capacity.enabled: true` ([configuration.md](configuration.md#capacity)) it prints nothing and writes nothing.
It acts for the lead only (no `agent_id`, not `GHORC_ROLE=worker`); SubagentStart/Stop only feed the ledger.
Stop is silent when the last answer has no text (the field is missing or not a string), when `HANDOFF.md` says
`status: SENT` for this session (the old lead goes idle) and while the handoff flag of the context guard is set.

**What it does.**
- Stop returns the turn once (never when `stop_hook_active`) when agents < `capacity.agents` AND average CPU <
  `cpuStartPct` AND free RAM >= `minFreeRamGb` AND the last answer has no line that starts with `idleMarker` (default
  `Idle:`) followed by a real reason: at least 4 letters or digits, at least 2 distinct, not the placeholder `<reason>`.
  The line may carry a list marker, a number, a quote or bold (`**Idle:** x`, `**Idle**: x`). The check order is
  cheap first; CPU is sampled last.
- Agents are the in-flight `subagent` and `teammate` entries of the Stop input `background_tasks`; when the field is
  missing, the SubagentStart/Stop ledger `<project>/.claude/ghorc-out/capacity-ledger.jsonl` (an entry older than
  3 hours is stale). The session's entries are cleared only when no in-flight task of any agent-bearing type is listed
  (a `workflow` or cloud session keeps them; `shell` and `monitor` carry no agent). While such a task runs, its agents
  are not listed in `background_tasks`, so the count is the larger of the listed subagents and teammates and the
  session's ledger entries. To that it adds the workers
  of the active terminal backend (`node scripts/backend.cjs`): with `hc` (`HC_TERMINAL_ID` set), the live terminals of
  `hc ls --json` with status `working` or `blocked`, a `parent` (a terminal started by the owner has none), a name not
  starting with `leadNamePrefix`, not this terminal; with `herdr` (`HERDR_ENV=1` and a server that answers), the
  entries of `herdr agent list` with status `working` or `blocked`, name not starting with `leadNamePrefix`, session
  not this one. Backend `none` (neither variable, herdr not installed or its server not running, error code
  `server_not_running`, hc not installed) means 0 workers; any other failure of the active backend makes the count
  unknown and the hook silent (logged). If both variables are set, `hc` wins.
- The worker count is machine-wide on purpose: the limit protects the machine, not one project. Workers of other
  projects and other leads whose name does not start with `leadNamePrefix` count as workers while they are `working`
  or `blocked`, so a busy neighbour keeps this lead silent. Name your leads with the prefix to keep them out.
- UserPromptSubmit adds the line `agents N/M, CPU X%, free Y GB` to the context (CPU: one 400 ms sample).
- CPU is the average of three `os.cpus()` intervals (400 ms each, one interval is capped at 500 ms: Stop waits 1.5 s at
  most); free RAM is `os.freemem()`. No child process for either.
- Weekly cap, when `weeklyCapPct` > 0: `rate_limits.seven_day` of `<project>/.claude/ctx-<session_id>.json` (written
  by the status line; `resets_at` is epoch seconds, the file's `ts` is milliseconds). `f` = clamp((now - (resets_at -
  7 days)) / 7 days, 0, 1). `used >= weeklyCapPct`: Stop demands no agents and the prompt line says `WEEKLY CAP`.
  `used > weeklyCapPct * f` and `agentsOverPace` > 0: Stop demands agents only while there are fewer than
  `agentsOverPace`.
  Data of a past or missing `resets_at`, or taken from the newest other session's ctx file, is marked `(stale)`; no data
  at all: the plain rules, a line in the prompt and in the log.

**Failure behavior.** Fails open: any error allows the turn and goes to `.claude/ghorc-out/capacity-guard.log`. The
ledger is append-only and takes no lock; only the compaction of a file over 256 KB takes a lock file, and a busy lock
skips the compaction (logged), it never fails the event. Compaction copies the events appended while it ran and removes
its temp file when it fails; `cleanup` removes old `capacity-ledger.jsonl.<pid>.tmp` leftovers. A start whose stop was
lost during a compaction stays a phantom agent for at most 3 hours; phantoms are possible under heavy concurrency
(about 25 in 15000 start/stop pairs from 10 processes) and rare in normal use.

**How to disable or loosen.** `capacity.enabled: false`, a lower `agents`, a higher `cpuStartPct`. Test seams, env:
`GHORC_CAPACITY_CPU_PCT`, `GHORC_CAPACITY_FREE_GB` (instead of measuring), `GHORC_CAPACITY_HC_JSON` (the output of `hc ls --json`), `GHORC_CAPACITY_HERDR_JSON` (the output of
`herdr agent list`), `GHORC_HC_BIN` / `GHORC_HERDR_BIN` (a program path or a JSON array `[program, ...args]` replacing `hc` / `herdr`), `GHORC_CAPACITY_LEDGER` (ledger path), `GHORC_CAPACITY_SAMPLE_MS` (one CPU interval).

## ledger.cjs

**When it fires.** PostToolUse on `Agent` (`ledger.cjs hook`) and SubagentStop (`ledger.cjs stop`). It never denies
and prints nothing; any error exits 0. It writes only inside an existing project directory.

**What it does.** Appends one line per subagent call to `<project>/.claude/ghorc-out/ledger.jsonl` (role, requested
and resolved model, requested effort, tokens, duration, tool count; never the prompt or the response). A background call
gets a `launch` line at once and a `done` line (transcript totals) from SubagentStop. `ledger.cjs
verdict` and `ledger.cjs report` are the lead's commands, see `/ghorc:status` and [evidence.md](evidence.md#call-ledger).

## session-start.cjs

**When it fires.** SessionStart. It never denies anything.

**What it prints**, in this order: pending watchdog alerts (count and the last 2 lines),
`ghorc <version> session=<id> role=<role>`, the config status, `lead: load skill ghorc:lead` for the lead, a missing
`CLAUDE.md` section and a `run /ghorc:setup` hint when a setup item is missing. `role` is `GHORC_ROLE` if set, else
`lead` for a main session and `agent` for a subagent. Output is cut at 299 characters and ends with `+more: run ctx`
when cut. A captured run in a plain session of `examples/demo`:

```
ghorc 0.5.0 session=a1b2c3d4-0000-4000-8000-000000000001 role=lead
config: ok
lead: load skill ghorc:lead
run /ghorc:setup
```

**What else it does.** It removes `ctx-*.json` files, session state and alert offsets older than 7 days, and trims the
denial log to 7 days. When `watchdog.autostart` is true (default false) and the session is a main session with
`GHORC_ROLE` empty or `lead`, it starts or restarts the project's watchdog. It does not start one for a drive root,
`/`, the home directory or a missing transcript directory (it prints `watchdog: not started (<reason>)`).

**How to disable.** `lead.remind: false` drops the reminder for a plain main session; `GHORC_NO_AUTOSTART=1` never
starts the watchdog.

## Denial log

Every deny of the read guard and the heavy guard appends `<iso time> <session8> <hook> <reason>` to
`<tmp>/ghorc-<user>/denials.log`; cleanup keeps 7 days. `/ghorc:status` (through `setup.cjs --check --status`) shows
the counts per hook and the last lines:

```
status: role=lead (GHORC_ROLE not set)
status: read-guard on (maxRepeat=3, media blocked for the lead: no), heavy-check-guard on (2 patterns)
status: watchdog autostart=off, not running (no pid file)
status: denials 2 total (read-guard=1, heavy-check-guard=1), last 2:
```

## Status line

`scripts/statusline.cjs` is not a hook: `/ghorc:setup` (item `statusLine`) adds it to `~/.claude/settings.json`.

```
model ·effort [⚡] │ ctx NN% (used/size) [→ac N%] │ 5h NN% (~Nh) │ 7d NN% (~Nh) │ role │ [⎇ ]branch │ session
```

A segment is omitted when its data is absent.

| Segment | Meaning |
|---|---|
| `model` (bold) | `model.display_name`, else `model.id`, else `model?` |
| `·effort` (dim) | the session effort level |
| `⚡` | fast mode is on |
| `ctx NN% (used/size)` | context fill; used = input + cache creation + cache read tokens; `ctx --` with no data |
| `→ac N%` (dim) | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, only when set |
| `5h`, `7d` | rate limit use and time to reset (`~Nh`, `~Nm` under an hour, `~Nd` from 48 h for `7d`) |
| `role` | `GHORC_ROLE` and the agent name, if any |
| `#xxxxxxxx` | first 8 characters of `session_id`: the value for `ctx.cjs --session` |
| `branch` (cyan) | git branch, short SHA when detached; `⎇ ` prefix inside a git worktree |
| `session` | session name, first 24 characters |

Colors for `ctx`, `5h`, `7d`: green below 50%, yellow 50-69%, red 70-79%, bold red from 80%. `NO_COLOR` or
`GHORC_STATUSLINE_PLAIN=1` turn color off. On an internal error it prints `model │ ctx ?%`. Cost is not shown.
`GHORC_GIT_TIMEOUT_MS` raises the 300 ms git call timeout (tests use it). It writes
`<project root>/.claude/ctx-<session_id>.json`, which `ctx.cjs` reads.

**Previous status line.** `setup.cjs --apply statusLine` saves the status line it replaces, once, in
`~/.claude/ghorc-statusline-backup.json` (next to `settings.json`); a ghorc line, even a stale one, is never saved as
"previous". `setup.cjs --restore statusline` puts the saved value back (the key is removed when there was none), keeps a
`settings.json.ghorc-<stamp>.bak` copy and deletes the backup. `setup.cjs --check` prints
`statusline: ghorc (previous saved)`, `ghorc`, `other` or `none`.

Verified against a live sample (Claude Code 2.1.300): `rate_limits.five_hour` and `.seven_day` are
`{used_percentage, resets_at}` with `resets_at` in epoch seconds; `effort` is `{level}`; `model` is
`{id, display_name}`. Other key spellings in the script are defensive fallbacks only.

## Reading ctx and watchdog alerts

```
node "<plugin>/scripts/ctx.cjs" --session <id from the #xxxxxxxx status segment or from SessionStart>
node "<plugin>/scripts/ctx.cjs" --all
```

Take the id from the `#xxxxxxxx` status line segment or the `session=` field of the SessionStart line; the lead never
guesses "the newest file". The output is a line like `ctx-<id>.json  Opus  ctx 62%  used=124000/200000  age=0m`. Then
`watchdog alerts (N unread):` and up to 10 lines, oldest first, marked read once shown (alerts of other sessions keep
their own offsets). The SessionStart line `N watchdog alerts pending, run ctx` means unread alerts exist.

## Watchdog

The transcript watchdog is off by default (`watchdog.autostart: false`). Turn it on with `/ghorc:setup` (item
`watchdog`, `--apply watchdog`); stop a running one with `node "<plugin>/scripts/watchdog.cjs" --stop` in the project
directory (or `--project-root <dir>`). It is a detached background process, one per project root, that watches only
that project's transcript directory (`~/.claude/projects/<encoded project root>`, `subagents/` included), reads file
sizes only and notifies only: it stops nothing.

- `growth above 10 MiB/min for longer than 120 s`: a transcript grows fast; look for a read or tool loop in it.
- `over 100 MiB, check what the content is`: large transcript; check for big Read results or media.
- `ALARM, over 250 MiB and growing`: a runaway session; stop it yourself.
- `ALARM, subagent file over 500 MiB`: a runaway subagent; stop it, then check its brief.

Each alert names the transcript path, its size and growth rate. Size alerts are remembered in
`<tmp>/ghorc-<user>/watchdog-<root hash>.state.json`: a restart does not repeat them; one repeats only after the file
grew by `warnMiB`/2 since its last alert or the level rose. A file already above `stopMiB` when first seen raises the
stop alarm at once. The growth streak drops by one on a slow poll instead of resetting. The pid file (JSON: pid,
version, root, start time) and a heartbeat file are touched every poll; SessionStart restarts a watchdog whose pid is
dead, whose version differs or whose heartbeat is older than two intervals. It kills nothing (a stale pid may be a
foreign process): it writes a new pid file, and an older watchdog that sees a pid other than its own there exits on
its next poll. It also exits when its project root no longer exists.

## Scripts (`scripts/`, run with `node`, all accept `--help`)

- `statusline.cjs` (stdin): the status line; writes `<project root>/.claude/ctx-<session_id>.json`.
- `ctx.cjs --session <id> [--max-age <minutes>] [--cwd <dir>]` or `ctx.cjs --all`: this session's ctx file, then up
  to 10 unread watchdog alerts of this session, oldest first; only the shown ones are marked read. `--session` takes
  the full id or the 8-character prefix from the status line; env `GHORC_SESSION` is the default. Without both it
  prints a usage line and exits 2. `--all` lists every session and marks nothing.
- `watchdog.cjs [--interval 30] [--rateMiBPerMin 10] [--streakSec 120] [--warnMiB 100] [--stopMiB 250]
  [--subagentsMiB 500] [--transcript-dir <dir>] [--project-root <dir>] [--version <v>] [--once]
  [--notify "<program and args>"] [--notify-file <path>] [--pid-file <path>] [--heartbeat-file <path>]`, or
  `watchdog.cjs --stop [--project-root <dir>]`. `--root` is the older name of `--transcript-dir`. `--notify` splits
  the string into an argv array (double quotes group words) and spawns it without a shell; the alert text is the last
  argument and is also in `GHORC_ALERT`; for a script use `--notify "cmd /c script.cmd"`. `--notify-file` appends
  `<ISO time> <text>` lines. `--once` scans once and exits.
- `setup.cjs --check [--status] | --apply <all|id,id,...> [--project] [--cwd <dir>]`: checks and applies the
  recommended setup ([workflow.md](workflow.md#setup-items)); `--status` adds the role, guard, watchdog and denial
  lines.
- `check-config.cjs [--cwd <dir>] [--sample "<command>"]...`: validates `ghorc.json`, shows which `heavyCommands`
  match each sample; exit code 1 on errors.

## Project root and config lookup

Hooks look for `.claude/ghorc.json` in `CLAUDE_PROJECT_DIR`, then in each directory from the cwd up to the nearest
`.git`, then in the main repository root (parent of `git rev-parse --git-common-dir`, so a worktree finds the main
repository's config). With no file the defaults apply: the read guard works, `heavyCommands` is empty, nothing is
denied as heavy.

Hooks, the status line and `ctx.cjs` agree on one root (`scripts/lib/root.cjs`): `CLAUDE_PROJECT_DIR` if set, else
the main git root of the cwd (a worktree maps to the main repository), else the cwd. `setup.cjs`, `check-config.cjs`
and `watchdog.cjs --stop` use the git toplevel of the directory they run in (`--cwd` or `--project-root` overrides),
so a worktree is its own root for them; they ignore `CLAUDE_PROJECT_DIR`.

Every git call of these scripts goes through one helper (`git()` in `scripts/lib/root.cjs`): 1 s per call, 2.5 s for
all calls of one process, and after the first timeout no further git is started. A hanging git therefore costs
SessionStart about one second and it still prints its line.
