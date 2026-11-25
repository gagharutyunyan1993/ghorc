# Security

ghorc installs Claude Code hooks, so here is exactly what they do and do not do. Everything below is visible in
`hooks/hooks.json` and `scripts/`.

## What the hooks can do

- `read-guard.cjs` (PreToolUse on `Read` and screenshot/snapshot MCP tools, PostToolUse on `Edit|Write|NotebookEdit`):
  denies a tool call when a read budget is exceeded (repeated reads, PDF pages, image bytes, screenshots).
- `heavy-check-guard.cjs` (PreToolUse on `Bash|PowerShell`): denies commands that match `heavyCommands` patterns, and
  a few built-in ones for subagents (`claude -p`, `herdr agent start|prompt|send-keys`,
  `herdr pane run|send-keys|send-text`, `hc run|exec|keys|interrupt`, `hc send` except to the own parent).
- `session-start.cjs` (SessionStart): prints a short reminder and may start the transcript watchdog in the background.
- `tabs-guard.cjs` (PreToolUse on `Bash|PowerShell`, UserPromptSubmit, Stop, SessionStart; lead only): denies a tab or
  worker start that breaks the naming, model, effort, permission or limit rules, lists the lead's worker tabs, blocks
  Stop while one waits on a dialog or is finished but open, and may show a herdr notification. It runs `herdr agent
  list` / `hc ls --json` (and `herdr notification show`) to do that.
- Deny decisions are rule-based and carry a reason; the hooks never rewrite a command or a file.

## Permission mode of the sessions ghorc starts

Workers and candidate leads start with default permissions (`worker.permissionArgs` and
`handoff.candidatePermissionArgs` are `[]`) until the owner chooses otherwise: `/ghorc:setup` asks, and
`setup.cjs --apply permissions --mode <bypass|acceptEdits|prompts>` writes the answer into `.claude/ghorc.json`. Neither
`--apply all` nor any other item picks a mode. With `bypass` a worker can edit and run anything in its worktree without
asking. What still holds then: ghorc's PreToolUse hooks deny as usual (verified with a worker's heavy check under
bypass), your deny rules apply, critical-path removals and `AskUserQuestion` still stop the session, and an
organization's `disableBypassPermissionsMode` setting turns the mode off.

## What the hooks cannot do

- They make no network calls: the scripts use no HTTP, socket or fetch API.
- They do not send file contents, prompts or transcripts anywhere. The only child processes are `git` (project root
  lookup, status line), the watchdog itself, and the command you configure yourself as the watchdog `--notify` action.
- They read your project's `.claude/ghorc.json` and the Claude Code transcript directory (watchdog, size only); they
  do not read other projects.

## Failure behavior

On an internal error (bad stdin, unreadable state, exception) the guard hooks fail open: the tool call proceeds. The
one exception is an invalid `.claude/ghorc.json` (bad JSON, wrong type, broken regex): then the heavy-command guard
denies heavy commands with the reason until the file is fixed.

## Where state lives

Per-session read counters, watchdog pid, state and log files, and the config validation cache live in
`<os tmp dir>/ghorc-<user>` (`GHORC_TMP` replaces that path). The status line writes
`<os tmp>/ghorc-<user>/ctx/<root hash>/ctx-<session_id>.json` there too, never into the project.
`GHORC_HOOK_DUMP=<file>`, if you set it, appends raw hook input to that file; it is off by default, so remove the dump
when you share it, because it contains tool arguments.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on the
repository (Security tab, "Report a vulnerability"). Include the ghorc version, the hook involved and a minimal
reproduction. I aim to reply within a week.
