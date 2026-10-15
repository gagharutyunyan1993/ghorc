# ghorc

A Claude Code plugin for an orchestrating lead that delegates work to subagents and herdr sessions. It provides 8 roles, 4 skills (`/ghorc:orc`, `/ghorc:brief`, `/ghorc:handoff`, `/ghorc:setup`), hooks (protection against repeated reads and heavy checks for agents), scripts (a status line with context usage, `ctx`, a transcript watchdog, `setup`) and templates. Everything that depends on the project lives in a single file, `<project>/.claude/ghorc.json`. The scripts are plain Node (CommonJS, no dependencies) and work on Windows and Linux.

## Contents
- `agents/`: `ghorc:implementer`, `ghorc:reviewer`, `ghorc:reviewer-critical`, `ghorc:integrator`, `ghorc:release`, `ghorc:scout`, `ghorc:consult`, `ghorc:media` (names in a session: `ghorc:<role>`).
- `skills/`: `/ghorc:orc` (lead rules), `/ghorc:brief` (brief templates), `/ghorc:handoff` (shift handoff), `/ghorc:setup` (check and apply the recommended setup). Plugin skills and agents are namespaced by Claude Code (`/ghorc:*`, `ghorc:<role>`), so ghorc names cannot collide with skills or agents of your project.
- `hooks/hooks.json`: `read-guard` (Read), `heavy-check-guard` (Bash), `session-start`.
- `scripts/`: `statusline.cjs`, `ctx.cjs`, `watchdog.cjs`, `setup.cjs`, hooks, `lib/`.
- `templates/`: `ghorc.json`, `CLAUDE-section.md`, `STATE.md`, `HANDOFF.md`.

## Installation
```
claude plugin marketplace add D:\Projects\ghorc --scope project
claude plugin install ghorc@ghorc-local --scope project
```
`--scope project` writes the enablement into the project `.claude/settings.json`; the default scope is `user` (all projects). To debug without installing: `claude --plugin-dir D:\Projects\ghorc` (loaded in place; edits are picked up on a new start or `/reload-plugins`). The path `D:\Projects\ghorc` is tied to the machine: another clone of the project will not find the marketplace without an `extraKnownMarketplaces` entry in `.claude/settings.json` (or its own installation). The same absolute path is used in `statusLine`. Validation: `claude plugin validate D:\Projects\ghorc`.

Then, in a project, the quickest route is the setup skill: run `/ghorc:setup` (or `node scripts/setup.cjs --check`). By hand:
1. Copy `templates/ghorc.json` to `<project>/.claude/ghorc.json` and fill it in.
2. Paste `templates/CLAUDE-section.md` into the project `CLAUDE.md` and fill in the commands (the first line is the marker `<!-- ghorc -->`; SessionStart reminds you while it is missing).
3. Put `templates/STATE.md` where the project keeps its state (the path is `handoff.statePath`).

## Daily use
- **Start a lead session:** `GHORC_ROLE=lead claude --model opus --effort medium` (use `lead.model` / `lead.effort` from the config; PowerShell: `$env:GHORC_ROLE='lead'; claude ...`). On start the lead sees a short reminder, the watchdog is started if none is running, and any problems (missing config, missing CLAUDE.md section, pending alerts, `/ghorc:setup`) are listed.
- `/ghorc:orc` loads the lead rules (routing by model and effort, limits). Example: `/ghorc:orc` at the start of a session, then delegate a fix to `ghorc:implementer`.
- `/ghorc:brief` shows the brief structure and templates. Example: `/ghorc:brief` before asking `ghorc:reviewer-critical` to review `abc123..def456`.
- `/ghorc:handoff` hands the shift over to a fresh lead in a new herdr tab. Example: `/ghorc:handoff` when context reaches 150K.
- **Read context and alerts:** `node "<plugin>/scripts/ctx.cjs"` lists `.claude/ctx-*.json` (newest first, marked `*`) and then the last 5 unread watchdog alerts; reading marks them read. The status line shows the same context live.
- **Update the user-scope copy after changing the plugin:** the installed plugin is a copy, so run `claude plugin update ghorc@ghorc-local` (from `claude plugin --help`: `update [options] <plugin>  Update a plugin to the latest version`; restart the session to apply). Bump the version in `.claude-plugin/plugin.json` first, otherwise no update is seen.
- **Check the setup any time:** `/ghorc:setup`, or `node scripts/setup.cjs --check`.

## With and without herdr
Everything works in plain Claude Code through the Agent tool: roles, hooks, status line, watchdog, `/ghorc:setup`, `/ghorc:orc`, `/ghorc:brief`. herdr is needed only for `/ghorc:handoff` (it opens the successor session in a new tab) and for per-package effort on separate worker sessions. Without herdr, `/ghorc:handoff` detects `HERDR_ENV` is not `1` and prints the fallback instead of failing: write STATE.md, you run `/clear`, then say "read STATE.md and continue".

## Setup skill
`/ghorc:setup` runs `scripts/setup.cjs --check` and shows a table (current value, recommended value, why). It applies only what you confirm: `node scripts/setup.cjs --apply all` or `--apply statusLine,pct,idle,model,effort,config,claudemd,exclude`. Items:
- `~/.claude/settings.json`: `statusLine` (ghorc `statusline.cjs`), `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = `18`, `idleCompaction` = `false`, `model` (config `lead.model`), `effortLevel` (config `lead.effort`). `model` and `effortLevel` are owner-level decisions.
- Project: `.claude/ghorc.json` exists (else copied from the template), `CLAUDE.md` has the `<!-- ghorc -->` section (else the template is appended), `.git/info/exclude` contains `.claude/ctx-*.json` (else appended).
`--apply` first copies `~/.claude/settings.json` to `settings.json.ghorc-<timestamp>.bak`, changes only the listed keys, never removes others and prints a diff. `GHORC_HOME` overrides the home directory (used by tests).

## What the plugin cannot do (by hand)
- **statusLine.** A plugin cannot install `statusLine` (only `agent` and `subagentStatusLine` take effect in plugin settings); `/ghorc:setup` writes it for you. By hand, add to `~/.claude/settings.json` or the project `.claude/settings.json`:
  ```json
  "statusLine": { "type": "command", "command": "node \"D:/Projects/ghorc/scripts/statusline.cjs\"", "refreshInterval": 30 }
  ```
  Line format (segments are omitted when data is absent): `model ·effort [⚡] │ ctx NN% (used/size) [→ac N%] │ 5h NN% (~Nh) │ 7d NN% (~Nh) │ role │ [⎇ ]branch │ session name`. Colors: green < 50%, yellow 50-69, red 70-79, bold red >= 80 (the same for 5h/7d); `NO_COLOR` or `GHORC_STATUSLINE_PLAIN=1` turn color off. The role comes from `GHORC_ROLE` and `agent.name`. The marker `→ac N%` is printed only if `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is set (the value is the threshold percentage). Cost is not shown. The shape of `rate_limits.*` is undocumented, so fields are read defensively. To capture a real sample: the first raw stdin is saved once to `<tmp>/ghorc/statusline-sample.json` (no setting needed), and `GHORC_STATUSLINE_DUMP=<file>` appends every raw stdin as a line to that file (no dump by default).
  (A reference to `${CLAUDE_PLUGIN_ROOT}` in `statusLine.command` is not confirmed by the documentation, so the path is absolute.) The status line writes `<project root>/.claude/ctx-<session_id>.json` (`workspace.project_dir`, else `CLAUDE_PROJECT_DIR`, else the git root; the write is atomic; extra keys `effort` and `rate_limits` are added when present). `ctx.cjs --session <id>` shows one session; add `.claude/ctx-*.json` to `.gitignore` or `.git/info/exclude`.
- **Global model and effort.** The lead is started explicitly: `claude --model opus --effort medium`. The global `model` and `effortLevel` in `~/.claude/settings.json` are changed by the owner. The variable `CLAUDE_CODE_EFFORT_LEVEL` must not be set (it overrides role frontmatter and the `effort` of a call).
- **Cache TTL.** `subagentPromptCacheTtl: "1h"` (and `promptCacheTtl` when paying by API) is set by the owner after choosing the billing type.
- **Lead marker.** For `heavyGuard.requireLeadEnv` the lead is started with the environment variable `GHORC_ROLE=lead`.
- **poppler.** The `ghorc:media` role needs `pdftotext` and `pdftoppm`.

## Config file `.claude/ghorc.json`
Missing keys come from `templates/ghorc.json`; objects merge recursively, arrays are replaced. Keys starting with `_comment` are ignored. Project root: first `CLAUDE_PROJECT_DIR`, then a walk up from the hook cwd to the git root; the file is searched in those directories (so the config is found from a subdirectory and from a worktree). Config check: `node scripts/check-config.cjs [--cwd <dir>] [--sample "<command>"]` (JSON, keys, types, regex compilation); on an error `session-start` prints one line. No file - the hooks forbid nothing except the `readGuard` rules.

| Key | Default | Meaning |
|---|---|---|
| `checks.fast` | `""` | the project fast-check command; agents run only this |
| `checks.full` | `""` | the full check; lead only, once on the final tree, in the background |
| `heavyCommands` | `[]` | regexes (strings) of heavy commands; forbidden to subagents |
| `readGuard.maxRepeat` | `3` | how many identical reads of one path in a row are allowed (the 4th is denied) without Edit/Write/Bash between them |
| `readGuard.maxImageBytes` | `2097152` | image size limit for reading |
| `readGuard.leadNoMedia` | `true` | the lead (a call without `agent_id`) does not read PDFs and images; the `ghorc:media` role does |
| `heavyGuard.requireLeadEnv` | `false` | `true`: heavy commands are allowed even for the lead only with `GHORC_ROLE=lead` |
| `thresholds.ctxPrepare` | `120000` | lead context tokens: refresh STATE |
| `thresholds.ctxHandoff` | `150000` | tokens: take no new package, hand the shift over |
| `lead.model` / `lead.effort` | `opus` / `medium` | parameters the candidate starts with in `/ghorc:handoff`; recommended values for `/ghorc:setup` |
| `lead.remind` | `true` | remind about skill `ghorc:orc` at start if `GHORC_ROLE` is unset; `GHORC_ROLE=lead` always reminds, `GHORC_ROLE=worker` (herdr workers, implementers in a separate process) never |
| `watchdog.autostart` | `true` | a lead session starts the transcript watchdog detached (one per machine) |
| `watchdog.intervalSec` / `rateMiBPerMin` / `warnMiB` / `stopMiB` | `30` / `10` / `100` / `250` | watchdog poll period and thresholds |
| `handoff.allowSendKeysExit` | `false` | owner permission: the new lead sends `/exit` to the old tab through `herdr agent send-keys` |
| `handoff.candidatePermissionArgs` | `[]` | permission-mode arguments for the candidate, for example `["--permission-mode","acceptEdits"]` |
| `handoff.statePath` / `handoffPath` | `STATE.md` / `HANDOFF.md` | where the state and the handoff file live |
| `criticalPaths` | `[]` | critical areas of the project: edits there go to `ghorc:reviewer-critical` |

Example (an npm project): `{"checks":{"fast":"npm run wf:check -- --profile fast","full":"npm run wf:check -- --profile full"},"heavyCommands":["\\bnpm\\s+run\\s+test:e2e\\b","\\bnpm\\s+(run\\s+)?test\\b(?!:)"],"criticalPaths":["src/billing/**"]}`.

## Hooks
- `read-guard` denies Read: a fully identical call (path, offset, limit, pages) `maxRepeat` times in a row (keyed by session+agent; reading a large file in parts does not count as a repeat); reset after Edit/Write/NotebookEdit, and after Bash/PowerShell only if the command mentions the file being read; without `session_id` no counter is kept; a PDF without `pages`; an image larger than `maxImageBytes`; any PDF and image for the lead when `leadNoMedia`.
- `heavy-check-guard` denies commands from `heavyCommands` (case-insensitive regex; no trailing `$`, otherwise `npm test | tail` is missed) when a subagent calls them (`agent_id` is in stdin).
- `session-start` prints the version, the config status, a config error line, and (to the lead only) the reminder to load skill `ghorc:orc`. It also reports pending watchdog alerts (`N watchdog alerts pending, run ctx.cjs`), a missing `<!-- ghorc -->` section in `CLAUDE.md` and `run /ghorc:setup` when `setup.cjs --check` finds something missing; the output stays under 300 characters. For a lead session (`GHORC_ROLE=lead`, or unset) with `watchdog.autostart` it starts the watchdog. Workers are started with `GHORC_ROLE=worker`.
- Any hook failure (broken JSON, no rights on tmp) means allow. State is kept in `<tmp>/ghorc/<session_id>/`.

## Transcript watchdog
`node scripts/watchdog.cjs [--interval 30] [--once] [--notify "<command>"] [--notify-file <path>] [--root <dir>] [--pid-file <path>]`: warns about a `~/.claude/projects/**/*.jsonl` file growing faster than 10 MiB/min continuously for 2 minutes (`--streakSec`), a size above 100 MiB (check the content), above 250 MiB while still growing, and a file under `subagents/` above 500 MiB. `--notify "<command>"` runs through the shell; the alert text is one last quoted argument and the variable `GHORC_ALERT`. `--notify-file` appends each alert as a line `<ISO time> <text>`. It stops nobody; hard stops are `read-guard` and the role `maxTurns`.

Autostart: `session-start` starts it detached (log `<tmp>/ghorc/watchdog.log`, alerts `<tmp>/ghorc/alerts.log`, pid lock `<tmp>/ghorc/watchdog.pid`; a live pid in the lock means it is not started again; the watchdog removes the lock on exit). Disable with `watchdog.autostart: false`. `ctx.cjs` prints the last 5 unread alerts (offset kept in `<tmp>/ghorc/alerts.offset`). Environment overrides for tests: `GHORC_TMP` (replaces `<tmp>/ghorc`) and `GHORC_WATCHDOG_ROOT` (the transcripts directory passed as `--root`).

## Rules on one page
1. The lead is Opus/medium; model and effort are set explicitly at launch (`--model opus --effort medium`); a global fallback does not replace this for a role.
2. The implementer is Sonnet/medium; money, recovery, migrations - Sonnet/high.
3. Ordinary review and re-check of fixes of an ordinary package - Sonnet/medium; critical review - Opus/high in round 1; on a critical package the final verdict and the check of money findings are Opus/high, and Sonnet checks only non-critical findings.
4. Opus again - if a fix changes a money invariant.
5. Haiku/low - only mechanical work with a machine-checkable result; not browser work, not scouting.
6. Fable - arbiter of a disputed question or a consultation; not the lead and not the default reviewer.
7. Small things - at most 2 commands, output at most 100 lines (~3K tokens), no package code edits - the lead does itself; anything bigger goes to a file or an agent.
8. On every Agent call the lead passes `effort` explicitly.
9. The lead does not read PDFs and images, transcripts, logs and files over 100 lines whole; attachments go as a file with a path to the `ghorc:media` role.
10. The lead does not write package code, does not run checks synchronously, does not poll agents.
11. The lead reads context from `.claude/ctx-<session>.json` (`ctx.cjs`) at a stage boundary: 120K - refresh STATE; 150K - take no new package, hand the shift over; ~170K - hand over at the nearest stage boundary.
12. Do not pull large output in; if it was pulled in, `/rewind` is done by the owner. `/clear` is not used by the lead.
13. In chat at most 25 lines; an agent report at most 25 lines (review at most 30); anything large goes to a file.
14. A brief is one tagged structure; an ordinary one is at most 500 words, a critical review at most 800; a brief over 200 lines is a task-statement error.
15. Checks only through the project runner; a bare test runner and `full` are forbidden for agents.
16. `full` - one, on the final tree, lead only, in the background, after fast; incomplete - cause first, restart only the failed phase.
17. Review limit - 3 rounds; a second `CHANGES_REQUIRED` means the lead changes the task statement rather than sending the same implementer again.
18. There is no sub-lead; by default direct Agent calls; a herdr worker - when a separate process or owner interaction is needed.
19. Limit: the lead plus 2 workers in total; one heavy check per machine.
20. "Significant" for a consultation - by 5 signs (money/data, contract/migration, a hard-to-reverse dependency, a conflict of key requirements, two failed approaches); the usual format - an answer plus a critic, one round.

## Tests
```
cd D:\Projects\ghorc
node --test
```
`node --test` without arguments finds `tests/*.test.cjs` on Node 20 and 24 (the form `node --test tests/` does not work on Node 24: the directory is treated as a module). There are no dependencies. Tests never start the watchdog against the real `~/.claude/projects`: they set `GHORC_TMP` and `GHORC_WATCHDOG_ROOT` to temporary directories.

## Verified
- `node --test` (Node 24.18): see the latest result in CHANGELOG (version 0.3.0).
- `claude plugin validate D:/Projects/ghorc`: Validation passed.
