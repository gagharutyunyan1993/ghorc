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
  "heavyGuard": { "requireLeadEnv": false },
  "heavySlots": { "slots": 0, "minFreeRamGb": 0 },
  "thresholds": { "ctxPrepare": 120000, "ctxHandoff": 150000 },
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

### heavySlots
Limit on heavy checks running at once on the machine. Off by default.
- `slots` (0): 0 = off, 1 to 8. A value above 8 is clipped to 8 with a warning (`heavy-slot.cjs status`, and in the
  text of a hook deny); a negative or non-integer value switches slots off.
- `minFreeRamGb` (0): free RAM needed to take a slot above the first (0 = no check).

The lock is `scripts/heavy-slot.cjs run --label <text> -- <command>`; the heavy-check hook only denies early, when
every slot holds a live claim of another session ([hooks.md](hooks.md#heavy-check-slots-scriptsheavy-slotcjs)).
Call the wrapper from `checks.full`, from the project directory, for example
`"full": "node \"<plugin>/scripts/heavy-slot.cjs\" run --label full -- npm run test:full"`. The claim's session is
`--session`, else `$GHORC_SESSION`, else `$CLAUDE_CODE_SESSION_ID` (set by Claude Code in the shell tools' environment,
equal to the id the hook sees), else `pid-<parent pid>`, so with no setup the lead's own claim is its own.
`--minutes <n>` marks a claim that runs longer than announced in `status` (it is not removed).

### thresholds
Lead context in tokens, enforced by the context guard hook (`scripts/context-guard.cjs`, [hooks.md](hooks.md)).
`ctxPrepare` (120000): the guard adds an "update STATE" line. `ctxWarn` (0 = `ctxHandoff` - 10000): "prepare the
handoff, take no new packages". `ctxHandoff` (150000): handoff mode - no new agent, edits only to `handoff.statePath`
and `handoff.handoffPath`, Stop blocks until STATE is newer than the flag (at most 2 times; skill `ghorc:handoff`).
With `handoff.stickyOnCompact` a compaction starts the same mode too, whatever the token numbers say. Set
autocompact above `ctxHandoff` (`/ghorc:setup` item `pct`), otherwise a compaction resets the counter before the
guard reacts.

### lead
`model` (`opus`) and `effort` (`medium`): used by `/ghorc:handoff` for the candidate and by `/ghorc:setup`. Effort precedence: env `CLAUDE_CODE_EFFORT_LEVEL` > per-call `effort` > role frontmatter > session; keep the variable unset and pass `effort` on every Agent call. Global advice: no top-level `effortLevel` in `~/.claude/settings.json`; per-model medium for sonnet-5.5 and opus-5.5.
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
tab through herdr. `candidatePermissionArgs` (`[]`): permission-mode arguments for the candidate, for example
`["--permission-mode", "acceptEdits"]`. `readyTimeoutMin` (10): minutes the old lead waits for READY (polled every
60 s). `statePath` and `handoffPath`: the STATE and HANDOFF files. `pushGuard` (false): in handoff mode the hook denies
`herdr agent start` from the lead while a branch named in STATE `in_flight` (`branch: <name>`) is ahead of or missing
on `origin` (`node scripts/unpushed.cjs [--branches a,b]` lists them: local refs, no network, exit 1 when any); no
`in_flight` branch field means nothing is checked (the hook adds a reminder), and neither does a repository without an
`origin` remote or a branch that origin's fetch refspec does not cover. The default branch is never required.
`stickyOnCompact` (false): sticky handoff. A compaction (SessionStart, source `compact`) writes the handoff flag; only
`HANDOFF.md` with `status: SENT` and `old_session_id` equal to the session clears it; Stop blocks the lead once per
turn until then (a repeat block within 60 s passes). A flag caused by a compaction denies and blocks only a session
with `GHORC_ROLE=lead`; every other session (a worker, or one without `GHORC_ROLE`) gets a reminder only. So
enabling it requires that leads run with `GHORC_ROLE=lead`. Off or absent: a compaction changes nothing and Stop
behaves as in 0.7.0.

`candidatePermissionArgs` can bypass permission prompts (for example `--dangerously-skip-permissions`), so setting it is
the project's explicit decision. `setup.cjs --check` prints an information line saying whether it is set;
`setup.cjs --apply` never writes it.

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
the project's own role at opus / high. Without `.claude/agents/` nothing changes.

### capacity
The capacity guard (`scripts/capacity-guard.cjs`, [hooks.md](hooks.md#capacity-guardcjs)) keeps an idle lead working.
Off by default. `enabled` (false): switch the hook on. `agents` (3): the ceiling; Stop demands more work while the
lead has fewer running agents (subagents, teammates and herdr workers). `cpuStartPct` (60): demand work only while
the average CPU is below it. `minFreeRamGb` (4): and free RAM is at least this. `weeklyCapPct` (0 = off): at this
share of the weekly limit no new agents are demanded. `agentsOverPace` (0 = off): while the weekly use is above
`weeklyCapPct` times the elapsed share of the week, demand work only below this many agents. `idleMarker` (`Idle:`):
a line starting with it and a reason lets the turn end. `leadNamePrefix` (`lead-`): herdr panes with this name
prefix are lead sessions and are not counted as workers (empty: none excluded).

## Environment variables
- `GHORC_ROLE`: optional. Empty on a main session means `lead`. `worker` marks a herdr worker (no lead reminder, heavy
  commands denied, reminder-only context guard). For a herdr tab set it with `herdr tab create --env GHORC_ROLE=worker`,
  not before `herdr agent start` (it would not reach the session). `lead` switches on the strict mode (`leadNoMedia`, `heavyGuard.requireLeadEnv`) and is required for
  `handoff.stickyOnCompact`. The value is trimmed and lowercased (`Worker` is `worker`).
- `GHORC_TMP`: overrides the state directory `<tmp>/ghorc-<user>`.
- `GHORC_NO_AUTOSTART=1`: SessionStart never starts the watchdog.
- `GHORC_CAPACITY_CPU_PCT`, `GHORC_CAPACITY_FREE_GB`, `GHORC_CAPACITY_HERDR_JSON`, `GHORC_CAPACITY_LEDGER`,
  `GHORC_CAPACITY_SAMPLE_MS`: test seams of the capacity guard ([hooks.md](hooks.md#capacity-guardcjs)).
- `GHORC_SESSION`: the session id `heavy-slot.cjs run` writes into its claim (also read by `ctx.cjs`); without it
  `CLAUDE_CODE_SESSION_ID` is used.
- `GHORC_SLOT_STALE_MS` (120000), `GHORC_SLOT_HEARTBEAT_MS` (15000), `GHORC_SLOT_LOCK_WAIT_MS` (2000),
  `GHORC_TEST_FREE_RAM_GB`: for tests of the slots.

## Denial log
Every deny from the read guard and the heavy-check guard appends `<iso time> <session8> <hook> <reason>` to
`<tmp>/ghorc-<user>/denials.log` (7 days are kept). `/ghorc:status` shows the last 5 lines and the counts per hook.
