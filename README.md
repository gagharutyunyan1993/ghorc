# ghorc

ghorc is a Claude Code plugin (version 0.3.0) that packages an orchestration discipline: one lead session plans,
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
ghorc 0.3.0
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

- **`read-guard.cjs`, PreToolUse `Read`.** Denies, in this order: a PDF or image for the lead (`leadNoMedia`); a PDF
  without `pages`; an image above `maxImageBytes`; a Read call identical in path, offset, limit and pages to the
  previous `maxRepeat` calls. Why: stops read loops and keeps media out of the lead window. Reading a file in parts is
  not a repeat. Images: `.png .jpg .jpeg .gif .webp .bmp`.
- **`read-guard.cjs`, PostToolUse `Edit|Write|NotebookEdit|Bash|PowerShell`.** Denies nothing; resets the repeat
  counter (Bash/PowerShell only when the command contains the file name of the last read).
- **`heavy-check-guard.cjs`, PreToolUse `Bash|PowerShell`.** Denies a command matching `heavyCommands` when a subagent
  runs it; with `heavyGuard.requireLeadEnv`, also in a main session without `GHORC_ROLE=lead`. Why: one heavy check
  per machine, run by the lead.
- **`session-start.cjs`, SessionStart.** Denies nothing; prints version, config status, the `ghorc:orc` reminder,
  pending alerts, a missing CLAUDE.md section and a setup hint (under 300 characters); autostarts the watchdog.

A subagent is recognized by `agent_id` in the hook input; a call without it counts as the lead. The repeat counter is
per session and per agent, in `<tmp>/ghorc/<session_id>/`; without `session_id` none is kept. Any hook failure
(broken input, unreadable config, no write access to tmp) means allow.

### Scripts (`scripts/`, run with `node`, all accept `--help`)

- `statusline.cjs` (stdin): the status line; writes `<project root>/.claude/ctx-<session_id>.json`.
- `ctx.cjs [--session <id>] [--max-age <minutes>] [--cwd <dir>]`: ctx files newest first (newest marked `*`), then
  up to 5 unread watchdog alerts, which it marks read.
- `watchdog.cjs [--interval 30] [--rateMiBPerMin 10] [--streakSec 120] [--warnMiB 100] [--stopMiB 250]
  [--subagentsMiB 500] [--root <dir>] [--once] [--notify "<command>"] [--notify-file <path>] [--pid-file <path>]`:
  watches `~/.claude/projects/**/*.jsonl`; notifies only. `--notify` runs the command through the shell with the alert
  text as one quoted argument and in `GHORC_ALERT`; `--notify-file` appends `<ISO time> <text>` lines.
- `setup.cjs --check | --apply <all|id,id,...> [--cwd <dir>]`: checks and applies the recommended setup.
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
`<report_back>`. `/ghorc:brief` has the full templates. A filled example:

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
| `5h`, `7d` | rate limit use and hours to reset (`~<1h`); only when `rate_limits` is in the input |
| `role` | `GHORC_ROLE` and the agent name, if any |
| `branch` (cyan) | git branch, short SHA when detached; `⎇ ` prefix inside a git worktree |
| `session` | session name, first 24 characters |

Colors for `ctx`, `5h`, `7d`: green below 50%, yellow 50-69%, red 70-79%, bold red from 80%. `NO_COLOR` or
`GHORC_STATUSLINE_PLAIN=1` turn color off. On an internal error it prints `model │ ctx ?%`. Cost is not shown.

### Reading ctx and watchdog alerts

```
node "<plugin>/scripts/ctx.cjs"
node "<plugin>/scripts/ctx.cjs" --session <id>
```

Each session file gives a line like `* ctx-<id>.json  Opus  ctx 62%  used=124000/200000  age=0m`; the newest, marked
`*`, is normally the lead's own session. Then `watchdog alerts (N unread):` and up to 5 lines, marked read once shown.
The session-start line `N watchdog alerts pending, run ctx.cjs` means unread alerts exist.

- `growth above 10 MiB/min for longer than 120 s`: a transcript grows fast; look for a read or tool loop in it.
- `over 100 MiB, check what the content is`: large transcript; check for big Read results or media.
- `ALARM, over 250 MiB and growing`: a runaway session; stop it yourself (the watchdog stops nothing).
- `ALARM, subagent file over 500 MiB`: a runaway subagent; stop it, then check its brief.

Each alert names the transcript path, its size and growth rate.

## Handoff

**When:** context reaches 150K at a package boundary, or ~170K at the nearest stage boundary.

**Preconditions:** `HERDR_ENV=1` (the lead runs inside herdr); no background agents or commands of the lead; herdr
workers listed in HANDOFF with pane ids; owner messages that arrived during the handoff written to STATE first.

**Sequence** (`/ghorc:handoff` drives it with `lead.*` and `handoff.*`; never use `--wait`):

1. Fill `handoff.handoffPath` from `templates/HANDOFF.md`, `status: DRAFT`.
2. Start the candidate in a new tab, prompt it (the skill has the full prompt text), wait up to 10 minutes, read:

```
herdr tab create
# bash
GHORC_ROLE=lead herdr agent start lead-next --kind claude -- --model opus --effort medium <permArgs>
# PowerShell
$env:GHORC_ROLE='lead'; herdr agent start lead-next --kind claude -- --model opus --effort medium <permArgs>
herdr agent prompt lead-next "Read HANDOFF.md, verify it against git, answer READY handoff=<id>."
herdr agent wait lead-next --until idle,blocked
herdr agent read lead-next
```

3. **READY:** the candidate answers `READY handoff=<id>`, state path, next action, restrictions, discrepancies. With
   discrepancies the old lead fixes HANDOFF and asks again in the same tab.
4. **STOP:** on an accepted READY the old lead writes `status: SENT`, prints `HANDOFF SENT - STOP` and does nothing
   more. `/exit` in the old tab comes from the owner, or from the new lead via `herdr agent send-keys` when
   `handoff.allowSendKeysExit` is `true`.
5. The new lead starts only after `herdr agent get` shows the old one finished, reads the last owner message there with
   `herdr agent read`, and verifies SHA, branch and processes itself: READY is a report, not proof.

**Guards:** candidate `blocked` or no READY in 10 minutes - the old lead closes the candidate and its tab, voids the
`handoff_id` and continues. One candidate per `handoff_id`. After 2 failed handoffs, ask the owner. The candidate does
not start its own rotation. Never delete uncommitted changes for a "clean intake"; never kill processes by the name
`claude`. A candidate with a large context from the start points to oversized startup instructions.

**Without herdr** (`HERDR_ENV` is not `1`) the skill runs no herdr command and prints the fallback: write STATE.md at
`handoff.statePath`, the owner runs `/clear`, then says "read STATE.md and continue". Cheaper, but it does not free
process memory.

## Configuration: `.claude/ghorc.json`

Create it with `/ghorc:setup` (item `config`) or copy `templates/ghorc.json`. Any key may be omitted; missing values
come from the template. Objects merge recursively; arrays and scalars replace. Keys starting with `_comment` are
ignored.

Lookup: `CLAUDE_PROJECT_DIR`, then each directory from the cwd up to the nearest `.git`, then the main repository root
(parent of `git rev-parse --git-common-dir`, so a worktree finds the main repository's config). With no file the
defaults apply: the read guard works, `heavyCommands` is empty, nothing is denied as heavy.

| Key | Type | Default | Read by | Meaning |
|---|---|---|---|---|
| `checks.fast` | string | `""` | agents | the fast check; the only check agents run |
| `checks.full` | string | `""` | lead | the full check; lead only, once, in the background |
| `heavyCommands` | string[] | `[]` | heavy guard | regexes of commands subagents may not run |
| `readGuard.maxRepeat` | number | `3` | read guard | identical Reads allowed in a row; the next is denied |
| `readGuard.maxImageBytes` | number | `2097152` | read guard | image size limit, bytes (2 MiB) |
| `readGuard.leadNoMedia` | boolean | `true` | read guard | calls without `agent_id` may not read PDFs, images |
| `heavyGuard.requireLeadEnv` | boolean | `false` | heavy guard | heavy commands also need `GHORC_ROLE=lead` |
| `thresholds.ctxPrepare` | number | `120000` | lead | tokens: refresh STATE |
| `thresholds.ctxHandoff` | number | `150000` | lead | tokens: no new package, hand over |
| `lead.model` | string | `"opus"` | handoff, setup | candidate model; setup's recommended `model` |
| `lead.effort` | string | `"medium"` | handoff, setup | candidate effort; setup's recommended `effortLevel` |
| `lead.remind` | boolean | `true` | session-start | `false`: no reminder when `GHORC_ROLE` is unset |
| `watchdog.autostart` | boolean | `true` | session-start | a lead session starts the watchdog detached |
| `watchdog.intervalSec` | number | `30` | session-start | poll period, seconds |
| `watchdog.rateMiBPerMin` | number | `10` | session-start | growth alarm rate |
| `watchdog.warnMiB` | number | `100` | session-start | size for "check the content" |
| `watchdog.stopMiB` | number | `250` | session-start | size alarm while still growing |
| `handoff.allowSendKeysExit` | boolean | `false` | handoff | the new lead may send `/exit` to the old tab |
| `handoff.candidatePermissionArgs` | string[] | `[]` | handoff | permission arguments for the candidate |
| `handoff.statePath` | string | `"STATE.md"` | lead, handoff | state file path |
| `handoff.handoffPath` | string | `"HANDOFF.md"` | handoff | handoff file path |
| `criticalPaths` | string[] | `[]` | lead, agents | areas whose edits go to `ghorc:reviewer-critical` |

"Lead", "agents" and "handoff" mean the key is read by the model through skills and role prompts, not by a script.
`lead.remind` affects only the reminder: `GHORC_ROLE=lead` always gets it, `GHORC_ROLE=worker` never. The watchdog
autostarts for a main session with `GHORC_ROLE=lead` or unset. `--streakSec` and `--subagentsMiB` are watchdog flags,
not config keys. Example:

```json
{
  "checks": { "fast": "npm run check:fast", "full": "npm run check:full" },
  "heavyCommands": ["\\bnpm\\s+run\\s+test:e2e\\b", "\\bnpm\\s+(run\\s+)?test\\b(?!:)"],
  "heavyGuard": { "requireLeadEnv": true },
  "handoff": { "candidatePermissionArgs": ["--permission-mode", "acceptEdits"] },
  "criticalPaths": ["src/billing/**", "POLICY.md"]
}
```

**`heavyCommands` semantics.** Each string is a JavaScript regex compiled with flag `i` (case-insensitive) and tested
against the whole command: a match anywhere counts, so `echo "npm test"` matches too. Backslashes are doubled in JSON
(`"\\b"`). Do not anchor with a trailing `$`: `\bnpm\s+test\b$` misses `npm test | tail -5`. An empty string matches
everything; a pattern that does not compile is skipped by the hook. Test patterns first:

```
node "<plugin>/scripts/check-config.cjs" --sample "npm test | tail -5" --sample "npm run lint"
```

It prints `config: <path>`, any `ERROR:` lines (invalid JSON, unknown key, wrong type, bad regex) and, per sample,
`HEAVY (<pattern>)` or `ordinary`. On a config error session-start prints one `config invalid:` line.

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
| `pct` | `~/.claude/settings.json` | `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = `"18"` |
| `idle` | `~/.claude/settings.json` | `idleCompaction` = `false` (no compaction while the lead waits) |
| `model` (owner decision) | `~/.claude/settings.json` | `model` = `lead.model` |
| `effort` (owner decision) | `~/.claude/settings.json` | `effortLevel` = `lead.effort` |
| `config` | `<project>/.claude/ghorc.json` | copied from the template if missing |
| `claudemd` | `<project>/CLAUDE.md` | `templates/CLAUDE-section.md` appended if the marker is missing |
| `exclude` | `<project>/.git/info/exclude` | line `.claude/ctx-*.json` |

`--apply` first copies `settings.json` to `settings.json.ghorc-<timestamp>.bak`, changes only the listed keys and
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
- **"the same Read call was repeated 3 times in a row".** The repeat limit. Use what was read, read another range, or
  edit the file first.
- **The lead's Bash is denied: "GHORC_ROLE=lead is not set".** `heavyGuard.requireLeadEnv` is `true` and the session
  started without the marker. Restart the lead with `GHORC_ROLE=lead`.
- **Status line empty.** `statusLine` is missing from settings, or `node` is not on `PATH`. Run `/ghorc:setup` and
  restart. Test the script: `echo '{}' | node "<plugin>/scripts/statusline.cjs"` prints a line starting
  `model? │ ctx --`.
- **`ctx.cjs` says "no ctx-*.json files".** The status line is not configured, or wrote under another root: it uses
  the git common root of `workspace.project_dir` (else of the cwd). Run `ctx.cjs --cwd <that root>`.
- **"config not found" in a worktree.** No file in the worktree, its ancestors or the main repository root, or git is
  not on `PATH`. `check-config.cjs --cwd <worktree>` shows the expected path; put the file in the main repository's
  `.claude/`.
- **Duplicate watchdog alerts.** Watchdog state is in memory: each new watchdog re-alerts every transcript already
  above `warnMiB`. A stale `<tmp>/ghorc/watchdog.pid` whose pid now belongs to another process blocks the autostart;
  delete it when no watchdog runs.
- **Handoff candidate never answers READY.** It waits on a permission prompt (`candidatePermissionArgs` empty), did
  not receive `GHORC_ROLE`, or the 10 minutes passed. Close it and its tab, void the `handoff_id`, fix, retry; after 2
  failures ask the owner.
- **No `5h`/`7d` segments.** `rate_limits` is absent from the status line input (not every session provides it; its
  shape is undocumented). Inspect `<tmp>/ghorc/statusline-sample.json` (the first input, saved once) or set
  `GHORC_STATUSLINE_DUMP=<file>` to append every input.

`<tmp>` is the OS temp directory (`%TEMP%` on Windows, usually `/tmp` on Linux); `GHORC_TMP` replaces `<tmp>/ghorc`.
The watchdog keeps `watchdog.log`, `alerts.log`, `alerts.offset` and `watchdog.pid` there.

## Development

```
node --test
claude plugin validate <path-to-ghorc>
```

`node --test` (or `npm test`) finds `tests/*.test.cjs` on Node 20 and 24; `node --test tests/` fails on Node 24.
Tests set `GHORC_TMP` and `GHORC_WATCHDOG_ROOT` to temp directories and never touch the real `~/.claude/projects`; one
test fails on any Cyrillic character in the repository. At 0.3.0: 59 tests pass on Node 24.18, validate passes.

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
