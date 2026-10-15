---
name: brief
description: How to write a brief for a subagent - tagged structure, content by effort level, three templates (implementer, critical reviewer, mechanical work), antipatterns. Use when writing a task brief for an agent.
user-invocable: true
---
# Brief

The same structure for every role; the question changes, not the form. An ordinary brief is at most 500 words, a critical review at most 800, over 200 lines is a task-statement error. An Agent call always carries an explicit `effort`.

| Tag | Purpose |
|---|---|
| `<role>` | Who the agent is and what it does not do (it spawns no subagents) |
| `<context>` | Why the task exists, what is already decided; no history |
| `<read_first>` | Files and lines to start from (`file:line`) |
| `<you_own>` | What the agent may change |
| `<steps>` | What to do, in order |
| `<constraints>` | Invariants, prohibitions, check commands |
| `<report_back>` | Report format and length |

## Content by effort
- low: the rule, the scope, the check.
- medium: the behavior and the done-criteria.
- high: the invariants and dangerous scenarios.

## Style
- For Sonnet: explicit `file:line`; "every" only where it really is every; a file over 400 lines - question first.
- Take check commands from `checks` in the project config (`.claude/ghorc.json`); do not invent them (`eslint --fix`, `prettier --write`).
- Do not ask for reasoning to be returned. Large output goes to a file, the report gives the path.
- Agents read `<project>/CLAUDE.md` and the config themselves; do not retell them in the brief.
- Reports, scratch and large outputs go to `<project>/.claude/ghorc-out/` (setup git-excludes it); name it in `<report_back>`.
- Reviewer model must differ from the implementer's; when the default would be equal, pass `model` on the Agent call and say so in `<context>`.

## Template 1. Implementer (`ghorc:implementer`, medium or high)
```
<role>You are the implementer of task <ID>. You work alone and spawn no subagents.</role>

<context>
<one or two sentences: what behavior change is needed and why>
Starting tree: <branch / SHA>. Working directory: <worktree>.
</context>

<read_first>
- <file:line> - <why to read it>
</read_first>

<you_own>
<files and modules that may be changed. Everything else goes only to the "Suggestions" section of the report.>
</you_own>

<steps>
1. <step>
2. <step>
3. Checks: <the checks.fast command>
Done when:
- <a verifiable result>
</steps>

<constraints>
- <invariants, compatibility, prohibitions (paid calls, release, other people's branches)>
- Do not widen the task with incidental refactoring.
- Checks only through <command>; do not run full or the whole test suite; reuse already valid results for the same tree.
- After two failed fixes of the same cause stop guessing: return observations, hypotheses and the next step.
</constraints>

<report_back>
STATUS: DONE | HANDOFF | BLOCKED. Then: SHA; behavior change; checks with output and links; unverified items; blockers; next step; suggestions. Up to 25 lines, the rest goes to file <path> (under `.claude/ghorc-out/`).
</report_back>
```

## Template 2. Critical reviewer (`ghorc:reviewer-critical`, high, round 1)
```
<role>You are the adversarial reviewer of <ID>. You do not change product files and you spawn no subagents.</role>

<context>
Range: <base SHA>..<head SHA>.
Existing evidence: <check results, SHA/tree, environment, links>.
</context>

<read_first>
Start with the diff. Widen reading to the affected dependencies, calling code and contracts:
- <file:line>
</read_first>

<you_own>The review file <path>. Only that.</you_own>

<steps>
1. Check the invariants:
   - <invariant>
2. Check the dangerous scenarios:
   - <failure/retry/recovery relevant to the change>
3. Do not repeat a valid fast on the same tree. Run only the missing targeted checks through <command>.
4. For each finding: severity; file:line; the violated requirement; conditions; consequence; proof; minimal fix. Separate a confirmed defect from a hypothesis. CHANGES_REQUIRED only for P0/P1 with file:line and a reproduction (or `UNREPRODUCED` with the reason a reproduction is impossible).
5. Do not add new requirements to improve the architecture.
</steps>

<constraints>
- full and the whole test runner without arguments are forbidden.
- The budget does not permit closing P0/P1.
</constraints>

<report_back>
Verdict: ACCEPT / ACCEPT_WITH_NOTES / CHANGES_REQUIRED / BLOCKED.
All substantiated findings go to the review file <path under .claude/ghorc-out/>. In the answer: blockers, scope of the check, gaps. Up to 30 lines.
</report_back>
```

## Template 3. Mechanical work (Haiku, low)
```
<role>You perform one mechanical operation. Do not widen the task and do not start other agents.</role>

<context>Why the result is needed: <one line>.</context>

<read_first>Input: <specific files or data>.</read_first>

<you_own>Result: <format, or the allowed diff / output file path>.</you_own>

<steps>
1. Do: <an unambiguous operation>.
2. Scope: <exact boundaries>.
3. Check: <command or rule>.
</steps>

<constraints>If the input does not match the description - BLOCKED with the reason. Assume nothing.</constraints>

<report_back>The result in the stated format; up to 10 lines.</report_back>
```

## Antipatterns
| Antipattern | Why it is bad |
|---|---|
| "Understand the code and suggest improvements" (Sonnet) | Reads many files, returns generalities |
| "Check everything" (Opus) | Runs the full test suite in every round |
| A brief over 200 lines | Expensive start and a blurred task |
| Asking for reasoning to be returned | Output tokens settle in the lead window |
| Invented check commands | Checks go only through the config `checks` |
| A brief without `file:line` for Sonnet | The agent looks for entry points itself |

## Report limits
Agent to lead at most 25 lines, review at most 30; large output goes to a file, the report gives the path. Lead to owner: the result first, at most 25 lines.
