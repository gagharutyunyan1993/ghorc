# ghorc

ghorc is a Claude Code plugin (version 0.4.0) that packages an orchestration discipline: one lead session plans,
writes briefs, accepts reports and merges, while the work runs in subagents (or herdr worker sessions). It ships 8
agent roles, 4 skills, 3 guard hooks, a status line, a transcript watchdog, a setup script and templates. Everything
project-specific lives in one file, `<project>/.claude/ghorc.json`. The scripts are plain Node.js (CommonJS, no
dependencies) and run on Windows and Linux.

It is for developers who run long Claude Code sessions on real projects and want:

- **Lower cost.** Each class of work goes to the cheapest model and effort that can do it (Sonnet implements, Opus
  reviews critical code, Haiku does mechanical work); every Agent call carries an explicit `effort`.
- **Context isolation.** Large reads, logs, test runs and PDFs stay in the subagent's window; the lead receives a
  report of at most 25 lines, so its context stays small and a shift lasts longer.

## Quick start

Requirements: Claude Code with plugin support, Node.js 20+ on `PATH`, git. Optional: herdr (handoff into a new tab),
poppler (`pdftotext`, `pdftoppm`) for the `ghorc:media` role.

**1. Install.** The repository is its own marketplace, named `ghorc-local`.

```
claude plugin marketplace add <path-or-git-url-of-ghorc> --scope user
claude plugin install ghorc@ghorc-local --scope user
```

| Scope | Written to | Pick it when |
|---|---|---|
| `user` (default) | `~/.claude/settings.json` | you want ghorc in every project on this machine |
| `project` | `<project>/.claude/settings.json` | the team uses it (commit the file; use a git URL as source) |
| `local` | this project, not shared | you try it in one project without affecting teammates |

To try it without installing: `claude --plugin-dir <path-to-ghorc>` (this session only).

**2. Check the setup.** In a session in your project run `/ghorc:setup`. It runs `setup.cjs --check`, shows a table
(current value, recommended value, why) and applies only the items you confirm. The same check by hand:

```
node "<plugin>/scripts/setup.cjs" --check
```

`<plugin>` is the plugin directory: your clone (local path or `--plugin-dir`), otherwise the `installPath` in
`~/.claude/plugins/installed_plugins.json`. Inside skills it is `${CLAUDE_PLUGIN_ROOT}`.

**3. Start a lead session** with the marker variable and explicit model and effort (`lead.model`, `lead.effort`):

```
# bash
GHORC_ROLE=lead claude --model opus --effort medium
# PowerShell (the variable stays set for the rest of this shell)
$env:GHORC_ROLE='lead'; claude --model opus --effort medium
```

The SessionStart hook then prints a few lines, for example:

```
ghorc 0.4.0 session=<session id> role=lead
config: ok
lead: load skill ghorc:orc
CLAUDE.md has no ghorc section: paste templates/CLAUDE-section.md
run /ghorc:setup
```

**4. First package in 5 steps.**

1. `/ghorc:orc` loads the lead rules.
2. `ghorc:scout` (effort `low`) collects the facts into a file.
3. Write the brief with `/ghorc:brief`; start `ghorc:implementer` (effort `medium`) in its own worktree.
4. Accept the report by diff and check output; send the diff to `ghorc:reviewer`, or to `ghorc:reviewer-critical` if
   it touches `criticalPaths`.
5. On `ACCEPT` the lead runs `checks.full` once, in the background, on the final tree, then merges.

## What you get

### Roles (`agents/`, called as `ghorc:<role>`)

Tool sets: **edit** = Read, Edit, Write, Grep, Glob, Bash; **review** = Read, Grep, Glob, Bash, Write.

| Role | Model / effort | maxTurns | Tools | Purpose |
|---|---|---|---|---|
| `ghorc:implementer` | sonnet / medium | 120 | edit | code, tests, documents from a brief |
| `ghorc:reviewer` | sonnet / medium | 100 | review | ordinary diff review; writes only the review file |
| `ghorc:reviewer-critical` | opus / high | 100 | review | adversarial review: money, contracts, hooks, policy |
| `ghorc:integrator` | sonnet / medium | 100 | edit | merge conflicts, red checks on an accepted branch |
| `ghorc:release` | sonnet / medium | 100 | edit | version, changelog, tag; only on the owner's word |
| `ghorc:scout` | sonnet / low | 40 | review | read-only facts with `file:line`, into a file |
| `ghorc:consult` | sonnet / low | 60 | Read, Write, Bash, browser MCP | asks external models in a browser |
| `ghorc:media` | sonnet / low | 30 | Read, Write, Bash | the only role that reads PDFs and images |

Browser MCP for `ghorc:consult`: `mcp__chrome-devtools__*`, `mcp__claude-in-chrome__*`. No role spawns subagents;
every role reads `<project>/CLAUDE.md` and `.claude/ghorc.json` itself.

### Skills

| Skill | What it does |
|---|---|
| `/ghorc:orc` | lead rules: one-page rules, routing, effort, thresholds, SendMessage vs a new agent |
| `/ghorc:brief` | brief structure (7 tags), content by effort, 3 templates, antipatterns, report limits |
| `/ghorc:handoff` | hands the lead shift to a fresh session in a new herdr tab (READY/STOP protocol) |
| `/ghorc:setup` | runs `setup.cjs --check`, shows the table, applies confirmed items |

Plugin skills and agents are namespaced by Claude Code, so they cannot collide with your own.

### Hooks (`hooks/hooks.json`)

- **`read-guard.cjs`, PreToolUse `Read` and MCP `*screenshot*|*snapshot*|*read_page*` tools.** Counts reads per
  agent and per resolved path (lower-cased on Windows; offset, limit and pages do not make a new key) and denies:
  more than `maxRepeat` reads of one path between edits of it (a changed mtime or size also starts a new count);
  a PDF without `pages`; PDF pages above `pdfPageBudget`; image bytes above `mediaByteBudget`; an image above
  `maxImageBytes`; any PDF or image for a subagent whose `agent_type` is not in `mediaRoles` ("media is read by the
  media role"); any media for the lead (`leadNoMedia`); more than `maxScreenshots` MCP screenshot/snapshot/read_page
  calls (heap snapshots excluded). A file that cannot be stat-ed still counts as a read. Images:
  `.png .jpg .jpeg .gif .webp .bmp`; extensions match case-insensitively.
  "Lead" means no `agent_id` and `GHORC_ROLE` not `worker`, so a herdr worker started with `GHORC_ROLE=worker`
  may read media (still within the budgets).
- **`read-guard.cjs`, PostToolUse `Edit|Write|NotebookEdit`.** Denies nothing; resets the counter of the edited
  path only. Bash and PowerShell never reset a counter.
- **`heavy-check-guard.cjs`, PreToolUse `Bash|PowerShell`.** Denies a command matching `heavyCommands` when a
  subagent (`agent_id`) or a worker (`GHORC_ROLE=worker`) runs it; with `heavyGuard.requireLeadEnv`, also in a
  main session without `GHORC_ROLE=lead`. Always denied for subagents and workers: `claude -p`,
  `herdr agent start`, `herdr agent prompt`. Matching is per command segment (see "heavyCommands semantics").
  If `.claude/ghorc.json` is invalid (JSON error, wrong type, bad regex), it denies every heavy command, for the
  lead too, using the valid configured patterns plus a built-in default list, and says why: fix the file.
- **`session-start.cjs`, SessionStart.** Denies nothing; prints, in this order: pending watchdog alerts (count and
  the last 2 lines), `ghorc <version> session=<id> role=<role>` (`role=unknown (set GHORC_ROLE)` when unset), the
  config status, reminders, a missing CLAUDE.md section and a setup hint. Output is cut at 299 characters and ends
  with `+more: run ctx` when cut. It autostarts or restarts the project's watchdog and removes `ctx-*.json` files
  and tmp state older than 7 days.

A subagent is recognized by `agent_id` in the hook input; a call without it counts as the lead. Read counters are per
session and per agent, in `<tmp>/ghorc-<user>/<session_id>/read-<agent>.json` (written atomically); without
`session_id` none is kept. A hook that fails internally allows the call; the only deliberate deny on an error is the
"config invalid" one above.

### Scripts (`scripts/`, run with `node`, all accept `--help`)

- `statusline.cjs` (stdin): the status line; writes `<project root>/.claude/ctx-<session_id>.json`.
- `ctx.cjs --session <id> [--max-age <minutes>] [--cwd <dir>]` or `ctx.cjs --all`: this session's ctx file, then
  up to 10 unread watchdog alerts of this session, oldest first; only the shown ones are marked read. `--session`
  takes the full id or the 8-character prefix from the status line (`#xxxxxxxx`); env `GHORC_SESSION` is the
  default. Without both it prints a usage line and exits 2. `--all` lists every session and marks nothing.
- `watchdog.cjs [--interval 30] [--rateMiBPerMin 10] [--streakSec 120] [--warnMiB 100] [--stopMiB 250]
  [--subagentsMiB 500] [--transcript-dir <dir>] [--project-root <dir>] [--version <v>] [--once]
  [--notify "<program and args>"] [--notify-file <path>] [--pid-file <path>] [--heartbeat-file <path>]`:
  one watchdog per project root; watches only that project's transcript directory
  (`~/.claude/projects/<encoded project root>`, `subagents/` included); notifies only. `--root` is the older name of
  `--transcript-dir`. `--notify` splits the string into an argv array (double quotes group words) and spawns it
  without a shell; the alert text is the last argument and is also in `GHORC_ALERT`; for a script use
  `--notify "cmd /c script.cmd"`. `--notify-file` appends `<ISO time> <text>` lines. Size alerts are remembered in
  `<tmp>/ghorc-<user>/watchdog-<root hash>.state.json`: a restart does not repeat them; one repeats only after the
  file grew by `warnMiB`/2 since its last alert or the level rose. A file already above `stopMiB` when first seen
  raises the stop alarm at once. The growth streak drops by one on a slow poll instead of resetting. The pid file
  (JSON: pid, version, root, start time) and a heartbeat file are touched every poll; SessionStart restarts a
  watchdog whose pid is dead, whose version differs or whose heartbeat is older than two intervals. It kills
  nothing (a stale pid may be a foreign process): it writes a new pid file, and an older watchdog that sees a pid
  other than its own there exits on its next poll.
- `setup.cjs --check | --apply <all|id,id,...> [--project] [--cwd <dir>]`: checks and applies the recommended setup;
  `--project` moves the `pct` item from global settings to this project (see "Manual steps").
- `check-config.cjs [--cwd <dir>] [--sample "<command>"]...`: validates `ghorc.json`, shows which `heavyCommands`
  match each sample; exit code 1 on errors.

### Templates (`templates/`)

`ghorc.json` (config defaults), `CLAUDE-section.md` (section for the project `CLAUDE.md`, first line is the marker
`<!-- ghorc -->`), `STATE.md` (lead state, 40-80 lines), `HANDOFF.md` (shift handoff, at most 50 lines).

## Daily workflow for the lead

### Rules on one page

1. The lead is Opus/medium; model and effort are set explicitly at launch (`--model opus --effort medium`); a global
   fallback does not replace this for a role.
2. The implementer is Sonnet/medium; money, recovery, migrations: Sonnet/high.
3. Ordinary review and re-check of fixes of an ordinary package: Sonnet/medium. Critical review: Opus/high in round 1;
   on a critical package the final verdict and the check of money findings are Opus/high, Sonnet checks only
   non-critical findings.
4. Opus again if a fix changes a money invariant.
5. Haiku/low only for mechanical work with a machine-checkable result; not browser work, not scouting.
6. Fable is the arbiter of a disputed question or a consultation; not the lead and not the default reviewer.
7. Small things (at most 2 commands, output at most 100 lines or ~3K tokens, no package code edits) the lead does
   itself, with no context threshold; anything bigger goes to a file or an agent.
8. On every Agent call the lead passes `effort` explicitly.
9. The lead does not read PDFs, images, transcripts, logs or files over 100 lines whole (a diff by `--stat` and by
   file); attachments go as a file path to `ghorc:media`; PDFs are converted to text/PNG first.
10. The lead does not write package code, does not run checks synchronously, does not poll agents.
11. The lead reads its context with `ctx.cjs` at a stage boundary: 120K - refresh STATE; 150K - take no new package,
    hand the shift over; ~170K - hand over at the nearest stage boundary.
12. Do not pull large output in; if it was pulled in, the owner runs `/rewind`. The lead does not use `/clear`.
13. In chat at most 25 lines; an agent report at most 25 lines (review at most 30); anything large goes to a file.
14. A brief is one tagged structure: ordinary at most 500 words, critical review at most 800; over 200 lines is a
    task-statement error.
15. Checks only through the project commands (`checks`); a bare test runner and `full` are forbidden for agents.
16. `full`: one run, on the final tree, lead only, in the background, after fast; if incomplete, find the cause first
    and restart only the failed phase.
17. Review limit is 3 rounds; a second `CHANGES_REQUIRED` means the lead rewrites the task instead of resending it.
18. There is no sub-lead; direct Agent calls by default; a herdr worker when a separate process or owner interaction
    is needed.
19. At most the lead plus 2 workers in total; one heavy check per machine.
20. A consultation is "significant" on any of: money/data/recovery, an external contract or migration, a
    hard-to-reverse dependency, a conflict of key requirements, two failed approaches. Format: an answer plus a
    critic, one round.

### Routing and effort

| Class of work | Role / model | Effort |
|---|---|---|
| Ordinary implementation | `ghorc:implementer` | medium |
| Edit by a ready pattern | `ghorc:implementer` | low |
| Money, recovery, migrations | `ghorc:implementer` | high |
| Architecture with clear constraints | Opus | medium (conflicting invariants: high) |
| Ordinary review, re-check of fixes | `ghorc:reviewer` | medium |
| Critical review (contract, policy, hook, money) | `ghorc:reviewer-critical` | high |
| Scouting (facts about code, git) | `ghorc:scout` | low-medium |
| Mechanical work with a machine check | Haiku | low |
| Attachments (PDFs, screenshots) | `ghorc:media` | low |
| Consultation with external models | `ghorc:consult` | low |
| Dispute, arbiter | Fable | medium-high |
| Merge conflict, red pipeline | `ghorc:integrator` | medium |
| Release (owner's word only) | `ghorc:release` | medium |
| Separate process or owner interaction | herdr worker, `--effort` explicit | - |

| Effort | Use for |
|---|---|
| low | mechanical work, scouting, edits by a pattern |
| medium | everything routine |
| high | critical review, delicate debugging, conflicting invariants, money; name the reason |
| xhigh / max | only manually, for a single task |

A known risk gets the right model and effort at once. Unexpected difficulty: reformulate the task, then raise effort,
then change the model. A network failure, out of memory or a wrong command is no reason to raise effort.
`CLAUDE_CODE_EFFORT_LEVEL` must stay unset: it overrides role frontmatter and the `effort` of a call.

### Thresholds

| Value | Source | Action |
|---|---|---|
| 120K tokens | `thresholds.ctxPrepare` | refresh STATE at the next stage boundary |
| 150K tokens | `thresholds.ctxHandoff` | take no new package; `/ghorc:handoff` at the package boundary |
| ~170K tokens | rule 11 | hand over at the nearest stage boundary |
| 18 | `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | context fill percentage at which autocompaction runs |

The token thresholds are applied by the lead (skills), not enforced by a script. The 18 is a percentage of the
context window: check `context_window_size` in `ctx.cjs` (18% of 1M is about 180K; of 200K about 36K).

### Brief

Seven tags in order: `<role>`, `<context>`, `<read_first>`, `<you_own>`, `<steps>`, `<constraints>`,
`<report_back>`. `/ghorc:brief` has the full templates. Reports, scratch and large outputs go to
`<project>/.claude/ghorc-out/` (setup git-excludes it). A filled example:

```
<role>You are the implementer of task E12. You work alone and spawn no subagents.</role>
<context>
CSV export breaks rows whose title contains a comma; quote fields per RFC 4180.
Starting tree: main @ 3f2a9c1. Working directory: ../wt-e12.
</context>
<read_first>
- src/export/csv.ts:40-85 - the row writer
- tests/export/csv.test.ts:1-30 - existing cases
</read_first>
<you_own>src/export/csv.ts, tests/export/csv.test.ts. Anything else goes to "Suggestions".</you_own>
<steps>
1. Quote fields containing a comma, a quote or a newline; double inner quotes.
2. Add a test for each of the three cases.
3. Checks: npm run check:fast
Done when: the three new tests pass and existing tests are unchanged.
</steps>
<constraints>
- No incidental refactoring. Checks only through npm run check:fast; no full suite.
- After two failed fixes of the same cause, stop and report observations and hypotheses.
</constraints>
<report_back>STATUS: DONE | HANDOFF | BLOCKED; SHA; behavior change; checks with output;
unverified; next step; suggestions. Up to 25 lines.</report_back>
```

The effort goes on the Agent call (`effort: "medium"`), not in the brief.

### How to accept a report

- The first line is `STATUS: DONE | HANDOFF | BLOCKED` (implementer, integrator, release) or a verdict
  `ACCEPT | ACCEPT_WITH_NOTES | CHANGES_REQUIRED | BLOCKED` (reviewers). Details belong in a file, not the report.
- Accept by facts: the SHA exists, `git diff --stat <base>..<sha>` stays inside `<you_own>`, every check comes with
  its command and output. "Unverified" items and "Suggestions" are the lead's decision.
- `CHANGES_REQUIRED` needs a P0/P1 finding with `file:line` and a reproduction. A clarification on the same task (at
  most 5 calls, within an hour) goes by SendMessage to the same agent; otherwise a new agent works from the diff. A
  second `CHANGES_REQUIRED` means a new brief. An agent cut off by `maxTurns` is resumed once, then BLOCKED.

### Status line

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
`GHORC_GIT_TIMEOUT_MS` raises the 300 ms git call timeout (tests use it).

Verified against a live sample (Claude Code 2.1.300): `rate_limits.five_hour` and `.seven_day` are
`{used_percentage, resets_at}` with `resets_at` in epoch seconds; `effort` is `{level}`; `model` is
`{id, display_name}`. Other key spellings in the script are defensive fallbacks only.

### Reading ctx and watchdog alerts

```
node "<plugin>/scripts/ctx.cjs" --session <id from the #xxxxxxxx status segment or from SessionStart>
node "<plugin>/scripts/ctx.cjs" --all
```

Take the id from the `#xxxxxxxx` status line segment or the `session=` field of the SessionStart line; the lead
never guesses "the newest file". The output is a line like `ctx-<id>.json  Opus  ctx 62%  used=124000/200000  age=0m`.
Then `watchdog alerts (N unread):` and up to 10 lines, oldest first, marked read once shown (alerts of other sessions
keep their own offsets). The session-start line `N watchdog alerts pending, run ctx` means unread alerts exist.

- `growth above 10 MiB/min for longer than 120 s`: a transcript grows fast; look for a read or tool loop in it.
- `over 100 MiB, check what the content is`: large transcript; check for big Read results or media.
- `ALARM, over 250 MiB and growing`: a runaway session; stop it yourself (the watchdog stops nothing).
- `ALARM, subagent file over 500 MiB`: a runaway subagent; stop it, then check its brief.

Each alert names the transcript path, its size and growth rate.

## Handoff

**When:** context reaches 150K at a package boundary, or ~170K at the nearest stage boundary.

**Preconditions:** `HERDR_ENV=1` (the lead runs inside herdr); no background agents or commands of the lead; herdr
workers listed in HANDOFF with pane ids; STATE.md written first with the mandatory sections `in_flight`,
`unanswered_owner_messages` (verbatim, with time), `head` (git HEAD) and `seq` (+1 on every write).

**Sequence** (`/ghorc:handoff` drives it with `lead.*` and `handoff.*`; never use `--wait`):

1. Fill `handoff.handoffPath` from `templates/HANDOFF.md`, `status: DRAFT`.
2. Start the candidate in a new tab, prompt it (the skill has the full prompt text), wait for READY, read:

```
herdr tab create
# bash
GHORC_ROLE=lead herdr agent start lead-next --kind claude -- --model opus --effort medium <permArgs>
# PowerShell
$env:GHORC_ROLE='lead'; herdr agent start lead-next --kind claude -- --model opus --effort medium <permArgs>
herdr agent prompt lead-next "Read HANDOFF.md, verify it against git, answer READY handoff=<id>; wait for ACTIVATE."
herdr agent wait lead-next --until idle,blocked
herdr agent read lead-next
```

3. **READY:** the candidate answers `READY handoff=<id>`, state path, next action, restrictions, discrepancies. With
   discrepancies the old lead fixes HANDOFF and asks again in the same tab. The old lead polls `herdr agent get` every
   60 s up to `handoff.readyTimeoutMin` (default 10) minutes.
4. **ACTIVATE and STOP:** on an accepted READY the old lead writes `status: SENT` (STATE `seq` + 1), sends
   `herdr agent prompt lead-next "ACTIVATE <handoff_id>"` as its last action (the owner does it when
   `handoff.allowSendKeysExit` is `false`), prints `HANDOFF SENT - STOP` and does nothing more. `/exit` in the old tab
   comes from the owner, or from the new lead via `herdr agent send-keys` when `allowSendKeysExit` is `true`.
5. The candidate acts only on `ACTIVATE <id>` and refuses a different id. It re-reads STATE.md and refuses if `head`
   moved without a note or `seq` changed. It then waits until `herdr agent get` shows the old lead finished, reads the
   last owner message there with `herdr agent read`, answers every `unanswered_owner_messages` item, collects every
   `in_flight` item, and verifies SHA, branch and processes itself: READY is a report, not proof.

**Guards:** candidate `blocked` or no READY by the deadline - the old lead reports, closes the candidate and its tab,
voids the `handoff_id` and continues. One candidate per `handoff_id`. After 2 failed handoffs, ask the owner.
The candidate does not start its own rotation. Never delete uncommitted changes for a "clean intake"; never kill
processes by the name `claude`. A candidate with a large context from the start points to oversized startup
instructions.

**Without herdr** (`HERDR_ENV` is not `1`) the skill runs no herdr command and prints the fallback: write STATE.md at
`handoff.statePath`, the owner runs `/clear`, then says "read STATE.md and continue". Cheaper, but it does not free
process memory.

## Configuration: `.claude/ghorc.json`

Create it with `/ghorc:setup` (item `config`) or copy `templates/ghorc.json`. Any key may be omitted; missing values
come from the template. Objects merge recursively; arrays and scalars replace. Keys starting with `_comment` are
ignored.

Lookup (hooks): `CLAUDE_PROJECT_DIR`, then each directory from the cwd up to the nearest `.git`, then the main
repository root
(parent of `git rev-parse --git-common-dir`, so a worktree finds the main repository's config). With no file the
defaults apply: the read guard works, `heavyCommands` is empty, nothing is denied as heavy.

**Project root (one rule).** Everything that writes or reads under `<root>/.claude` (setup `--apply config`, the
status line's `ctx-*.json`, `ctx.cjs`, the CLAUDE.md check) uses `scripts/lib/root.cjs`: `CLAUDE_PROJECT_DIR` if set,
else the main git root of the cwd (parent of the git common dir, so a worktree maps to the main repository), else the
cwd. Writers and readers therefore agree, in a worktree too.

Xs it) and use its git toplevel, so a worktree is its own root; `CLAUDE_PROJECT_DIR` is for hooks only.

| Key | Type | Default | Read by | Meaning |
|---|---|---|---|---|
| `checks.fast` | string | `""` | agents | the fast check; the only check agents run |
| `checks.full` | string | `""` | lead | the full check; lead only, once, in the background |
| `heavyCommands` | string[] | `[]` | heavy guard | regexes of commands subagents may not run |
| `readGuard.maxRepeat` | number | `3` | read guard | reads of one path between edits; the next is denied |
| `readGuard.maxImageBytes` | number | `2097152` | read guard | image size limit, bytes (2 MiB) |
| `readGuard.leadNoMedia` | boolean | `true` | read guard | calls without `agent_id` may not read PDFs, images |
| `readGuard.mediaRoles` | string[] | `["ghorc:media","media"]` | read guard | agent types that may read media |
| `readGuard.pdfPageBudget` | number | `60` | read guard | PDF pages per agent |
| `readGuard.mediaByteBudget` | number | `8388608` | read guard | image bytes per agent (8 MiB) |
| `readGuard.maxScreenshots` | number | `60` | read guard | MCP screenshot/snapshot/read_page calls per agent |
| `heavyGuard.requireLeadEnv` | boolean | `false` | heavy guard | heavy commands also need `GHORC_ROLE=lead` |
| `thresholds.ctxPrepare` | number | `120000` | lead | tokens: refresh STATE |
| `thresholds.ctxHandoff` | number | `150000` | lead | tokens: no new package, hand over |
| `lead.model` | string | `"opus"` | handoff, setup | candidate model; setup's recommended `model` |
| `lead.effort` | string | `"medium"` | handoff, setup | candidate effort; setup's recommended `effortLevel` |
| `lead.remind` | boolean | `true` | session-start | `false`: no reminder when `GHORC_ROLE` is unset |
| `watchdog.autostart` | boolean | `true` | session-start | a lead session starts the project watchdog detached |
| `watchdog.intervalSec` | number | `30` | session-start | poll period, seconds |
| `watchdog.rateMiBPerMin` | number | `10` | session-start | growth alarm rate |
| `watchdog.warnMiB` | number | `100` | session-start | size for "check the content" |
| `watchdog.stopMiB` | number | `250` | session-start | size alarm while still growing |
| `handoff.allowSendKeysExit` | boolean | `false` | handoff | the new lead may send `/exit` to the old tab |
| `handoff.candidatePermissionArgs` | string[] | `[]` | handoff | permission arguments for the candidate |
| `handoff.statePath` | string | `"STATE.md"` | lead, handoff | state file path |
| `handoff.handoffPath` | string | `"HANDOFF.md"` | handoff | handoff file path |
| `handoff.readyTimeoutMin` | number | `10` | handoff | READY wait in minutes, polled every 60 s |
| `criticalPaths` | string[] | `[]` | lead, agents | areas whose edits go to `ghorc:reviewer-critical` |

"Lead", "agents" and "handoff" mean the key is read by the model through skills and role prompts, not by a script.
`lead.remind` affects only the reminder: `GHORC_ROLE=lead` always gets it, `GHORC_ROLE=worker` never. The watchdog
autostarts for a main session with `GHORC_ROLE=lead` or unset. `--streakSec` and `--subagentsMiB` are watchdog flags,
not config keys. Example:

```json
{
  "checks": { "fast": "npm run check:fast", "full": "npm run check:full" },
  "heavyCommands": ["^npm\\s+run\\s+test:e2e\\b", "^npm\\s+(run\\s+)?test\\b(?!:)"],
  "heavyGuard": { "requireLeadEnv": true },
  "handoff": { "candidatePermissionArgs": ["--permission-mode", "acceptEdits"] },
  "criticalPaths": ["src/billing/**", "POLICY.md"]
}
```

**`heavyCommands` semantics.** Each string is a JavaScript regex compiled with flag `i` (case-insensitive). A
command is cut into segments at `&&`, `||`, `;`, `|`, `&`, newlines, `( ) { }`, `$(` and backticks; quoted text is
blanked first, except the quoted argument of a shell wrapper (`bash -c "..."`, `cmd /c "..."`,
`powershell -Command "..."`) and `$(...)` or backticks inside double quotes. The regex must match at the START of a
segment, after optional env assignments (`FOO=1 `) and wrappers (`cmd /c`, `bash -c`, `powershell -Command`,
`call`, `time`). npm global options (`--prefix app`, `-C app`, `-w x`, `--silent`) are dropped, `run-script` reads
as `run`, and a leading `npm run ` or `npx ` is also tried off, so `^vitest` matches `npx vitest`. Hence
`git commit -m "run npm test"` and `echo npm test` are ordinary, while `cd app && npm test` is heavy. Write
patterns for the segment start (`^npm\s+test\b`); backslashes are doubled in JSON. An empty string matches
everything; a pattern that does not compile makes the config invalid. Test patterns first:

```
node "<plugin>/scripts/check-config.cjs" --sample "npm test | tail -5" --sample "npm run lint"
```

It prints `config: <path>`, any `ERROR:` lines (invalid JSON, unknown key, wrong type, bad regex) and, per sample,
`HEAVY (<pattern>)` or `ordinary`. On a config error session-start prints one `config invalid:` line and the
heavy guard denies as described under Hooks; an unknown key alone prints `config warning:` and denies nothing.
Validation results are cached by file mtime and size in `<tmp>/ghorc-<user>/config-valid.json`.

## With and without herdr

Without herdr everything except the handoff tab works through the Agent tool: roles, hooks, status line, watchdog,
`/ghorc:orc`, `/ghorc:brief`, `/ghorc:setup`. `/ghorc:handoff` prints the `/clear` fallback.

With herdr you also get `/ghorc:handoff` into a new tab and worker sessions with their own process and effort. Start
workers with `GHORC_ROLE=worker`, so they get no lead reminder and start no watchdog:

```
# bash
GHORC_ROLE=worker herdr agent start <name> --kind claude -- --model sonnet --effort medium
# PowerShell
$env:GHORC_ROLE='worker'; herdr agent start <name> --kind claude -- --model sonnet --effort medium
```

Whether herdr passes the variable to the child session is not verified: check the first worker's SessionStart lines.

## Manual steps and what `/ghorc:setup` automates

`/ghorc:setup` (or `setup.cjs --apply <ids>`) handles these items; `--apply all` includes `model` and `effort`:

| Item | Target | Recommended |
|---|---|---|
| `statusLine` | `~/.claude/settings.json` | `node "<plugin>/scripts/statusline.cjs"`, `refreshInterval` 30 |
| `statusLineStale` | `~/.claude/settings.json` | check only: older plugin-cache path; same fix as `statusLine` |
| `pct` | global `settings.json`; `--project`: `settings.local.json` | `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = `"18"` |
| `idle` | `~/.claude/settings.json` | `idleCompaction` = `false` (no compaction while the lead waits) |
| `model` (owner decision) | `~/.claude/settings.json` | `model` = `lead.model` |
| `effort` (owner decision) | `~/.claude/settings.json` | `effortLevel` = `lead.effort` |
| `config` | `<project>/.claude/ghorc.json` | copied from the template if missing |
| `claudemd` | `<project>/CLAUDE.md` | `templates/CLAUDE-section.md` appended if the marker is missing |
| `exclude` | git `info/exclude` (via `git rev-parse --git-path`) | lines `.claude/ctx-*.json`, `.claude/ghorc-out/` |
| `heavy` (warning only) | `<project>/.claude/ghorc.json` | warns: `heavyCommands` empty or no match for `checks.full` |

`pct` is GLOBAL (every project) unless `--project` is given. Warnings are never applied by `--apply all` and do
not make `--check` unclean. `--apply` first copies
`settings.json` to `settings.json.ghorc-<timestamp>.bak`, changes only the listed keys and
prints a diff. Changes take effect in a new session. `GHORC_HOME` overrides the home directory (used by tests).

The plugin cannot do, so you do:

- **statusLine.** A plugin cannot install it; use setup or add by hand to `~/.claude/settings.json`:
  `"statusLine": {"type": "command", "command": "node \"<plugin>/scripts/statusline.cjs\"", "refreshInterval": 30}`.
- **Config and CLAUDE.md content.** Setup copies templates; check commands, `heavyCommands`, `criticalPaths` are yours.
- **Lead launch** with `GHORC_ROLE=lead` and explicit `--model`/`--effort`; keep `CLAUDE_CODE_EFFORT_LEVEL` unset.
- **Global model, effort and cache TTL** are owner decisions; setup sets model/effort only when named, cache TTL never.
- **herdr** (for handoff) and **poppler** (for `ghorc:media`) are installed separately.

## Troubleshooting

- **The lead's Read is denied: "the lead does not read media".** `readGuard.leadNoMedia` applies to every call without
  `agent_id`, herdr worker sessions included. Give the path to `ghorc:media`, or set `leadNoMedia: false`.
- **"<file> was already read 3 times".** The per-path limit; ranges do not help. Use what was read, or edit the file
  first (an Edit of that path resets it).
- **"media is read by the media role".** A subagent that is not in `readGuard.mediaRoles` tried a PDF or image; hand
  the file to `ghorc:media`.
- **"config invalid: ..." on a Bash call.** `.claude/ghorc.json` has an error; every heavy command is denied until it
  is fixed. Run `check-config.cjs`; the fix is seen at once.
- **The lead's Bash is denied: "GHORC_ROLE=lead is not set".** `heavyGuard.requireLeadEnv` is `true` and the session
  started without the marker. Restart the lead with `GHORC_ROLE=lead`.
- **Status line empty.** `statusLine` is missing from settings, or `node` is not on `PATH`. Run `/ghorc:setup` and
  restart. Test the script: `echo '{}' | node "<plugin>/scripts/statusline.cjs"` prints a line starting
  `model? │ ctx --`.
- **`ctx.cjs` prints a usage line and exits 2.** It needs `--session <id>` (or `GHORC_SESSION`, or `--all`).
- **`ctx.cjs` says "no ctx-*.json files".** The status line is not configured, or wrote under another root: it uses
  the root rule (`CLAUDE_PROJECT_DIR`, else the git common root of `workspace.project_dir` or the cwd). Run
  `ctx.cjs --cwd <that root>`.
- **"config not found" in a worktree.** No file in the worktree, its ancestors or the main repository root, or git is
  not on `PATH`. `check-config.cjs --cwd <worktree>` shows the expected path; put the file in the main repository's
  `.claude/`.
- **Status line stops updating after `plugin update`.** Setup writes the path of the running copy, which under a
  plugin cache is a versioned directory. After an update the old path may be gone: `setup.cjs --check` reports
  `statusLineStale`; re-run `/ghorc:setup` (or `--apply statusLineStale`).
- **Duplicate watchdog alerts.** Size alerts persist in `<tmp>/ghorc-<user>/watchdog-<root hash>.state.json`, so a
  restart repeats none for unchanged files; delete that file to reset.
- **The watchdog does not run.** SessionStart restarts one that is dead, of another version or silent for two
  intervals. Check `<tmp>/ghorc-<user>/watchdog-<root hash>.pid` (JSON) and `.log`; `watchdog.autostart: false`
  and worker sessions never start it.
- **Handoff candidate never answers READY.** It waits on a permission prompt (`candidatePermissionArgs` empty), did
  not receive `GHORC_ROLE`, or the 10 minutes passed. Close it and its tab, void the `handoff_id`, fix, retry; after 2
  failures ask the owner.
- **No `5h`/`7d` segments.** `rate_limits` is absent from the status line input (not every session provides it; its
  shape is undocumented). Inspect `<tmp>/ghorc-<user>/statusline-sample.json` (the first input, saved once) or set
  `GHORC_STATUSLINE_DUMP=<file>` to append every input.

`<tmp>` is the OS temp directory (`%TEMP%` on Windows, usually `/tmp` on Linux); the plugin works in
`<tmp>/ghorc-<user>` (one directory per OS user) and `GHORC_TMP` replaces that whole path. Per project root (an
8-character hash) it keeps `watchdog-<hash>.log`, `.pid`, `.beat`, `.state.json` and `alerts-<hash>.log`;
per session an alert offset file.

## Development

```
node --test
claude plugin validate <path-to-ghorc>
```

`node --test` (or `npm test`) finds `tests/*.test.cjs` on Node 20 and 24; `node --test tests/` fails on Node 24.
Tests set `GHORC_TMP` and `GHORC_WATCHDOG_ROOT` to temp directories and never touch the real `~/.claude/projects`; one
test fails on any Cyrillic character in the repository. At 0.4.0: 100 tests pass on Node 24.18, validate passes.
`GHORC_HOOK_DUMP=<file>` makes every hook append its raw stdin JSON, one line per call, to that file (off by
default); use it to see which fields (`agent_type`, `agent_id`) Claude Code really sends.

**Versioning.** Bump `version` in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `package.json`
together and add a `CHANGELOG.md` entry; an installed copy sees no update without a version change.

**Updating an installed copy** (restart the session afterwards):

```
claude plugin marketplace update ghorc-local
claude plugin update ghorc@ghorc-local
```

During development `claude --plugin-dir <path-to-ghorc>` loads the working tree; edits apply on the next start.
`node "<plugin>/scripts/watchdog.cjs" --once` scans transcripts once and exits.

Changes are listed in `CHANGELOG.md`.
