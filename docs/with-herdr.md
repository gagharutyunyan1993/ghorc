# With and without herdr

herdr is a terminal multiplexer for coding agents, installed separately. ghorc does not need it.

**Without herdr** everything except the handoff tab works through the Agent tool: roles, hooks, status line,
watchdog, `/ghorc:lead`, `/ghorc:brief`, `/ghorc:status`, `/ghorc:setup`. `/ghorc:handoff` writes STATE.md and prints
the `/clear` fallback ([handoff.md](handoff.md#without-herdr)).

**With herdr** you also get `/ghorc:handoff` into a new tab and worker sessions with their own process and effort.
Use a worker when a task needs a separate process or owner interaction; direct Agent calls stay the default. Start
workers with `GHORC_ROLE=worker`, so they get no lead reminder, start no watchdog, and are treated as subagents by the
heavy guard (heavy commands and agent starts denied):

```
# bash
GHORC_ROLE=worker herdr agent start <name> --kind claude -- --model sonnet --effort medium
# PowerShell (the variable stays set for the rest of this shell)
$env:GHORC_ROLE='worker'; herdr agent start <name> --kind claude -- --model sonnet --effort medium
```

Whether herdr passes the variable to the child session is not verified: check the first worker's SessionStart line.
If it prints `role=lead`, the variable did not arrive.

The read guard does not apply the media rule to a worker session (it has no `agent_id`), so a worker may read images
and PDFs within the budgets. The limit "the lead plus 2 workers in total" counts agents and workers together.

Subagents and workers may not run `herdr agent start` or `herdr agent prompt`: only the lead starts sessions.
