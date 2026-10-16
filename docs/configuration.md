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
  "criticalPaths": []
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

### thresholds
Lead context in tokens. `ctxPrepare` (120000): refresh STATE.md. `ctxHandoff` (150000): take no new package and hand
the shift over (skill `ghorc:handoff`).

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
60 s). `statePath` and `handoffPath`: the STATE and HANDOFF files.

### criticalPaths
Critical areas of the project (money, contracts, policy, hooks). Edits there go to `ghorc:reviewer-critical`.
Example: `["src/billing/**", "POLICY.md"]`.

## Environment variables
- `GHORC_ROLE`: optional. Empty on a main session means `lead`. `worker` marks a herdr worker (no lead reminder, heavy
  commands denied). `lead` switches on the strict mode (`leadNoMedia`, `heavyGuard.requireLeadEnv`).
- `GHORC_TMP`: overrides the state directory `<tmp>/ghorc-<user>`.
- `GHORC_NO_AUTOSTART=1`: SessionStart never starts the watchdog.

## Denial log
Every deny from the read guard and the heavy-check guard appends `<iso time> <session8> <hook> <reason>` to
`<tmp>/ghorc-<user>/denials.log` (7 days are kept). `/ghorc:status` shows the last 5 lines and the counts per hook.
