# Configuration reference

The project config is `<project>/.claude/ghorc.json`. `/ghorc:setup` copies a short template
(`templates/ghorc.json`) there. Every key is optional: a missing key keeps the default listed below
(`scripts/lib/defaults.json`). Objects merge key by key; arrays and scalars replace the default. Keys that start with
`_comment` are ignored. `node scripts/check-config.cjs` validates the file (types, unknown keys, regex syntax).

## Full annotated config

```json
{
  "checks": { "fast": "", "full": "" },
  "heavyCommands": [],
  "readGuard": {
    "maxRepeat": 3,
    "maxImageBytes": 2097152,
    "leadNoMedia": true,
    "mediaRoles": ["ghorc:media", "media"],
    "pdfPageBudget": 60,
    "mediaByteBudget": 8388608,
    "maxScreenshots": 60
  },
  "heavyGuard": { "requireLeadEnv": false, "agentsWhenFree": false },
  "heavySlots": { "slots": 0, "minFreeRamGb": 0 },
  "thresholds": { "ctxPrepare": 235000, "ctxHandoff": 265000 },
  "lead": { "model": "opus", "effort": "medium", "remind": true },
  "watchdog": {
    "autostart": false,
    "intervalSec": 30,
    "rateMiBPerMin": 10,
    "warnMiB": 100,
    "stopMiB": 250
  },
  "handoff": {
    "allowSendKeysExit": false,
    "candidatePermissionArgs": [],
    "readyTimeoutMin": 10,
    "statePath": "STATE.md",
    "handoffPath": "HANDOFF.md"
  },
  "review": { "maxFixRounds": 2 },
  "backend": { "prefer": "hc" },
  "worker": { "permissionArgs": [] },
  "tabs": { "enabled": true, "maxWorkers": 3, "idleMin": 10, "overtimeMin": 45, "stopBlock": true, "notify": true },
  "criticalPaths": [],
  "capacity": {
    "enabled": false,
    "agents": 3,
    "cpuStartPct": 60,
    "minFreeRamGb": 4,
    "weeklyCapPct": 0,
    "agentsOverPace": 0,
    "idleMarker": "Idle:",
    "leadNamePrefix": "lead-"
  }
}
```

## Keys

### checks
Project check commands. Agents run only `fast`; the lead runs `full` (one at a time, in the background).

### heavyCommands
Regex strings (case-insensitive) of commands that subagents and `GHORC_ROLE=worker` sessions may not run. Each is
matched at the start of a command segment (the command is split on `&&`, `||`, `;`, `|`, newlines and so on), after env
assignments, shell wrappers and an `npm run` or `npx` prefix. Write `"^npm\\s+run\\s+test:e2e\\b"`. An empty list means
the guard denies nothing. `/ghorc:setup` proposes a list from the `package.json` scripts (root and `app/`) and writes it
only after you confirm (`setup.cjs --apply heavy`). Every script whose name contains test, e2e, full, build, lint or
typecheck becomes `npm run <name>` (`npm test` for `test`), unless `checks.fast` already matches that pattern, so a
project with `test` and `test:full` gets `test:full` proposed even when `npm test` is its fast check. No new keys.

### readGuard
- `maxRepeat` (3): reads of one file allowed between edits of it, per agent. A file changed by someone else starts a
  new count.
- `maxImageBytes` (2097152): largest image a media role may read.
- `leadNoMedia` (true): a main session started with `GHORC_ROLE=lead` may not read PDFs and images. A plain main session
  (no `GHORC_ROLE`) reads them freely.
- `mediaRoles` (`ghorc:media`, `media`): agent types that may read media. Other subagents are denied.
- `pdfPageBudget` (60): PDF pages per agent. `mediaByteBudget` (8 MiB): image bytes per agent.
- `maxScreenshots` (60): MCP screenshot, snapshot and read_page calls per agent.

### heavyGuard
`requireLeadEnv` (false): when true, heavy commands are also denied unless the process has `GHORC_ROLE=lead`.

`agentsWhenFree` (false): when true and `heavySlots.slots` is above 0, a subagent or worker may start a heavy command while
a slot is free and is denied only when all slots are taken ("heavy-check slots are full", with the holders). False keeps
the rule that only the lead runs heavy checks. With `slots` 0 the key does nothing.

### heavySlots
Limit on heavy checks running at once on the machine. Off by default.
- `slots` (0): 0 = off, 1 to 8. A value above 8 is clipped to 8 with a warning (`heavy-slot.cjs status`, and in the
  text of a hook deny); a negative or non-integer value switches slots off.
- `minFreeRamGb` (0): free RAM needed to take a slot above the first (0 = no check).

The lock is `scripts/heavy-slot.cjs run --label <text> -- <command>`; the heavy-check hook only denies early, when
every slot holds a live claim of another session ([hooks.md](hooks.md#heavy-check-slots-scriptsheavy-slotcjs)).
Call the wrapper from `checks.full`, from the project directory, for example
`"full": "node \"<plugin>/scripts/heavy-slot.cjs\" run --label full -- \"npm run test:full\""` (on Windows `npm` is a `.cmd`: write `npm.cmd` with separate arguments, or one string as here). The claim's session is
`--session`, else `$GHORC_SESSION`, else `$CLAUDE_CODE_SESSION_ID` (set by Claude Code in the shell tools' environment,
equal to the id the hook sees), else `pid-<parent pid>`, so with no setup the lead's own claim is its own.
`--minutes <n>` marks a claim that runs longer than announced in `status` (it is not removed).

### thresholds
Lead context in tokens, enforced by the context guard hook (`scripts/context-guard.cjs`, [hooks.md](hooks.md)).
`ctxPrepare` (235000): the guard adds an "update STATE" line. `ctxWarn` (0 = `ctxHandoff` - 10000): "prepare the
handoff, take no new packages". `ctxHandoff` (265000): handoff mode - no new agent, edits only to `handoff.statePath`
and `handoff.handoffPath`, Stop blocks until STATE is newer than the flag (at most 2 times; skill `ghorc:handoff`).
With `handoff.stickyOnCompact` a compaction starts the same mode too, whatever the token numbers say. Set
autocompact at `ctxHandoff` + 35K or a little above, never at or below `ctxHandoff` (`/ghorc:setup` item `pct`
recommends `ctxHandoff` + 35K as a share of the window, rounded up; 1M window: 30%; on a window smaller than `ctxHandoff` + 35K, for example 200K, set `ctxHandoff` lower by hand), otherwise a compaction
resets the counter before the guard reacts.

### lead
`model` (`opus`) and `effort` (`medium`): used by `/ghorc:handoff` for the candidate and by `/ghorc:setup`. `fable` is the lead model for a major refactor, a migration or many packages in parallel ([models.md](models.md)); the owner may also name it for one shift at a handoff. Effort precedence: env `CLAUDE_CODE_EFFORT_LEVEL` > per-call `effort` > role frontmatter > session; model precedence: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` > per-call `model` > role frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL`; keep the variables unset and pass `model` and `effort` on every Agent call. Global advice: no top-level `effortLevel` in `~/.claude/settings.json`; per-model medium for the lead model (setup finds its full id in the ctx file of the newest session, so no version is pinned).
`remind` (true): SessionStart reminds a main session to load skill `ghorc:lead`. Workers
(`GHORC_ROLE=worker`) and subagents get no reminder.

### watchdog
The transcript watchdog is off by default. `autostart` (false): when true, SessionStart starts one detached watchdog
per project root (pid file and heartbeat in `<tmp>/ghorc-<user>`). Opt in with `/ghorc:setup` (`--apply watchdog`);
stop it with `node scripts/watchdog.cjs --stop`. `intervalSec` (30): poll period. `rateMiBPerMin` (10): growth alarm.
`warnMiB` (100): size that asks you to check the content. `stopMiB` (250): size alarm if the file still grows.
Alerts go to `<tmp>/ghorc-<user>/alerts-<root hash>.log`; `scripts/ctx.cjs --session <id>` shows unread ones.

### handoff
Standing owner permissions for `/ghorc:handoff`. `allowSendKeysExit` (false): the new lead may send `/exit` to the old
tab through herdr. `candidatePermissionArgs` (`[]`): permission-mode arguments for the candidate;
`[]` starts it with default permissions, `["--permission-mode", "acceptEdits"]` with edits only, `["--permission-mode",
"bypassPermissions"]` without prompts. `readyTimeoutMin` (10): minutes the old lead waits for READY (polled every
60 s). `statePath` and `handoffPath`: the STATE and HANDOFF files. `pushGuard` (false): in handoff mode the hook denies
`herdr agent start` from the lead while a branch named in STATE `in_flight` (`branch: <name>`) is ahead of or missing
on `origin` (`node scripts/unpushed.cjs [--branches a,b]` lists them: local refs, no network, exit 1 when any); no
`in_flight` branch field means nothing is checked (the hook adds a reminder), and neither does a repository without an
`origin` remote or a branch that origin's fetch refspec does not cover. The default branch is never required.
`stickyOnCompact` (false): sticky handoff. A compaction (SessionStart, source `compact`) writes the handoff flag; only
`HANDOFF.md` with `status: SENT` and `old_session_id` equal to the session clears it; Stop blocks the lead once per
turn until then (a repeat block within 60 s passes). A flag caused by a compaction denies and blocks only a session
with `GHORC_ROLE=lead`, or a session without `GHORC_ROLE` whose terminal proves it is a lead: on `hc`
(`hc get <own id>`) the terminal name starts with `capacity.leadNamePrefix` or the terminal has no parent; on `herdr`
(`herdr agent list`) the tab label starts with that prefix as configured (`lead-` matches `lead-next45`, not `leaderboard-ui`). `GHORC_ROLE=worker` is
never a lead, whatever the tab is called. A lookup that fails, is slow (about 1.5 s at most) or finds no backend proves
nothing and the session gets the reminder only; the lookup runs only when `GHORC_ROLE` does not answer. Every other
session (a worker, or one that is not proven) gets a reminder only. Leads started by the owner should still run with
`GHORC_ROLE=lead`. `statePath` and `handoffPath` are resolved from the root of the session's own git worktree (a lead
branch in a linked worktree keeps `HANDOFF.md` there, not in the main checkout); outside a linked worktree that is the
project root, as before. Off or absent: a compaction changes nothing and Stop
behaves as in 0.7.0.

The permission mode of the candidate and of every worker is the owner's choice, asked by `/ghorc:setup` (item
`permissions`, `--apply permissions --mode <bypass|acceptEdits|prompts>`, which writes this key and
`worker.permissionArgs`); until then both are `[]` and an unattended tab stops on each prompt. Under `bypass` the hooks
still deny (verified: a worker's heavy check is denied under `--permission-mode bypassPermissions`), deny rules still
apply, and critical-path removals and `AskUserQuestion` still stop the session. `/ghorc:setup` item `bypassPrompt`
(owner decision, applied only when named, never by `--apply all`) sets `skipDangerousModePermissionPrompt` so the first bypass start does not stop on the one-time
warning. `setup.cjs --check` prints an information line saying whether the project sets the key.

### backend
`prefer` (`"hc"`): which terminal backend wins when both are present in a session (`HC_TERMINAL_ID` set and `HERDR_ENV=1`
with a herdr server that answers). `"hc"` is the 0.9.0 behaviour; `"herdr"` makes the `herdr` CLI win. With only one
backend present that one is used whatever the key says, and with `"herdr"` a herdr server that does not answer leaves
`hc`. Any other value fails `check-config.cjs`. `node scripts/backend.cjs` prints the answer.

### worker
`permissionArgs` (`[]`): permission arguments for terminal workers the lead starts; `[]` for default
permissions, `["--permission-mode", "acceptEdits"]` for edits only, `["--permission-mode", "bypassPermissions"]` for no
prompts; an array of strings, validated by `check-config.cjs`. Same notes as `handoff.candidatePermissionArgs`; only
`setup.cjs --apply permissions --mode <m>` writes it (both keys, the owner's answer). The tabs guard checks that every
worker start carries it.

### tabs
The tabs guard (`scripts/tabs-guard.cjs`, [hooks.md](hooks.md)) for the lead's terminal tabs on hc or herdr.
`enabled` (true): off, the guard neither denies nor reports. `maxWorkers` (3, 1..20): agent tabs allowed at once
(long-lived `full`, `runner`, `train` tabs do not count); a start beyond it is denied. `idleMin` (10): minutes idle
without a result line before a worker is reported STALLED. `overtimeMin` (45): minutes of runtime before it is reported
OVERTIME (the stop-loss of an agent). `stopBlock` (true): Stop is blocked once while a worker is BLOCKED or FINISHED but
still open. `notify` (true): on herdr, a worker turning BLOCKED shows a herdr notification once. `devCommands` (array of regex
strings; default list in `scripts/lib/defaults.json`; each must compile, `[]` turns the rule off): dev servers and watchers
(`npm run dev|start|serve|watch`, `vite`, `next dev`, `docker compose up` without `-d`, `tsc --watch`, `flask run`, ...) are denied in
every session on hc and herdr unless started in a `<pkg>-runner` tab; one-shot commands (`npm run build`, `npm test`, `vite build`,
`docker compose up -d`) are not matched; a pattern that does not compile is dropped and reported by `check-config.cjs`. On herdr the
lead's tab commands stay in its own workspace (the prefix of `HERDR_PANE_ID`): `herdr tab create` needs `--workspace` of the own workspace
(the exact `$HERDR_WORKSPACE_ID` or its id) and `--no-focus`, and the lead may not create, close or start in another workspace. The whole guard
acts only in a project that has `.claude/ghorc.json`. The naming, model,
effort and permission rules it enforces are in skill `ghorc:lead`, section "Tabs".

### review
`maxFixRounds` (2): fix rounds per package before the lead stops resending the implementer. After that comes a cheap
closure check (closed or not closed with evidence per finding, plus a scan of the fix diff for new P0/P1), not a full
re-review. P0/P1 still open after the last round: the package is blocked and the lead narrows the task.

### criticalPaths
Critical areas of the project (money, contracts, policy, hooks). Edits there go to `ghorc:reviewer-critical`.
Example: `["src/billing/**", "POLICY.md"]`.

Project roles: if the project has `.claude/agents/*.md`, `setup --check` lists them on the `claudemd` item and
`--apply claudemd` appends a table of them (name, model / effort from the frontmatter, first sentence of the
description) under the roles table of the CLAUDE.md section. Those roles take precedence over the `ghorc:*` roles for
the same purpose; the lead launches them by name with explicit `model` and `effort`, and the critical reviewer may be
the project's own role at opus / high (fable / medium on work implemented by Opus). Without `.claude/agents/` nothing changes.

### capacity
The capacity guard (`scripts/capacity-guard.cjs`, [hooks.md](hooks.md#capacity-guardcjs)) keeps an idle lead working.
Off by default. `enabled` (false): switch the hook on. `agents` (3): the ceiling; Stop demands more work while the
lead has fewer running agents (subagents, teammates and terminal workers of `hc` or `herdr`). `cpuStartPct` (60): demand work only while
the average CPU is below it. `minFreeRamGb` (4): and free RAM is at least this. `weeklyCapPct` (0 = off): at this
share of the weekly limit no new agents are demanded. `agentsOverPace` (0 = off): while the weekly use is above
`weeklyCapPct` times the elapsed share of the week, demand work only below this many agents. `weeklyAgentsStepPct`
(0 = off): from this share of the weekly limit the agent limit is at most `agentsOverPace` (needs `agentsOverPace` > 0).
`weeklyNoNewPct` (0 = off): from this share the prompt line says to start no new packages and only finish and merge
what is in flight, and Stop no longer raises the "machine underloaded" block. Both steps act only on fresh data (not
on a stale value, see [hooks.md](hooks.md#capacity-guardcjs)). Each is 0..100 and, when non-zero, they must climb:
`weeklyAgentsStepPct` <= `weeklyNoNewPct` <= `weeklyCapPct`; a violation is a config error. `idleMarker` (`Idle:`):
a line starting with it and a reason lets the turn end. `leadNamePrefix` (`lead-`): herdr panes and hc terminals with this name
prefix are lead sessions and are not counted as workers (empty: none excluded).

## Environment variables
- `GHORC_ROLE`: optional. Empty on a main session means `lead` for most hooks; the sticky handoff block treats a roleless session as a lead only when its terminal proves it (see `stickyOnCompact`). `worker` marks a terminal worker (no lead reminder, heavy
  commands denied, reminder-only context guard). For a herdr tab set it with `herdr tab create --env GHORC_ROLE=worker`,
  not before `herdr agent start` (it would not reach the session); with `hc run` (no `--env`) put `env GHORC_ROLE=worker`
  in front of the program. `lead` switches on the strict mode (`leadNoMedia`, `heavyGuard.requireLeadEnv`) and is the sure way to make a session a lead for
  `handoff.stickyOnCompact`. The value is trimmed and lowercased (`Worker` is `worker`).
- `GHORC_TMP`: overrides the state directory `<tmp>/ghorc-<user>`.
- `GHORC_NO_AUTOSTART=1`: SessionStart never starts the watchdog.
- `GHORC_CAPACITY_CPU_PCT`, `GHORC_CAPACITY_FREE_GB`, `GHORC_CAPACITY_HERDR_JSON`, `GHORC_CAPACITY_HC_JSON`, `GHORC_HC_BIN`, `GHORC_HERDR_BIN`, `GHORC_CAPACITY_LEDGER`,
  `GHORC_CAPACITY_SAMPLE_MS`: test seams of the capacity guard ([hooks.md](hooks.md#capacity-guardcjs)).
- `GHORC_SESSION`: the session id `heavy-slot.cjs run` writes into its claim (also read by `ctx.cjs`); without it
  `CLAUDE_CODE_SESSION_ID` is used.
- `GHORC_SLOT_STALE_MS` (120000), `GHORC_SLOT_HEARTBEAT_MS` (15000), `GHORC_SLOT_LOCK_WAIT_MS` (2000),
  `GHORC_TEST_FREE_RAM_GB`: for tests of the slots.

## Denial log
Every deny from the read guard and the heavy-check guard appends `<iso time> <session8> <hook> <reason>` to
`<tmp>/ghorc-<user>/denials.log` (7 days are kept). `/ghorc:status` shows the last 5 lines and the counts per hook.
