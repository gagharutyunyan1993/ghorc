# Workflow: the lead and its workers

One lead session plans, writes briefs, accepts reports and merges. The work runs in subagents (Agent tool calls) or,
optionally, in herdr worker sessions ([with-herdr.md](with-herdr.md)). Hooks enforce a few limits
([hooks.md](hooks.md)); everything on this page is instructions that the lead and the roles follow, not code.
The same rules are in skill `ghorc:lead` (`/ghorc:lead`) and in the `CLAUDE.md` section from
`templates/CLAUDE-section.md`.

## Who is the lead

`GHORC_ROLE` is optional. A main session (no `agent_id` in the hook input) without `GHORC_ROLE` is the lead:
SessionStart prints `role=lead` and `lead: load skill ghorc:lead`. A subagent is recognized by `agent_id` and
prints `role=agent`. Set `GHORC_ROLE` only in two cases:

- `GHORC_ROLE=worker` for a herdr worker session: no lead reminder, no watchdog, heavy commands denied.
- `GHORC_ROLE=lead` for the optional strict mode: `readGuard.leadNoMedia` (the lead may not read PDFs and images)
  and `heavyGuard.requireLeadEnv` (heavy commands need this marker) apply only then.

`lead.remind: false` turns the reminder off for a plain main session; `GHORC_ROLE=lead` always gets it.

Start the lead with an explicit model and effort (`lead.model`, `lead.effort`), for example
`claude --model opus --effort medium`. Keep `CLAUDE_CODE_EFFORT_LEVEL` unset: it overrides role frontmatter and the
`effort` of a call.

## One package in five steps

1. `/ghorc:lead` loads the lead rules.
2. `ghorc:scout` (effort `low`) collects the facts into a file.
3. Write the brief with `/ghorc:brief`; start `ghorc:implementer` (effort `medium`) in its own worktree.
4. Accept the report by diff and check output; send the diff to `ghorc:reviewer`, or to `ghorc:reviewer-critical` if
   it touches `criticalPaths`.
5. On `ACCEPT` the lead runs `checks.full` once, in the background, on the final tree, then merges.

## Roles (`agents/`, called as `ghorc:<role>`)

Tool sets: **edit** = Read, Edit, Write, Grep, Glob, Bash; **review** = Read, Grep, Glob, Bash, Write.

| Role | Model / effort | maxTurns | Tools | Purpose |
|---|---|---|---|---|
| `ghorc:implementer` | sonnet / medium | 120 | edit | code, tests, documents from a brief |
| `ghorc:reviewer` | sonnet / medium | 100 | review | ordinary diff review; writes only the review file |
| `ghorc:scout` | sonnet / low | 40 | review | read-only facts with `file:line`, into a file |
| `ghorc:reviewer-critical` | opus / high | 100 | review | adversarial review: money, contracts, hooks, policy |
| `ghorc:integrator` | sonnet / medium | 100 | edit | merge conflicts, red checks on an accepted branch |
| `ghorc:release` | sonnet / medium | 100 | edit | version, changelog, tag; only on the owner's word |
| `ghorc:consult` | sonnet / low | 60 | Read, Write, Bash, browser MCP | asks external models in a browser |
| `ghorc:media` | sonnet / low | 30 | Read, Grep, Write, Bash | the only subagent role that reads PDFs and images |

The first three are the core set; the others are for projects that need them. Browser MCP for `ghorc:consult`:
`mcp__chrome-devtools__*`, `mcp__claude-in-chrome__*`. `ghorc:media` needs poppler (`pdftotext`, `pdftoppm`) for PDFs.
No role spawns subagents; every role reads `<project>/CLAUDE.md` and `.claude/ghorc.json` itself. Plugin skills and
agents are namespaced by Claude Code, so they cannot collide with your own.

## Skills

| Skill | What it does |
|---|---|
| `/ghorc:lead` | lead rules: one-page rules, routing, effort, thresholds, SendMessage vs a new agent |
| `/ghorc:orc` | alias of `/ghorc:lead`, kept for 0.5 only |
| `/ghorc:brief` | brief structure (7 tags), content by effort, 3 templates, antipatterns, report limits |
| `/ghorc:status` | role, guards, heavy patterns, watchdog, context numbers and recent denials in one block |
| `/ghorc:handoff` | writes STATE.md and hands the shift over; with herdr, into a new tab ([handoff.md](handoff.md)) |
| `/ghorc:setup` | runs `setup.cjs --check`, shows the table, applies confirmed items |

## Rules on one page

1. The lead is Opus/medium; model and effort are set explicitly at launch (`--model opus --effort medium`); a global
   fallback does not replace this for a role.
2. The implementer is Sonnet/medium; money, recovery, migrations: Sonnet/high.
3. Ordinary review and re-check of fixes of an ordinary package: Sonnet/medium. Critical review: Opus/high in round 1;
   on a critical package the final verdict and the check of money findings are Opus/high, Sonnet checks only
   non-critical findings.
4. Opus again if a fix changes a money invariant.
5. Haiku/low only for mechanical work with a machine-checkable result; not browser work, not scouting.
6. Fable is the arbiter of a disputed question or a consultation; not the lead and not the default reviewer.
7. Small things (at most 2 commands, output at most 100 lines, no package code edits) the lead does itself;
   anything bigger goes to a file or an agent.
8. On every Agent call the lead passes `effort` explicitly. When the implementer model equals the reviewer's default
   model, pass `model` on the reviewer call so that they differ, and say so in the brief.
9. The lead does not read PDFs, images, transcripts, logs or files over 100 lines whole (a diff by `--stat` and by
   file); attachments go as a file path to `ghorc:media`; PDFs are converted to text/PNG first. This is an
   instruction; the hook enforces it only with `GHORC_ROLE=lead`.
10. The lead does not write package code, does not run checks synchronously, does not poll agents.
11. The lead reads its context with `ctx.cjs --session <id>` at a stage boundary: 120K - refresh STATE; 150K - take
    no new package, hand the shift over; ~170K - hand over at the nearest stage boundary.
12. Do not pull large output in; if it was pulled in, the owner runs `/rewind`. The lead does not use `/clear`.
13. In chat at most 25 lines; an agent report at most 25 lines (review at most 30); anything large goes to a file.
14. A brief is one tagged structure: ordinary at most 500 words, critical review at most 800; over 200 lines is a
    task-statement error.
15. Checks only through the project commands (`checks`); a bare test runner and `full` are forbidden for agents.
16. `full`: one run, on the final tree, lead only, in the background, after fast; it runs on the merge SHA and the
    report quotes that SHA; if incomplete, find the cause first and restart only the failed phase.
17. Review limit is 3 rounds; a second `CHANGES_REQUIRED` means the lead rewrites the task instead of resending it.
18. There is no sub-lead; direct Agent calls by default; a herdr worker when a separate process or owner interaction
    is needed.
19. At most the lead plus 2 workers in total; one heavy check per machine.
20. A consultation is "significant" on any of: money/data/recovery, an external contract or migration, a
    hard-to-reverse dependency, a conflict of key requirements, two failed approaches. Format: an answer plus a
    critic, one round.

## Routing and effort

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

## Thresholds

| Value | Source | Action |
|---|---|---|
| 120K tokens | `thresholds.ctxPrepare` | refresh STATE at the next stage boundary |
| 150K tokens | `thresholds.ctxHandoff` | take no new package; `/ghorc:handoff` at the package boundary |
| ~170K tokens | rule 11 | hand over at the nearest stage boundary |
| 18 | `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | context fill percentage at which autocompaction runs |

The token thresholds are applied by the lead (skills), not enforced by a script. The 18 is a percentage of the
context window: check `context_window_size` in `ctx.cjs` (18% of 1M is about 180K; of 200K about 36K).

## Brief

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

The effort goes on the Agent call (`effort: "medium"`), not in the brief. A smaller, runnable example is
[examples/demo/briefs/fix-slugify.md](../examples/demo/briefs/fix-slugify.md) with its
[expected report](../examples/demo/expected-report.md).

## How to accept a report

- The first line is `STATUS: DONE | HANDOFF | BLOCKED` (implementer, integrator, release) or a verdict
  `ACCEPT | ACCEPT_WITH_NOTES | CHANGES_REQUIRED | BLOCKED` (reviewers). Details belong in a file, not the report.
- Accept by facts: the SHA exists, `git diff --stat <base>..<sha>` stays inside `<you_own>`, every check comes with
  its command and output. "Unverified" items and "Suggestions" are the lead's decision.
- `CHANGES_REQUIRED` needs a P0/P1 finding with `file:line` and a reproduction. A clarification on the same task (at
  most 5 calls, within an hour) goes by SendMessage to the same agent; otherwise a new agent works from the diff. A
  second `CHANGES_REQUIRED` means a new brief. An agent cut off by `maxTurns` is resumed once, then BLOCKED.

## State

`STATE.md` (template `templates/STATE.md`, 40-80 lines) holds the package and stage, branch and SHA, `head` and
`seq`, `in_flight`, decisions, blockers, checks, authority and `unanswered_owner_messages`. It is the source of truth,
not the conversation. While a background `full` runs, the lead waits for the notification and does not poll.

## Setup items

`/ghorc:setup` (or `setup.cjs --check`, then `--apply <ids>`) handles these items:

| Item | Target | Recommended |
|---|---|---|
| `statusLine` | `~/.claude/settings.json` | `node "<plugin>/scripts/statusline.cjs"`, `refreshInterval` 30 |
| `statusLineStale` | `~/.claude/settings.json` | check only: older plugin-cache path; same fix as `statusLine` |
| `pct` | global `settings.json`; `--project`: `settings.local.json` | `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = `"18"` |
| `idle` | `~/.claude/settings.json` | `idleCompaction` = `false` (no compaction while the lead waits) |
| `model` (owner decision) | `~/.claude/settings.json` | `model` = `lead.model` |
| `effort` (owner decision) | `~/.claude/settings.json` | `effortLevel` = `lead.effort` |
| `config` | `<project>/.claude/ghorc.json` | copied from the short template if missing |
| `claudemd` | `<project>/CLAUDE.md` | `templates/CLAUDE-section.md` appended if the marker is missing |
| `exclude` | git `info/exclude` (via `git rev-parse --git-path`) | lines `.claude/ctx-*.json`, `.claude/ghorc-out/` |
| `heavy` (warning) | `<project>/.claude/ghorc.json` | proposed `heavyCommands` from `package.json` scripts |
| `watchdog` (warning) | `<project>/.claude/ghorc.json` | `watchdog.autostart` = `true`, only if you want it |

`heavy` proposes regexes from the script names in `package.json` of the project root and `app/` (test, e2e, build and
lint names). It never proposes a pattern that matches `checks.fast`, and drops `test:x` when `test` is proposed.
`--check` lists the proposals; `--apply heavy` prints and writes them. `heavy` and `watchdog` are warning items:
they never make `--check` unclean and `--apply all` skips them, so name them. `--apply all` does include `model` and
`effort`. `pct` is GLOBAL (every project) unless `--project` is given. `--apply` first copies `settings.json` to
`settings.json.ghorc-<timestamp>.bak`, changes only the listed keys and prints a diff. Changes take effect in a new
session. `GHORC_HOME` overrides the home directory (used by tests).

What the plugin cannot do, so you do:

- **statusLine.** A plugin cannot install it; use setup or add by hand to `~/.claude/settings.json`:
  `"statusLine": {"type": "command", "command": "node \"<plugin>/scripts/statusline.cjs\"", "refreshInterval": 30}`.
- **Config and CLAUDE.md content.** Setup copies templates; check commands, `heavyCommands` (after the proposal) and
  `criticalPaths` are yours.
- **Lead launch** with explicit `--model`/`--effort`; keep `CLAUDE_CODE_EFFORT_LEVEL` unset.
- **Global model, effort and cache TTL** are owner decisions; setup sets model/effort only when named, cache TTL never.
- **herdr** (for handoff in a tab) and **poppler** (for `ghorc:media`) are installed separately.

`<plugin>` is the plugin directory: your clone (local path or `--plugin-dir`), otherwise the `installPath` in
`~/.claude/plugins/installed_plugins.json`. Inside skills it is `${CLAUDE_PLUGIN_ROOT}`.

## Templates (`templates/`)

`ghorc.json` (the short project config; every key is in [configuration.md](configuration.md)), `CLAUDE-section.md`
(section for the project `CLAUDE.md`, first line is the marker `<!-- ghorc -->`), `STATE.md` (lead state, 40-80
lines), `HANDOFF.md` (shift handoff, at most 50 lines).
