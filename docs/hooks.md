# Hooks, status line, watchdog and scripts

ghorc registers nine hook scripts (the call ledger has two entries; the git and CI retry guards are opt-in) in `hooks/hooks.json`. They are plain Node.js, make no network calls and never
rewrite a command or a file: a PreToolUse hook either stays silent (the call proceeds) or prints a deny decision with a
reason. Every deny is also appended to the denial log (below).

**Only in projects that opted in.** ghorc is installed at user scope, so its hooks run in every project. They act only
where `.claude/ghorc.json` exists (found from the cwd, its ancestors or the main repository root of a linked worktree;
an unreadable file still counts). Without one every hook is silent: nothing is denied, blocked, reminded or written
(no ledger, no watchdog, no ctx files), and the status line shows its line but writes no ctx file for it. `/ghorc:setup` (item `config`) opts a project in.

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
slugify.js was already read 3 times: do not re-read it, use what you have or edit it first. For a long file, send a scout (ghorc:scout) instead of reading it in parts.
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

## agent-guard.cjs

PreToolUse on `Agent|Task`, for the lead only (no `agent_id`, `GHORC_ROLE` not `worker`), in a project with
`.claude/ghorc.json`, while `agentGuard.enabled` is true (the default). It denies:

- A call without `subagent_type`: it starts `general-purpose`.
- `subagent_type` `fork`: a fork inherits the lead's whole context and always runs on the lead's model (a per-call
  `model` is ignored), so every turn costs the lead's rates.
- `subagent_type` `Explore`, `Plan` or `general-purpose`, unless the project defines its own agent of that name in
  `.claude/agents/<name>.md` (`/ghorc:setup` item `explore` writes a Haiku `Explore`). They have no ghorc report
  contract (a short report, check rules, an effort in the frontmatter), and without a `model` they run on the session's
  model (the guide: "the built-in Explore subagent runs on your session's model"). The reason names `ghorc:scout` and
  `ghorc:log-reader`.
- A call without `model`. A role without a model in its frontmatter (a project agent, an agent of another plugin)
  runs on the lead's model; the call's `model` outranks the frontmatter, so the lead passes it from the Routing table.

A missing `effort` is not denied: every ghorc role has an effort in its frontmatter. Subagents, workers and projects
without a config are never judged.

## context-guard.cjs

**When it fires.** SessionStart (matcher `compact`), UserPromptSubmit, PreToolUse on every tool, and Stop; for the lead
only (no `agent_id`, not `GHORC_ROLE=worker`). A worker session gets a reminder only. The compaction entry is inert
unless `handoff.stickyOnCompact` is true.

**Proven lead.** "The lead" for a block is the proven lead (`provenLead` in `scripts/lib/role.cjs`): `GHORC_ROLE=lead`
is yes and `GHORC_ROLE=worker` is never (neither asks anything). With no role the terminal must prove it: on hc `hc get <id>`
shows a terminal named with `capacity.leadNamePrefix` (default `lead-`) or one without a parent; on herdr this session's agent
name starts with the prefix as configured (`lead-` matches `lead-next45`, not `leaderboard-ui`, `leads-export` or `leadtime`; a prefix configured without a dash matches `lead1`). The backend is chosen by `backend.prefer` when both are present. The lookup is
asked lazily, only where the answer matters (a compaction, a compaction-only flag, Stop with a flag), takes at most 1.5 s
(`GHORC_TOOL_TIMEOUT_MS`) and never throws; a missing tool, a timeout or an answer that does not look like this
terminal means "not proven", i.e. not blocked. A roleless lead on hc/herdr is therefore blocked in sticky mode now.
Known limits: on `hc` a terminal without a parent counts as a proven lead (an owner-opened helper session, or a `claude`
started inside the lead's terminal, is blocked as the lead), and the `hc get` output shape was not verified against a live
herdr-app. With both backends present and a dead preferred backend the lookup may exceed the hook timeout; then the guard
fails open (no block).

**Session root.** `STATE.md` and `HANDOFF.md` (`handoff.statePath` / `handoffPath`) are resolved against the root of the
session's own work tree (`sessionRoot` in `scripts/lib/root.cjs`): inside a linked git worktree that is the worktree's top
level, so a lead branch hands over from its own worktree. When `CLAUDE_PROJECT_DIR` is set it is that directory, whatever
the cwd has drifted into (a lead started in the main checkout that `cd`s into a linked worktree still edits and releases
`<main>/HANDOFF.md`); in a plain checkout or without git it is the project root. `capacity-guard.cjs` reads HANDOFF.md
through the same helper. The ctx files, flags and watchdog alerts stay under the project root.

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
`status: SENT` for this session (the old lead goes idle) and while the handoff flag of the context guard is set. A compaction-only flag
(`handoff.stickyOnCompact`) silences Stop for the proven lead only (see context-guard.cjs); a flag set by the token
numbers silences it for every session.

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
- UserPromptSubmit adds the line `agents N/M machine-wide, CPU X%, free Y GB` to the context (CPU: one 400 ms sample); N counts agents of every
  project on the machine, so it is a load indicator, not the limit on one lead's workers (that is `tabs.maxWorkers`).
- CPU is the average of three `os.cpus()` intervals (400 ms each, one interval is capped at 500 ms: Stop waits 1.5 s at
  most); free RAM is `os.freemem()`. No child process for either.
- Weekly cap, when `weeklyCapPct` > 0: `rate_limits.seven_day` of the ctx file `<os tmp>/ghorc-<user>/ctx/<root hash>/ctx-<session_id>.json` (written
  by the status line; `resets_at` is epoch seconds, the file's `ts` is milliseconds). `f` = clamp((now - (resets_at -
  7 days)) / 7 days, 0, 1). `used >= weeklyCapPct`: Stop demands no agents and the prompt line says `WEEKLY CAP`.
  `used > weeklyCapPct * f` and `agentsOverPace` > 0: Stop demands agents only while there are fewer than
  `agentsOverPace`.
- Weekly steps (optional ladder below the cap, both 0 = off, `weeklyAgentsStepPct` <= `weeklyNoNewPct` <=
  `weeklyCapPct`; they also work when `weeklyCapPct` is 0): `used >= weeklyAgentsStepPct` and `agentsOverPace` > 0:
  the agent limit is at most `agentsOverPace`, as for the pace rule, and the prompt line says `Weekly step N%`.
  `used >= weeklyNoNewPct`: the prompt line says no new packages, only finish and merge what is in flight, and Stop
  raises no "machine underloaded" block (a lead with free capacity may end its turn). The cap, when reached, wins
  over both. The steps never act on stale data (see below) or when there is no data; the cap keeps acting on stale
  data as before. With both keys 0 the output is the same as before the keys existed.
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

## tabs-guard.cjs

**When it fires.** PreToolUse (`Bash|PowerShell`), UserPromptSubmit, Stop and SessionStart (`startup`, `resume`; not
`compact`). On by default (`tabs.enabled`), but only in a project that has `.claude/ghorc.json` (`config.found`): ghorc is installed at user
scope, so a project that never opted in is neither judged nor reported (the hook is silent there, for every rule and every session). The tab rules act for the lead only: a session with an `agent_id` or
`GHORC_ROLE=worker` is not checked against them, because `heavy-check-guard.cjs` already denies those every agent start. The one rule
that binds every session (lead, subagent, worker) is the dev-command rule below. Timeout
8 s: one list call per run (`hc ls --json` or `herdr agent list`, 3 s limit; `backend.detect` decides when both backends are present, `GHORC_HC_BIN` / `GHORC_HERDR_BIN` are honoured; a tab command of the other backend skips its list rules instead of reading a second list; with both backends the herdr probe is bounded to 2.5 s before `hc ls`).

**What PreToolUse denies.** Tab commands that break the policy. Every reason names the rule and ends with a
`Corrected form:` of the command.
- Names: a lowercase letter first, then `[a-z0-9-]`, at most 32 characters in all (herdr's agent-name rule is `[a-z][a-z0-9_-]{0,31}`; the policy is the stricter one). A lead is `capacity.leadNamePrefix` (default `lead-`) plus at least one
  character. A worker is `<pkg>-<kind>`: kind `implementer`, `reviewer`, `reviewer-critical`, `scout`, `integrator`,
  `release`, `consult`, `media`, `log-reader` (agent kinds) or `full`, `runner`, `train` (long-lived); `pkg` is
  `[a-z0-9][a-z0-9-]*`; the longest kind suffix wins (`a1-reviewer-critical` is pkg `a1`).
- `herdr tab create`: `--workspace` equal to the own workspace and `--no-focus` (see "Workspace" below); `--label` present and valid; `--env GHORC_ROLE=worker` for an agent-kind worker label, `=lead` for a lead label (a long-lived `full`, `runner`, `train` tab runs a command, not a Claude session, and needs no role);
  the label is not the name of a live agent (this session's own tab is never a duplicate or a worker: a lead named `lead-next` may start `lead-next` again, and no hint closes it; names compare case-insensitively); an agent-kind worker label is refused when `tabs.maxWorkers` agent-kind workers of
  the project are already live (tabs created earlier in the same command count).
- `herdr agent start <NAME> --kind claude ... -- <claude args>` and `hc run ... claude[.exe] <args>`: NAME valid; the claude
  args hold `--model opus|sonnet|haiku|fable` (a full or versioned id is refused: the alias follows the newest model;
  `opus[1m]` is accepted), `--effort low|medium|high|xhigh|max`, `-n <NAME>` (or `--name`) equal to the tab name, and every element
  of `worker.permissionArgs` (lead name: `handoff.candidatePermissionArgs`). `hc run` also needs `GHORC_ROLE=worker`
  (`=lead` for a lead name) in front of claude (`env GHORC_ROLE=worker claude ...`), `--name`, the duplicate-name and
  `maxWorkers` checks against `hc ls --json`, and `--outlive-parent` for kinds `full`, `runner`, `train`.
  An `hc run` of another program gets the name, duplicate, limit and `--outlive-parent` checks only.
- **Workspace (herdr).** The lead's own workspace is the prefix of `HERDR_PANE_ID` (`w4:p1` is in `w4`); `HERDR_WORKSPACE_ID` alone is taken as
  it is, and when both are set and disagree, or neither is, the workspace is unknown and only presence checks apply (the id forms
  `w1` and `w1:p1` are herdr's documented public ids; `herdr api schema` lists `workspace_id` in every agent entry). `herdr tab create` needs `--workspace` and `--no-focus`: with the own workspace known
  the value is its id or a reference, and only the exact variable names count (`$HERDR_WORKSPACE_ID`, `${HERDR_WORKSPACE_ID}`,
  `$env:HERDR_WORKSPACE_ID`, `%HERDR_WORKSPACE_ID%`, quoted or not); a single-quoted reference (the shell does not expand it) or another
  variable name is denied, known workspace or not. Without `--workspace` herdr uses the UI-focused workspace, which can belong to another
  project's lead, and without `--no-focus` it moves the owner's focus. `herdr pane split` needs `--no-focus`. Creating, closing and starting
  in another workspace is denied for the lead: `herdr tab create` with a foreign `--workspace`, `herdr tab close`, `herdr pane close`,
  `herdr pane split --pane` and `herdr agent start --pane` on an id of another workspace (the part before `:`; an unqualified id is not
  judged), and always (the owner's): `herdr workspace create|close`, `herdr worktree create|open|remove` (a worktree workspace is a
  separate workspace), `herdr pane move`, and any herdr command above aimed at another session, machine or host with
  `--session`, `--machine` or `--remote` anywhere in the herdr part of the command, before or after the verb (reading there stays
  allowed). Operator actions - `agent prompt|send-keys`, `pane run|send-keys|send-text|read`
  - are not judged: the owner may ask for them. Inventory, duplicate-name and limit checks count only agents of the own workspace
  (their `workspace_id`, else the pane id prefix; when the own workspace is known), besides the cwd filter; on hc only terminals whose parent is this terminal or whose cwd is in the project.
- **Dev commands (every session in a project with a ghorc config).** `tabs.devCommands` (regexes, default list in `scripts/lib/defaults.json`)
  matches dev servers and watchers: `npm|pnpm|yarn|bun [options] [workspace <w>] [run [options]] dev|start|serve|watch|preview` (a script name
  ends at a space, so `dev:setup` and `start-check` are one-shot), `vite` (not `vite build`), `next dev|start`, `nuxt|nuxi|astro dev`, `nodemon`,
  `webpack serve`, `webpack-dev-server`, `http-server`, `live-server`, also through `npx`, `pnpm exec|dlx`, `yarn dlx|exec`, `bunx`; `tsc|webpack|rollup|esbuild`
  with `--watch` or `-w`; `jest` only with `--watch`/`--watchAll` (its `-w` is `--maxWorkers`); `vitest watch|dev` or `--watch`; `docker compose up` /
  `docker-compose up` unless `-d`, `--detach`, `--abort-on-container-exit`, `--exit-code-from` or `--wait`; `php artisan serve`, `rails s|server`,
  `python -m http.server`, `flask run`, `uvicorn`, `gunicorn`, `manage.py runserver`, `dotnet watch`. `--version`, `-v`, `--help`, `-h` on any of them only
  print and stay allowed, like the one-shot commands (`npm run build`, `npm test`, `vite build`, `docker compose up -d`, `tsc`, `git log`,
  `grep "npm run dev"`). A matching segment is denied on backend hc or herdr (backend `none`: allowed), foreground or with
  `run_in_background`, unless it is the payload of a tab launch: `herdr pane run <pane> "<cmd>"` (quoted text is not read as a command) or
  `hc run ... <cmd>` with a `<pkg>-runner` name (in another `hc` tab name it is denied, for the lead). The lead's reason gives the runner form
  (herdr: `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus --label <pkg>-runner --cwd <dir>`, then `herdr pane run <pane_id> "<cmd>"`;
  hc: `hc run --bg --outlive-parent --name <pkg>-runner --cwd <dir> <cmd>`); a subagent's or worker's reason tells it to end its report
  `BLOCKED <name>: ...` with the exact command, and the lead starts it in a runner tab. `[]` turns the rule off; a pattern that does not compile
  is dropped (`check-config.cjs` reports it, the config stays usable). Not covered by default (extend the list): `ng serve`, `gatsby develop`,
  `hugo server`, `npm run storybook`, `node --watch`.
- `--help` / `-h` of these commands is allowed. `hc run` reads `--name` only: nothing in the repo says that its `-n` is the same option, so `hc run -n x` is denied as "--name is missing" until that is confirmed.
- A value the hook cannot read (quoted, `$variable`, `<placeholder>`) is not judged. An unreadable list skips the duplicate
  and limit rules only. Any internal error, timeout or invalid project config allows the command (the one deny of an
  invalid config stays in `heavy-check-guard.cjs`). Denials go to the denial log under `tabs-guard`.

**What it reports.** The project's worker tabs: herdr agents with a valid worker name and a cwd inside the project root (or
`.claude/worktrees`); hc terminals that are live with a valid worker name and either `parent` equal to this terminal or a cwd
inside the project (directories compare in one form: separators, case, a Windows long-path prefix, Git-Bash `/c/x`; inventory names compare case-insensitively, the policy for new starts stays lowercase). UserPromptSubmit and SessionStart add, only while there are live workers, one line
`tabs: N live (<name> <status> <minutes>m, ...)` (minutes since the hook first saw the tab) and one line per flag:
- `BLOCKED`: status `blocked`; read its screen, tell the owner, never answer a permission prompt yourself.
- `FINISHED`: a result line counts only when the report file is not older than the first sighting of the tab (a name is reused across fix rounds, so an earlier round's report is ignored). The last non-empty line of `<project root>/.claude/ghorc-out/<name>.md` is `DONE <name>`, `BLOCKED <name>: ...`,
  `HANDOFF <name>` or `VERDICT <ACCEPT|ACCEPT_WITH_NOTES|CHANGES_REQUIRED|BLOCKED>` while the tab is still open (a tab that is
  `working` counts only when the report is newer than its last status change, so the report of an earlier round is not read as a
  result). A report ending `BLOCKED <name>: ...` (or `VERDICT BLOCKED`) is shown as "BLOCKED by the worker: bring it to the owner; close the tab after the owner decides". Otherwise: accept the report and close the tab (hc: `hc kill <name>; hc rm <name>`; herdr: `herdr tab list`, then `herdr tab close <tab_id>`).
- `STALLED`: idle (`idle` or `done`) for `tabs.idleMin` minutes with no result line (a tab whose report has a result line, old or fresh, is never stalled "without" one). `OVERTIME`: running `tabs.overtimeMin`
  minutes and not finished. STALLED is judged on the fresh result line. Neither applies to `full`, `runner`, `train`.
- `OVER_LIMIT`: more than `tabs.maxWorkers` agent-kind workers are live.
- `RESULT?`: at the first sighting of a tab that is not `working` or `blocked`, its report already ends in a result line (a worker that
  finished before this lead saw it, e.g. after a lead restart): `tabs RESULT?: <name> has a result line from <HH:MM>: if it is the current
  round, accept it and close the tab`. Shown on that run only; it never blocks Stop, and the tab stays quiet (no OVERTIME) until its status changes.
- `UNKNOWN`: a status that is none of `working`, `idle`, `done`, `blocked`: `tabs UNKNOWN: <name> reports status "<x>": read its screen`, so a renamed
  status cannot hide a dialog (no Stop block).
- `BADNAME`: a live agent of this workspace (herdr) or a claude-code terminal of this terminal or project (hc) whose name breaks the policy
  (too long, uppercase, no `<pkg>-<kind>`): the guard neither counts nor watches it, so the line says so (this session's own tab is never listed).
Stop blocks once per occurrence (never with `stop_hook_active`) when a tab turns `BLOCKED` or `FINISHED` and `tabs.stopBlock` is true, with the same
lines as the reason; the state remembers which (tab, flag) already blocked, so a worker that stays blocked does not force an extra turn on every lead turn (the prompt line still shows it), and a flag that went away may block again later. Stop stays silent, and no notification is raised, once `HANDOFF.md` says `status: SENT` for this session (same helper as the context guard), and for a candidate lead before ACTIVATE: `HANDOFF.md` (at most 2 hours old) names an `old_session_id` other than this session and the `Session:` field of `STATE.md` is not this session either (the candidate changes nothing before ACTIVATE; the activated lead rewrites STATE with its own session). A held-back notification is raised by the first run that may speak. On herdr, when a worker turns `blocked` and `tabs.notify` is true, it runs
`herdr notification show "ghorc: <name> waits" --body "..." --sound request` once per transition.

**State.** `<tmp>/ghorc-<user>/tabs-<first 16 characters of the session id>.json` remembers per name `firstSeen`, `status`,
`statusSince`, `notified` and `sb` (the flags that already blocked Stop); it is what gives runtime and idle time across hook runs. A name that leaves the list is forgotten; `tabs-*.json` files of other sessions older than 7 days are removed when a state is written.

**Config** (`tabs`, [configuration.md](configuration.md)): `enabled` (true), `maxWorkers` (3, 1..20), `idleMin` (10, 1..1440),
`overtimeMin` (45, 1..1440), `stopBlock` (true), `notify` (true), `devCommands` (regex strings, see above; validated; `[]` off). The own workspace comes from the environment (`HERDR_WORKSPACE_ID`), not from the config. Test seams: `GHORC_CAPACITY_HC_JSON` and
`GHORC_CAPACITY_HERDR_JSON` (the text of the list; the PreToolUse checks read the list of the backend the command names, the
reports use `hc` when its text is set, else herdr), `GHORC_TABS_NOTIFY_LOG=<file>` (appends the argv of the notification,
program included, as one JSON line instead of running herdr), `GHORC_HC_BIN` / `GHORC_HERDR_BIN`.

**Limits.** The report is only as fresh as the last hook event: a lead that works for a long time without a prompt or a stop is
not told in between (the notification is raised at the next run too). herdr's `blocked` is read from the screen by herdr and may lag
a Claude Code update that changes its dialogs. The runtime counts from the first sighting, so a tab that was already open when the
lead started shows 0m. Identical repeated segments of one command line are read once, so a name opened twice in one command is
not caught. The `herdr tab close <tab_id>` form needs the id from `herdr tab list` (its output was not captured here).

## git-guard.cjs

**When it fires.** PreToolUse on `Bash|PowerShell`. Off by default: without `git.guard: true`
([configuration.md](configuration.md#git)) it prints nothing. When on, it judges every session alike: the lead, terminal
workers and subagents (`agent_id` and `GHORC_ROLE` are not read).

**What it denies.** Each deny names the rule and the safe form.
- `--no-verify` on `git commit`, `push`, `merge`, `rebase`, `pull` and `am` (an unambiguous abbreviation such as
  `--no-ver` counts), and `git commit -n` alone or in a bundle (`-anm`). The message of `-m`, `-F`, `-C`, `-c`, `-t`
  and `--message` is skipped, so a message that mentions `--no-verify` passes. Fix what the hook reports instead.
- Force push: `git push --force`, `-f` (also in a bundle such as `-uf`), `--force-with-lease`, `--force-if-includes`
  and a refspec that starts with `+`. Push a new commit on top instead.
- Push to a protected branch: `git.protectedBranches` (default `main`, `master`; `[]` protects none), in any
  spelling of the destination (`origin main`, `HEAD:main`, `refs/heads/main`, `HEAD:refs/heads/main`, `feat:main`,
  `:main`), compared without case; also `--all`, `--mirror` and `--branches`, which would push it too.
- Push without an explicit remote and branch: bare `git push`, `git push origin`, the refspecs `HEAD` and `@`, and a
  refspec with `$`, `*`, a backtick or braces (a variable, a glob or a substitution). `git push origin --tags` passes.
- Writing `core.hooksPath`, `alias.*`, `include.path` or `includeIf.<condition>.path` with `git config` (a value given, `set`, `unset`, `--unset`, `--add`,
  `--replace-all`, removing or renaming the `core`, `alias`, `include` or `includeIf` section) and the same keys in `git -c` (also
  `--config-env`) on any git command: a new hooks path switches the hooks off, an alias can hide `push --force` from
  this guard, and an included config file can set either.

**What passes.** Everything else: `git push origin feat/x`, `git push -u origin feat/x`, `git push origin HEAD:feat/x`,
reading config (`git config core.hooksPath`, `--get`, `--list`), `git -c user.name=x ...`, and a help request: `--help` or `-h` as the first word after the subcommand (`git push --help`, `git help push`); further on it
may be an option value (`git commit -m --help`) and does not count.

**How it reads a command.** The same segment cutter as the heavy-check guard (`scripts/lib/cmd.cjs`): segments split on
`&&`, `||`, `;`, `|`, `&`, newlines and substitutions; shell wrappers (`bash -c "..."`, `cmd /c`, `powershell -Command`,
`env`, `sudo`, `timeout`, ...) are looked into; a path or `.exe` on `git` is dropped; global options before the
subcommand (`-C dir`, `--git-dir`, `--no-pager`) are skipped; redirections (`2>&1`) are ignored. Quoted text is blank
except a quoted word of plain characters (`"main"`, `"HEAD:main"`), which is read as the word.

**Not covered.** Scripts and files that run git (`./push.sh`, `npm run release`, a Makefile), a command piped into a
shell from a file, a branch name inside a quoted variable (`"$BRANCH"` is not readable and passes), git aliases and
`core.hooksPath` set before the guard was on or outside a session, `GIT_CONFIG_*` environment variables, and other
git clients (an IDE, the GitLab or GitHub web UI, the REST API). It is a seat belt for a well-meaning session writing a
plain command; branch protection on the server is the real wall for the default branch.

**Failure behavior.** Any internal error allows the call. Every deny goes to the denial log.

## ci-retry-guard.cjs

**When it fires.** PreToolUse on `Bash|PowerShell` and on MCP tools matching
`mcp__.*(retry_pipeline|retry_job|play_job|rerun|retry).*`. Off by default: without `ciRetry.enabled: true`
([configuration.md](configuration.md#ciretry)) it prints nothing and writes nothing. It counts every session alike.

**What counts as a restart.** `glab ci|pipe|pipeline retry|run|trigger` (options such as `-R group/project` may stand
before or after `ci`), `gh run rerun`, `gh workflow run`, `glab api` / `gh api` calls to a
`.../pipelines|jobs|runs/<id>/retry|play|rerun|rerun-failed-jobs` endpoint, and every call of a matching MCP tool. A
command with `--help` or `-h` right after the verb is not counted (further on it may be an option value). Segments are cut like for the heavy-check guard (`cd app && glab ci retry 1`
counts); one command line with several restarts counts once.

**What it does.** Every allowed restart appends one line `{ts, command, session, tool}` (plus `reason: true` when a
reason file let it through) to `<project root>/.claude/ghorc-out/ci-retry-ledger.jsonl`. The project root is the main
repository root (`CLAUDE_PROJECT_DIR`, else the parent of the git common dir), so worktrees, the lead and its workers
share one ledger. With `n` = ledger lines in the last `ciRetry.windowHours` (24):
- `n < freeRetries` (1): allowed and recorded;
- `freeRetries <= n < hardCap` (3): allowed and recorded only when `<project root>/.claude/ghorc-out/ci-retry-reason.md`
  was modified within the last 30 minutes and after the last recorded restart (so each extra restart needs a new
  write); otherwise denied with the instruction to write there what failed, the error signature (the failing log line,
  quoted) and why a retry and not a fix;
- `n >= hardCap`: denied even with a reason file; the reason says to stop and report to the owner, and when the window
  frees the next restart.

**Limits.** The count is of permissions given, not of runs: a restart the owner then rejects in a permission prompt,
or one that fails to start, still counts. The ledger and the reason file are plain files: nothing protects them, so a
session can edit or delete the ledger to reset the count; the guard is a speed bump against blind retries, not an
access control. Scripts that restart CI, the web UI and other tools are not seen. `.claude/ghorc-out/` is in the git
exclude that `/ghorc:setup` (item `exclude`) writes.

**Failure behavior.** Any internal error allows the call; a ledger that cannot be read counts as empty, a line that
cannot be parsed is skipped, and a restart that cannot be recorded is still allowed. Every deny goes to the denial log.

## ledger.cjs

**When it fires.** PostToolUse on `Agent` (`ledger.cjs hook`), SubagentStop (`ledger.cjs stop`) and SessionEnd
(`ledger.cjs end`, timeout 30 s); `session-start.cjs` writes the session line. It never denies
and prints nothing; any error exits 0. It writes only inside an existing project directory.

**What it does.** Appends one line per subagent call to `<project>/.claude/ghorc-out/ledger.jsonl` (role, requested
and resolved model, requested effort, tokens, duration, tool count; never the prompt or the response). A background call
gets a `launch` line at once and a `done` line (transcript totals) from SubagentStop. The `done` line also carries an estimated USD `cost` at list prices (`scripts/lib/prices.cjs`, as of 2026-11-24), `unpriced`, `models` and `cacheTtlAssumed`; `report` prints it per role and as an `estimated cost` line. `ledger.cjs
verdict` and `ledger.cjs report` are the lead's commands, see `/ghorc:status` and [evidence.md](evidence.md#call-ledger).

**Main sessions.** SessionStart appends a `session` line for every main session in an opted-in project (the lead, a tab
worker, a candidate lead): the session id, `GHORC_ROLE`, the hook's `source` and the transcript path Claude Code gave
(never derived: `~/.claude/projects` may be a link). SessionEnd appends a `sessionEnd` totals snapshot of a transcript
up to 300 MB, so the report keeps the session after Claude Code deletes old transcripts.

## session-start.cjs

**When it fires.** SessionStart. It never denies anything.

**What it prints**, in this order: pending watchdog alerts (count and the last 2 lines),
`ghorc <version> session=<id> role=<role>`, the config status, `lead: load skill ghorc:lead` for the lead, a missing
`CLAUDE.md` section and a `run /ghorc:setup` hint when a setup item is missing. `role` is `GHORC_ROLE` if set, else
`lead` for a main session and `agent` for a subagent. Output is at most 299 characters and is built from whole
lines, never cut inside a line: when it does not fit, whole lines are dropped from the lowest priority up (alert lines,
the `CLAUDE.md` hint, the setup hint, the config warning, ...) and the output ends with `+more: run ctx`; the identity
line, `lead: load skill ghorc:lead` and `config invalid` are never dropped. A captured run in a plain session of `examples/demo`:

```
ghorc 0.5.0 session=a1b2c3d4-0000-4000-8000-000000000001 role=lead
config: ok
lead: load skill ghorc:lead
run /ghorc:setup
```

**What else it does.** It removes ctx files older than 7 days (and every legacy `<project>/.claude/ctx-*.json` of 0.10, whatever
its age), session state and alert offsets older than 7 days, and trims the
denial log to 7 days. When `watchdog.autostart` is true (default false) and the session is a main session with
`GHORC_ROLE` empty or `lead`, it starts or restarts the project's watchdog. It does not start one for a drive root,
`/`, the home directory or a missing transcript directory (it prints `watchdog: not started (<reason>)`).

**How to disable.** `lead.remind: false` drops the reminder for a plain main session; `GHORC_NO_AUTOSTART=1` never
starts the watchdog.

## Denial log

Every deny of the read, heavy-check, tabs, git and CI retry guards appends `<iso time> <session8> <hook> <reason>` to
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
`<os tmp>/ghorc-<user>/ctx/<root hash>/ctx-<session_id>.json`, outside the project (the hash is the one of the project root, see the root rule), which `ctx.cjs` reads.

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

- `statusline.cjs` (stdin): the status line; writes `<os tmp>/ghorc-<user>/ctx/<root hash>/ctx-<session_id>.json` (only in a project with `.claude/ghorc.json`).
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
