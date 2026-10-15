# Changelog

## 0.4.0
Entries are grouped by the id of the attack digest finding.
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
