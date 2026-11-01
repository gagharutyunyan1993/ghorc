# Changelog

## Unreleased

### Added
- Sticky handoff, opt-in with `handoff.stickyOnCompact` (default false; off or absent, the compaction paths behave as
  in 0.7.0: no output and no flag on a compaction, Stop blocks at most 2 times and lets go once STATE is newer). On: a
  compaction (`SessionStart`, source `compact`, new matcher entry in `hooks/hooks.json`) writes the same per-session
  flag as crossing `ctxHandoff` (`handoff-<session_id>.json`, now with `compacted`). The flag is cleared only when
  HANDOFF.md has `status: SENT` and `old_session_id` equal to this session; a token number never clears it, and a
  SENT session is not flagged again by a high number. A flag caused by a compaction denies edits and agents and
  blocks Stop only for a session with `GHORC_ROLE=lead`; any other session gets a reminder only, so enable the key
  only when leads run with `GHORC_ROLE=lead`. The flag from crossing `ctxHandoff` keeps its 0.7.0 reach.
- `scripts/unpushed.cjs [--branches a,b]`: local branches ahead of or missing on `origin/<branch>` (local refs, no
  network), exit 1 when any. `handoff.pushGuard` (default false): in handoff mode the lead's `herdr agent start` is
  denied while a branch named in STATE `in_flight` (`branch: <name>`) is unpushed; no such field, no `origin` remote or
  a fetch refspec that does not cover the branch: nothing is checked (a reminder when `in_flight` names no branch).
  Skill `ghorc:handoff` gets a push-and-check step before the candidate launch.
- `ctx.cjs` prints one extra line after a compaction of the session (with `handoff.stickyOnCompact`): the number is
  unreliable and, for a lead, the handoff is due.
  The numbers themselves are unchanged.
- Capacity guard (`scripts/capacity-guard.cjs`; Stop, UserPromptSubmit, SubagentStart, SubagentStop), off by default
  (`capacity.enabled`). Stop returns the lead's turn once when agents < `capacity.agents`, CPU < `cpuStartPct` and free
  RAM >= `minFreeRamGb`, unless the last answer has a line starting with `idleMarker` (default `Idle:`) and a real
  reason. Agents: `background_tasks` of the Stop input, else the SubagentStart/Stop ledger, plus herdr workers of
  `herdr agent list` (a herdr failure keeps the hook silent). UserPromptSubmit adds `agents N/M, CPU X%, free Y GB`.
  `weeklyCapPct` and `agentsOverPace` add a weekly brake from `rate_limits.seven_day` of the status line ctx files.
  Errors go to `.claude/ghorc-out/capacity-guard.log`.


### Changed
- Context guard with `handoff.stickyOnCompact` on: Stop blocks the lead once per turn until SENT (was: at most 2 times,
  released by a newer STATE); never when `stop_hook_active`; a repeat block within 60 s for the session passes; the
  reason has no token numbers and names the literal `status: SENT` and `old_session_id: <id>` lines. After a
  compaction no message quotes token numbers. A non-lead session (`GHORC_ROLE=worker`, or no role after a compaction)
  gets a reminder only. The reminder also goes to the model through the `additionalContext` of `UserPromptSubmit`.
- `HANDOFF.md` `status: SENT` is recognised with markdown noise (`**status:** SENT`, a backticked or comma-ended id).
- `in_flight` branch parsing: only a field that starts an item counts (`base branch: main` does not); main/master
  and the `origin/HEAD` branch are never required; a `###` sub-heading no longer ends the section; quoted and bold
  names are read.
- Worker role: `GHORC_ROLE=worker herdr agent start` never reached the session (`herdr agent start` types the command
  into an existing pane's shell). Checked live: the role must be set with `herdr tab create --env GHORC_ROLE=worker`.
  Skills and docs corrected (`herdr agent start` also needs `--pane <pane_id>`).
- Skill `ghorc:handoff` fallback without herdr: write `status: SENT` with `old_session_id` so the Stop block lifts.
- Review limit: at most 2 fix rounds (`review.maxFixRounds`, default 2), then a cheap closure check instead of a full
  re-review; P0/P1 open after round 2 means blocked. Replaces "3 rounds" in the lead skill, workflow, templates.
- The documented subagent ban list is now `herdr agent start|prompt|send-keys` and `herdr pane run|send-keys|send-text`.
- `setup --check` prints an information line for `handoff.candidatePermissionArgs`; `setup --apply` never writes it.

### Fixed
- `GHORC_ROLE` is read by one helper that trims and lowercases it (`worker `, `Worker` and `WORKER` are the worker
  role for the context guard, the heavy check guard, the read guard and the SessionStart line).
- A worker session without a flag returns from the context guard before the config is loaded.
- `unpushed.cjs` spawns git through the shared helper (timeout and budget).
- `ghorc:handoff`: the candidate accepts exactly the READY `seq` + 1 together with `status: SENT`.
- A ctx file that exists but is not valid JSON is reported as "found, bad JSON", not "no ctx file".
- With `handoff.stickyOnCompact` on, the sticky Stop block reaches only a session with `GHORC_ROLE=lead`; a roleless
  session with a flag from crossing `ctxHandoff` takes the 0.7.0 Stop (at most 2 blocks, released by a newer STATE).
- With the key off, a compaction-only flag left by a run with the key on counts as no flag.
- With the key on, the compaction reminder of a roleless session is added to the stage lines and watchdog alerts.
- `in_flight` parsing: a qualifier (`base`, `target`, `main`, ...) counts only when whitespace alone separates it from
  `branch`; every `branch:` field on a line is read (`branch: a, branch: b`).
- The status line prints the role through the shared role helper. SessionStart says so when the key is on and
  `GHORC_ROLE` is unset (no enforcement until `GHORC_ROLE=lead`). Skill `ghorc:handoff` corrected (Stop rule, exit 2
  and "cannot tell" of `unpushed.cjs`, the lead role of the candidate).
- Capacity guard review round 1: Stop is silent when `last_assistant_message` is not a string, when the handoff is SENT
  for the session and while the handoff flag is set; the ledger is cleared only when no `workflow`, cloud session or
  other agent-bearing task is in flight; a stopped herdr server (`server_not_running`) counts as 0 workers; ledger
  compaction keeps late events and removes its temp file on failure (`cleanup` covers it); `**Idle**: reason` counts.
- Capacity guard review round 2: `server_not_running` is read from stderr as well as stdout (herdr 0.9.5 prints it on
  stderr; stderr is piped, never shown); with a running workflow or cloud session the agent count is the larger of the
  listed subagents and the ledger; the idle-line regex no longer backtracks quadratically (100 KB of blank lines took
  16 s); the docs state that phantom agents are possible under heavy concurrency and expire in 3 hours.
- `statusline.cjs` removes its `ctx-<id>.json.<pid>.tmp` file when the rename fails (busy target on Windows) instead of
  leaving it behind. `/ghorc:setup` exclude item and `.gitignore` also cover `.claude/ctx-*.tmp`; a project excluded
  with the old two lines gets the new line proposed. `cleanup` already removes old leftovers.

### Changes that apply with the key off
Two changes of this branch are not gated by `handoff.stickyOnCompact`:
- `status: SENT` of the HANDOFF header is read through markdown noise (`**status:** SENT`, a comma-ended id), so a Stop
  that 0.7.0 blocked can now be silent, and only the first `status:` of the header counts.
- A ctx file that is not valid JSON is reported as "found, bad JSON" (was "no ctx file").


## 0.7.0 - 2026-11-02

### Added
- Context guard (`scripts/context-guard.cjs`, hooks UserPromptSubmit, PreToolUse on every tool, Stop) for the lead: the
  thresholds `ctxPrepare` / `ctxWarn` / `ctxHandoff` are now enforced, not only written in the skills. From `ctxHandoff`
  (handoff mode, kept by a sticky flag file that compaction does not clear) a new Agent and Edit/Write outside
  `handoff.statePath` / `handoff.handoffPath` are denied; Stop blocks (at most 2 times, never when `stop_hook_active`)
  until STATE is updated. Transcript size and unread watchdog alerts are shown as lines. No ctx file, or one older than
  10 minutes, without a flag: warn only.
- `thresholds.ctxWarn` (0 = `ctxHandoff` - 10000).

### Changed
- `setup`: the recommended autocompact percentage is `ctxHandoff` + 20K as a share of the window, rounded up (17 for a
  1M window, was a fixed 18); a value that compacts at or below `ctxHandoff` is reported as wrong, so a compaction
  cannot reset the counter before the guard reacts.
- skill `ghorc:handoff`: ACTIVATE and any prompt to the candidate or a worker go through `herdr pane run <pane_id> "<text>"`,
  sent by the old lead itself (never the owner); delivery is checked by status `working` or "running UserPromptSubmit
  hooks", not by the input field (`herdr agent prompt`/`send-keys enter` could leave a grey suggestion unsent). Closing the
  old tab is a mandatory verified step 6 (`herdr agent wait` idle, `MSYS_NO_PATHCONV=1 herdr pane run <pane> "/exit"`, the
  pane is gone from `herdr pane list`). The Stop context guard stays silent once HANDOFF says `status: SENT` for the
  session, so the old lead can go idle.
- `heavy-check-guard`: the built-in subagent/worker deny now also covers `herdr pane run|send-keys|send-text` and
  `herdr agent send-keys` (the prompt channels of the lead), also behind an env prefix, `env`, `bash -c` or a binary path;
  the lead is not affected. `cleanup` removes `handoff-*.json` flags older than `maxAgeDays`. Context lines round the
  token count down (149999 reads 149K). Only the first `status:` of HANDOFF counts for a SENT header.

## 0.6.1 - 2026-10-16

- 0.6.1: `templates/CLAUDE-section.md`: a "Project roles" paragraph (project roles in `.claude/agents/` take precedence) and a
  critical reviewer line that allows the project's own role.
- `setup`: detects `.claude/agents/*.md`, reports them on the `claudemd` item and appends a ready-to-fill project roles
  table on apply; no change for projects without `.claude/agents/`.
- skill `ghorc:lead`: rule 8 (launch project roles instead of `ghorc:*`), rule 18 (sharper herdr worker criterion).

## 0.6.0 - 2026-10-16

### Added
- ledger: a PostToolUse hook on `Agent` appends one line per subagent call to `.claude/ghorc-out/ledger.jsonl`
  (`scripts/ledger.cjs hook`); `ledger.cjs verdict` records the lead's review verdicts with a cause code;
  `ledger.cjs report` and `/ghorc:status` show per-role tokens, duration and tools, and the first-round accept rate
  (overall and per class). Background calls are recorded in two stages: a `launch` line, then a `done` line with
  transcript totals from a SubagentStop hook (`ledger.cjs stop`).
- effort table with move-up conditions, cause-first escalation, per-model role lines, methodology lines (lead, brief,
  roles, docs).

### Fixed
- `setup --check` treats a missing top-level `effortLevel` as ok; `--apply effort` writes only
  `modelSettings.<full lead model id>.effortLevel` (opus -> claude-opus-5-5), never a top-level key.

## 0.5.1
Robustness fixes; no contract or config key changes.

### Fixed
- R9 The heavy guard reads the PowerShell tool and `powershell`/`pwsh -Command` with PowerShell quoting (a backslash is
  plain text), so `cd "D:\a\"; npm test` no longer hides `npm test`.
- R10 Bash heredoc bodies are not matched as commands (a subagent may write a doc that mentions `npm test`); an
  unterminated heredoc hides nothing.
- R12 All git calls share one helper with a 1 s call timeout, a 2.5 s budget and a stop after the first timeout; a
  hanging git no longer stretches SessionStart.
- R13 `setup --project` no longer fails on a broken global `settings.json`: it prints a WARN line and applies the
  project items.
- R14 The config validity cache key includes the defaults template (mtime and size), so a template change drops a
  stale verdict.
- R15 `setup --check` proposes every test/e2e/full/build/lint/typecheck script not already covered by `checks.fast`
  (the demo now gets `npm run test:full`).

### Added
- #17 `setup --apply statusLine` saves the status line it replaces in `~/.claude/ghorc-statusline-backup.json`;
  `setup --restore statusline` puts it back; `setup --check` prints `statusline: ghorc (previous saved)` or `other`.

## 0.5.0
Entries are grouped by change number. **Breaking: the marketplace name, the lead skill name and the watchdog default.**
- #1 Marketplace renamed `ghorc-local` -> `ghorc`. Users of 0.4.x: run `claude plugin marketplace remove ghorc-local`,
  then `claude plugin marketplace add gagharutyunyan1993/ghorc` and `claude plugin install ghorc@ghorc`.
- #18 `plugin.json` has `license`, `repository`, `homepage`; the CI matrix adds Node 20; CI runs `npm test`, which
  runs only `tests/*.test.cjs` (`scripts/test.cjs`), so `examples/` never joins the plugin test run.
- #2 **Breaking:** the transcript watchdog is opt-in (`watchdog.autostart` defaults to false). `/ghorc:setup` lists
  `watchdog` (`--apply watchdog` sets it true in the project config; `--check` shows on/off). New
  `scripts/watchdog.cjs --stop` kills the project's watchdog and removes its pid and heartbeat files.
- #3 `GHORC_ROLE` is optional: SessionStart prints `role=lead` for a plain main session instead of
  `role=unknown (set GHORC_ROLE)`. `worker` stays explicit.
- #4 **Breaking:** `readGuard.leadNoMedia` applies only when `GHORC_ROLE=lead` is set; a plain main session reads images
  and PDFs (a PDF still needs `pages`).
- #5 `setup --check` proposes `heavyCommands` from the `package.json` scripts (root and `app/`: test, e2e, build,
  lint names; never a pattern that matches `checks.fast`); `setup --apply heavy` prints and writes them. Not part
  of `--apply all`.
- #6 Skill `ghorc:orc` is now `ghorc:lead`; `ghorc:orc` stays one release as a short alias that points to it.
- #7 New skill `ghorc:status`: role, guards, heavy patterns, watchdog, context numbers and the last denials in one block
  (`setup.cjs --check --status` plus `ctx.cjs --session <id>`).
- #8 Denial log: every deny of the read guard and the heavy-check guard appends `<iso time> <session8> <hook> <reason>`
  to `<tmp>/ghorc-<user>/denials.log`; cleanup keeps 7 days.
- #9 `templates/ghorc.json` is short (checks, heavyCommands, thresholds, watchdog.autostart, readGuard.maxRepeat,
  lead.model); every other key keeps its default from `scripts/lib/defaults.json`. All keys are in
  `docs/configuration.md`. The validator still accepts every key. Agent descriptions are one line and start with the
  role name. The CLAUDE.md section template is wrapped to 120 columns.
- #11 `ghorc:handoff` description says it works without herdr.

## 0.4.0
Entries are grouped by the id of the attack digest finding.
- Fix: `setup.cjs` and `check-config.cjs` resolve the project root from cwd (git toplevel, `--cwd` overrides), not
  `CLAUDE_PROJECT_DIR`; `--apply claudemd` no longer writes into another tree. Hooks keep the old rule.
- SessionStart derives the transcript dir from either slash style (fallback: encoded cwd under ~/.claude/projects) and does not
  start the watchdog for a drive root, "/", the home dir or a missing dir (prints "watchdog: not started (reason)"); the
  watchdog itself exits 2 on such a --transcript-dir. `GHORC_WATCHDOG_DRY=1` prints the spawn argv to stderr.
- Watchdog exits (and removes its pid and heartbeat files) when its project root no longer exists. Tests stop every watchdog
  they spawn (`taskkill /T /F` on Windows) and run session-start with `GHORC_NO_AUTOSTART=1` (also honored by session-start).
- A1, A2, A3: read-guard counts reads per agent and per resolved path (lower-cased on Windows); offset, limit and pages no
  longer make a new key, so round-robin reading is caught. PostToolUse resets only the edited path (Edit, Write,
  NotebookEdit); the Bash/PowerShell reset is gone.
- A8, A24: PDF and image reads are for media roles only (`readGuard.mediaRoles`, default `ghorc:media`, `media`); a
  stat error on an image still counts as a read.
- A5, A9, A13: budgets per agent: `pdfPageBudget` (60), `mediaByteBudget` (8 MiB), `maxScreenshots` (60, MCP
  screenshot/snapshot/read_page tools; the Read matcher in hooks.json now includes them).
- I4: invalid project config (JSON, type, regex) makes the heavy guard deny heavy commands for everyone, lead included,
  with the reason; validity is cached by mtime and size; read-guard keeps working with defaults.
- A10, A16: per-user tmp dir `<tmp>/ghorc-<user>`; atomic writes for state, pid, ctx and offset files.
- G1: `GHORC_ROLE=worker` counts as a subagent for the heavy guard; built-in subagent denies: `claude -p`,
  `herdr agent start`, `herdr agent prompt`.
- I5: heavy command matching per segment (`&&`, `||`, `;`, `|`, newline), anchored at the segment start, quotes
  ignored, `npm run`/`npx` prefix tolerated. **Patterns written for the old "match anywhere" rule may need a leading
  `^`.**
- A11: config lookup tries `CLAUDE_PROJECT_DIR` and cwd ancestors first and spawns git only on a miss.
- A18, A19, A21: `GHORC_HOOK_DUMP=<file>` records raw hook input; hook-io and root helpers hardened.
- A23: `setup --check` has a warning-only `heavy` item (empty `heavyCommands`, or no match for `checks.full`).
- E1: setup `pct` is labelled GLOBAL; `--project` writes `<project>/.claude/settings.local.json` instead.
- E2: setup exclude path comes from `git rev-parse --git-path info/exclude` (worktrees); adds `.claude/ghorc-out/`.
- E3, E4: `ctx.cjs` needs `--session <id>` (full or 8-char prefix, or `GHORC_SESSION`) or `--all`; alerts are per
  session, up to 10, oldest first, only shown ones marked read.
- E6: status line shows `#<8 chars of session id>`; the 7d reset is shown as `~Nd` from 48 h.
- E8, F1, F2: SessionStart prints `session=<id>` and `role=unknown (set GHORC_ROLE)`, alerts first, cut at 299
  characters with `+more: run ctx`; removes ctx files and tmp state older than 7 days.
- F3, F4, F6, F7, F8, F9: watchdog is one per project root and scans only that project's transcript directory
  (`--transcript-dir`, `--project-root`); JSON pid file with version, heartbeat file, SessionStart restarts a dead,
  stale or old-version watchdog; stop alarm on first sight; growth streak decays instead of resetting; `--notify` is
  an argv array without a shell (`cmd /c script.cmd` for scripts); per-session, per-project alert offsets.
- E1, G2, I3: docs (README: hooks, scripts, config, troubleshooting, development) follow the code above.
- B1, B2a: handoff has an explicit step: after READY the old lead sends `ACTIVATE <handoff_id>` as its last action; the
  candidate refuses a different id.
- B3, B4, B5: STATE.md has mandatory `in_flight`, `unanswered_owner_messages`, `head` and `seq`; the candidate
  re-reads STATE at activation and refuses if `head` moved without a note.
- B8: READY deadline polled every 60 s up to `handoff.readyTimeoutMin` (default 10, in the template and the
  validator), then report and keep leading.
- C1: reviewers may mark findings `UNREPRODUCED` (file:line, reasoning); they count at P0/P1 only with a stated reason.
- C2, C11, E3: orc rule for a model override when implementer and reviewer models are equal; the final full runs on the
  merge SHA and the report quotes it; rule 11 reads the session id from SessionStart or the `#id` segment.
- C8: media role gets Grep and greps the pdftotext output before reading it.
- D4: `.claude/ghorc-out/` is the artifact dir in the brief skill and every role prompt.
- H1: consult role secrets rule with a pre-send grep of the question file.
- Review fixes: SessionStart kills no stale watchdog pid (it may be a foreign process); a watchdog exits when the
  pid file names another pid. Heavy matching also sees through shell wrappers (`bash -c`, `cmd /c`,
  `powershell -Command`), `$(...)`, backticks, `&`, parentheses, braces and npm global options; `claude --print` is
  an agent start; the lead may start agents with an invalid config. read-guard starts a new count for a file whose
  mtime or size changed; heap snapshots are not screenshots. `handoff.readyTimeoutMin` is in the template.
- Skill, template and README sentences made current: `ctx.cjs --session`, global `pct` and `--project`, `heavy` item,
  heavy guard for workers, subagent denies.

## 0.3.1
- Follow-up: statusline git timeout overridable (`GHORC_GIT_TIMEOUT_MS`, tests deterministic); reset shown as `~Nh` or `~Nm`; verified live rate_limits/effort shape documented; test uses plain `node --test`.
- Root: one rule in `scripts/lib/root.cjs` (`CLAUDE_PROJECT_DIR`, else git common root, else cwd) used by config, setup, statusline and ctx; setup now finds and writes the config at the main root from a worktree.
- setup: new check item `statusLineStale` (statusLine points to an older plugin cache version than the running one).
- read-guard: `leadNoMedia` no longer treats `GHORC_ROLE=worker` sessions as the lead.
- read-guard: PDF/image extension checks are case-insensitive on every OS.
- watchdog: size alerts persist in `<tmp>/ghorc/watchdog-state.json`; a restart does not repeat them, re-alert after growth of `warnMiB`/2 or a level rise.
- statusline writer and `ctx.cjs` reader now agree on the root (the writer ignored `CLAUDE_PROJECT_DIR` before).
- Docs: heavy-check-guard header says `Bash|PowerShell`; statusline `--help` shows the real separator.

## 0.3.0
- All user-facing text, comments and tests translated to English; skill triggers are English only.
- session-start autostarts the transcript watchdog for lead sessions (config `watchdog.*`, pid lock, `--notify-file`, alerts shown by `ctx.cjs`).
- New skill `/ghorc:setup` and `scripts/setup.cjs` (check and apply the recommended setup).
- session-start reminds about a missing `<!-- ghorc -->` section in CLAUDE.md; README gains "Daily use" and "With and without herdr"; `/ghorc:handoff` prints a fallback without herdr.
- statusline saves a raw stdin sample once to `<tmp>/ghorc/statusline-sample.json`.
- Names are namespaced everywhere: `/ghorc:*`, `ghorc:<role>`.

## 0.2.0
- statusline: subscription-oriented line (model, effort, ctx with autocompact marker, 5h/7d rate limits, role, git branch, session), colors, no cost; opt-in raw dump via GHORC_STATUSLINE_DUMP; ctx file gains effort and rate_limits keys (additive).

## 0.1.2
- review rounds 1-2 fixes.
