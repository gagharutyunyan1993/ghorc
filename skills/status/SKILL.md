---
name: status
description: Show the ghorc state in one short block - role, active guards, heavy patterns, watchdog, context numbers and recent denials. Use for "ghorc status" or to check that the guards are working.
user-invocable: true
---
# ghorc status

Run these and report one block of at most 12 lines. Do not paste raw output.

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.cjs" --check --status` (add `--cwd <project>` if the session is not in the project).
   It prints the role, the guards, the heavy patterns, the watchdog state and the denial log (last 5 lines, counts per hook).
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs" --session <id>`, where `<id>` is the `session=` value of the SessionStart
   line or the `#id` status line segment. It prints the context numbers and unread watchdog alerts.

Report: role (`lead` unless `GHORC_ROLE` says otherwise), guards active (read guard, heavy guard), heavy patterns
(count, or "none: the heavy guard denies nothing"), watchdog (on/off, running or not), context (tokens against
`thresholds.ctxPrepare` and `ctxHandoff`), denials (last 5, counts per hook). Name what is missing and the fix
(`/ghorc:setup`). Change nothing.

## Ledger

The ledger is `<project>/.claude/ghorc-out/ledger.jsonl`: one line per subagent call (written by the PostToolUse hook on
`Agent`) and one line per verdict (written by you).

- `/ghorc:status` also runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.cjs" report` (optional `--since <ISO>`, `--json`)
  and shows its output as is: per role calls, median and upper-quartile tokens and ms, mean tools, share of calls whose
  resolved model differs from the requested one; per package the rounds and the first-round verdict; the first-round
  ACCEPT rate and cause counts. An empty ledger prints `no ledger yet`.
- `/ghorc:status --verdict E123 1 CHANGES_REQUIRED REASONING_FAILURE` runs
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.cjs" verdict E123 1 CHANGES_REQUIRED REASONING_FAILURE`
  (`<pkg> <round> <ACCEPT|CHANGES_REQUIRED> [cause]`; exit 2 and a usage line on bad arguments). Record one verdict per
  review round; on CHANGES_REQUIRED give the cause.

Cause codes:

- `BRIEF_OMISSION`: the brief lacked the fact or the check the agent needed.
- `SKIPPED_CHECK`: the agent did not run a check it could have run.
- `REASONING_FAILURE`: the brief was complete and the agent reasoned wrong (the only cause that raises effort).
- `OTHER`: none of the above (network, out of memory, wrong command; never raises effort).
