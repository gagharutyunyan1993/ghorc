# With and without a terminal backend (hc, herdr)

ghorc supports two terminal backends, either or both installed separately, and works without both:
`hc` (herdr-app, `HC_TERMINAL_ID` set in its terminals) and the older `herdr` CLI (`HERDR_ENV=1`). Before any tab or agent
command run `node scripts/backend.cjs`: it prints `hc`, `herdr` or `none` (`hc` wins if both are set; `herdr` counts only
while `herdr agent list` answers). The hooks and the skills use the same detection. The rest of this page describes the
`herdr` forms; the `hc` forms are in skills/lead/SKILL.md ("Terminal backend") and skills/handoff/SKILL.md.

| | `hc` | `herdr` |
|---|---|---|
| worker with a role | `hc run --bg --name n --cwd d "<path>\env.exe" GHORC_ROLE=worker claude.exe ... "<task>"` | `herdr tab create --env GHORC_ROLE=worker` + `herdr agent start` |
| wait / read / send / close | `hc wait n` / `hc read n` / `hc send n "..."` / `hc kill n; hc rm n` | `herdr agent wait` / `read` / `herdr pane run` / close tab |

**Without herdr** everything except the handoff tab works through the Agent tool: roles, hooks, status line,
watchdog, `/ghorc:lead`, `/ghorc:brief`, `/ghorc:status`, `/ghorc:setup`. `/ghorc:handoff` writes STATE.md and prints
the `/clear` fallback ([handoff.md](handoff.md#without-herdr)).

**With herdr** you also get `/ghorc:handoff` into a new tab and worker sessions with their own process and effort.
Inside herdr (`HERDR_ENV=1`) every package, every review and the integrator run as a separate herdr tab (a worker)
with a report file; an Agent call is only for scouting up to about 5 minutes and for writing memory, because
background agents inside the lead are invisible to the owner. Tab workers do not reach the ledger. Start
workers with `GHORC_ROLE=worker`, so they get no lead reminder, start no watchdog, never get the lead's handoff block,
and are treated as subagents by the heavy guard (heavy commands and agent starts denied). The variable must be set
when the tab is created:

```
herdr tab create --label <name> --cwd <dir> --env GHORC_ROLE=worker    # note result.root_pane.pane_id
herdr agent start <name> --kind claude --pane <pane_id> -- --model sonnet --effort medium
```

`herdr agent start` types the `claude` command into an existing pane's shell, so `GHORC_ROLE=worker herdr agent start`
(or `$env:GHORC_ROLE='worker'; herdr agent start`) sets the variable on the herdr CLI only and the session never sees
it. Checked live on herdr 0.9.5: in a tab created with `--env GHORC_ROLE=worker` the pane shell had the variable; with
the variable set only before `herdr agent start` the session's `GHORC_ROLE` was empty. Check the first worker's
SessionStart line: it must print `role=worker`. Do not tell a worker from the lead by the tab name.

The read guard does not apply the media rule to a worker session (it has no `agent_id`), so a worker may read images
and PDFs within the budgets. The limit (`capacity.agents` when the capacity guard is enabled, else the lead plus 2 workers in total)
counts agents and workers together.

Subagents and workers may not run `herdr agent start|prompt|send-keys` or `herdr pane run|send-keys|send-text`: only
the lead starts sessions and sends prompts.
