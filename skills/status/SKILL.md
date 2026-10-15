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
