# Hooks, status line, watchdog and scripts

ghorc registers three hook scripts in `hooks/hooks.json`. They are plain Node.js, make no network calls and never
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

- Always, for subagents and workers: `claude -p`, `herdr agent start`, `herdr agent prompt` are denied.
- A command matching `heavyCommands` is denied when a subagent or a `GHORC_ROLE=worker` session runs it. The lead
  runs it freely, unless `heavyGuard.requireLeadEnv` is true and the session lacks `GHORC_ROLE=lead`.
- If `.claude/ghorc.json` is invalid (JSON error, wrong type, bad regex), it denies every heavy command for everyone,
  the lead too, using the valid configured patterns plus a built-in default list, and says why.
- With no project config, or an empty `heavyCommands` (the default), it denies nothing except the agent starts above.

**What it prints**, for example:

```
only the lead runs heavy checks.
only the lead runs heavy checks (GHORC_ROLE=lead is not set).
subagents and workers may not start other agents (claude -p, herdr agent start/prompt): ask the lead.
config invalid: <reason>. Heavy-command rules cannot be trusted: fix .claude/ghorc.json (node scripts/check-config.cjs).
```

**How to disable.** Leave `heavyCommands` empty, or remove the pattern. Fix an invalid config with `check-config.cjs`;
the fix is seen at once.

### heavyCommands semantics

Each string is a JavaScript regex compiled with flag `i` (case-insensitive). A command is cut into segments at `&&`,
`||`, `;`, `|`, `&`, newlines, `( ) { }`, `$(` and backticks; quoted text is blanked first, except the quoted argument
of a shell wrapper (`bash -c "..."`, `cmd /c "..."`, `powershell -Command "..."`) and `$(...)` or backticks inside
double quotes. The regex must match at the START of a segment, after optional env assignments (`FOO=1 `) and wrappers
(`cmd /c`, `bash -c`, `powershell -Command`, `call`, `time`). npm global options (`--prefix app`, `-C app`, `-w x`,
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

It prints `config: <path>`, any `ERROR:` lines (invalid JSON, unknown key, wrong type, bad regex) and, per sample,
`HEAVY (<pattern>)` or `ordinary`. On a config error SessionStart prints one `config invalid:` line and the heavy guard
denies as above; an unknown key alone prints `config warning:` and denies nothing. Validation results are cached by
file mtime and size in `<tmp>/ghorc-<user>/config-valid.json`.

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
