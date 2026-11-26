# Changelog

## 0.11.3 - 2026-11-27

### Fixed
- A lead's message to a worker could stay unsent in the worker's input box while the lead waited on an idle worker.
  After every send the lead now checks delivery before it waits: a bounded wait for `working`, then the screen, one
  `send-keys enter` when the text is still in the box, never a second send, and a blocked, unknown or busy worker gets
  no send (the Enter would answer its dialog). `docs/workflow.md` says the same.
- The old lead's tab stayed open after a handoff. HANDOFF now carries an `old_lead:` line (agent name, pane id, tab id)
  that the old lead writes from its own ids, and the new lead checks that pane (not its own, listed, last reply
  `HANDOFF SENT - STOP`) before `/exit`. If the pane is still listed afterwards and shows `idle`, `done` or no agent,
  the new lead closes it with `herdr pane close`; a working, blocked or unknown pane is reported, not closed. The
  owner's permission texts (setup, configuration, handoff) name the pane close beside `/exit`.
- The prompt line `agents N (workers M)/K` counted agents of every project on the machine but did not say so, and a lead
  read it as its own limit. It now reads `agents N (workers M)/K machine-wide`; the lead skill says it is a load
  indicator and that the limit on a lead's own workers is `tabs.maxWorkers`. Counting is unchanged.
- A new lead could prepare for a long time before its first dispatch. The handoff and lead skills now say that after
  ACTIVATE the lead keeps bookkeeping to the listed steps and dispatches the first open step to a worker without
  waiting for the owner, because long preparation spends the context the handoff just freed.
- SessionStart output was cut mid-text at 299 characters, and with two watchdog alerts the cut removed the line that
  tells the lead to load its skill. The output is now built from whole lines with a fixed priority: whole lines are
  dropped from the lowest priority up (alert details, alert count, CLAUDE.md hint, setup hint, ...), the identity, the
  lead reminder and `config invalid` always stay, nothing is cut inside a line, and a shortened output ends with
  `+more: run ctx`. The limit is unchanged.
- The lead's reading rule said files over 100 lines must not be read "whole", and a lead that read a long file in two
  passes took itself for a violator. It now says a range of up to 100 lines is fine when the lead needs that text
  itself, and that a transcript, log, diff or long file as a whole goes to a scout because it fills the lead's context.
  The "already read 3 times" deny points to a scout for a long file. No hook was added.

### Not run against a live herdr
- The key name `enter` in `herdr pane send-keys <pane> enter` and that it submits text sitting in the input box.
- What `herdr agent get <pane_id>` prints for a pane that holds no agent (the text only says "no agent").
- That `herdr pane close <pane_id>` removes a pane left behind after `/exit`.
- That the old lead's agent name and tab id are read from `herdr agent get $HERDR_PANE_ID` and `$HERDR_TAB_ID`.

## 0.11.2 - 2026-11-25

### Added
- `/ghorc:setup` item `leadTabClose` (warning item and owner decision, never part of `all`): asks who closes the old
  lead's tab after a handoff. `--apply leadTabClose --closer <lead|owner>` writes `handoff.allowSendKeysExit` (true for
  `lead`, false for `owner`, the default). The row is ok once the project file holds a boolean value (it asks once);
  with the key absent it is a non-failing warning "not chosen" (templates/ghorc.json carries no such key, so a new
  project starts there), and a non-boolean value is a warning naming it as invalid.

### Fixed
- The lead skill said the old lead closes itself in the handoff flow, which contradicts the handoff skill: the old lead
  cannot run `/exit`, so the new lead closes the old tab when `handoff.allowSendKeysExit` is true or the owner's
  standing permission is recorded in STATE, otherwise the owner. The lead and handoff skills, `docs/handoff.md`,
  README and `docs/workflow.md` now say the same.
- With `handoff.allowSendKeysExit` false the new lead now says once, right after activation, which tab is idle and
  waiting to be closed, and that `leadTabClose` lets it close the tab from the next handoff on.
- `docs/configuration.md` described `allowSendKeysExit` for herdr only; it now covers hc (`hc kill` and `hc rm`) and
  states why the default is false: a standing permission for one session to end another, and on hc closing the old
  lead also kills its children started without `--outlive-parent`.

## 0.11.1 - 2026-11-25

### Fixed
- `/ghorc:setup` item `statusLineStale` recognised a stale status line only under `~/.claude/plugins/`; a plugin cache
  in another config dir (a second profile such as `~/.claude-work`, `CLAUDE_CONFIG_DIR`) was never flagged, so the
  status line could stay on an old version that writes ctx files into the project, where the hooks no longer read them.

## 0.11.0 - 2026-11-25

Models and effort re-derived from Anthropic's guide "Which Claude model should you build with?" (Nov 2026).

### Added
- `docs/models.md`: the single source of which model and start effort each role and class of work gets, the next
  step when it falls short, and the guide row (or the reason ghorc departs from it) for every line; the escalation
  order, the cascade, mixing models, and why the lead's context stays small.
- Role `ghorc:log-reader` (haiku / medium): reads test output and logs, writes one line per failing case (file, test,
  first error line verbatim) to a file; never edits, runs or diagnoses.
- `/ghorc:setup` item `explore` (opt-in, never part of `all`): writes `<project>/.claude/agents/Explore.md` on haiku
  from `templates/Explore.md`, because the built-in Explore runs on the session's model; an existing file is left as
  it is, and the project-roles table of `claudemd` skips it.
- Ledger cost estimate: `done` lines carry `cost` (USD at list prices), `models`, `unpriced` and `cacheTtlAssumed`,
  priced per assistant message from `scripts/lib/prices.cjs` (Haiku tiered by prompt length, cache writes by TTL,
  fast mode at 2x); `ledger.cjs report` prints cost per role and an `estimated cost` line, `--json` adds `costTotal`,
  `costCalls`, `unpricedCalls`, `pricesAsOf`.
- methodology-toolkit as a dependency: the ghorc marketplace lists it (a `git-subdir` source from its own repository,
  where it stays maintained) and the ghorc entry declares `"dependencies": ["methodology-toolkit"]`, so
  `claude plugin install ghorc@ghorc` installs both. The lead uses its `red-team-critic` as the critic of a significant
  consultation, its `evidence-scout` for sourced product and vendor facts (both with an explicit model; routing rows in
  `docs/models.md`) and its `methodology-driven-thinking` skill for its own judgement calls. The dependency is declared
  in the marketplace entry only, so `--plugin-dir` runs of ghorc load without it.
- Tabs guard (`scripts/tabs-guard.cjs`, `scripts/lib/tabs.cjs`, config `tabs`, on by default in a project that has
  `.claude/ghorc.json`; silent everywhere else) for the lead's hc and herdr tabs. It denies a tab or worker start that breaks the rules, with the corrected form: names
  `[a-z][a-z0-9-]{0,31}` (herdr's agent-name rule), `lead-<slug>` or `<pkg>-<role>` (`<pkg>-full|runner|train` for long-lived
  commands); the role env (`GHORC_ROLE=worker` or `lead`); `-n <name>` so the session, terminal title and `/resume`
  carry the tab name; `--model` as an alias (a versioned id is denied) and `--effort`; the configured permission
  arguments; no duplicate live name; at most `tabs.maxWorkers` agent tabs; `--outlive-parent` for long-lived hc tabs.
  For the lead it lists the live workers on every prompt and at session start (`tabs: N live (...)`) and flags BLOCKED
  (waits on a dialog), FINISHED (result line written, tab still open: close it), STALLED (`tabs.idleMin`), OVERTIME
  (`tabs.overtimeMin`) and OVER_LIMIT, and shows RESULT? (a result line found at first sighting), UNKNOWN (a status
  it does not know) and BADNAME (a live agent of the project whose name breaks the rule); Stop is blocked once per
  tab and flag while a worker is BLOCKED or FINISHED, never after HANDOFF `status: SENT` or in a candidate lead; on herdr a worker
  turning BLOCKED shows a herdr notification once. Skill `ghorc:lead` has the new section "Tabs: open, name, watch,
  close"; the documented start forms carry `-n <name>`. `/ghorc:status` shows the guard's settings.
- Runner tabs for long-running processes: dev servers and watchers (`tabs.devCommands`, a default list of 20 patterns:
  `npm run dev|start|serve|watch|preview`, vite, next/nuxt/astro dev, nodemon, `--watch` builds, `docker compose up`
  without `-d`, artisan/rails/flask/uvicorn/runserver, `dotnet watch`, `node --watch`, `ng serve`, gatsby, hugo, storybook) are denied as direct or background commands
  for every session on hc or herdr. The lead gets the runner-tab form (`<pkg>-runner`, then `herdr pane run`); a
  worker or subagent is told to end BLOCKED with the command. One-shot commands (`npm run build`, `vite build`,
  `docker compose up -d`, tests) stay allowed. The worker roles say the same.
- herdr workspace confinement: `herdr tab create` needs `--workspace` of the lead's own workspace
  (`$HERDR_WORKSPACE_ID`, taken from the prefix of `HERDR_PANE_ID`) and `--no-focus`, `herdr pane split` needs
  `--no-focus`; the lead may not create, close or start anything in another workspace, nor create or close workspaces
  (reading, prompting and sending keys to another workspace stay allowed for the owner's cross-session work); the inventory, limit and duplicate checks count
  only the own workspace. Without it, herdr creates a tab in the UI-focused workspace, which may be another project's
  lead's.
- Tabs guard, herdr: `herdr worktree create|open|remove`, `herdr pane move` and a create, close or start aimed at another
  session, machine or host (`--session`, `--machine`, `--remote`) are denied for the lead; list entries belong to their
  `workspace_id` (from `herdr api schema`), the pane id prefix being the fallback. The lead skill waits for a runner with
  `herdr pane wait-output --regex` and reads `agent_not_ready` and `agent_prompt_stalled` before acting again.
- `/ghorc:setup` item `bypassPrompt` (warning item and owner decision, applied only when named, never by `--apply all`): `skipDangerousModePermissionPrompt` = true in the user settings, so
  the first worker started in bypassPermissions does not stop on the one-time warning dialog.
- Verdict cause `CASCADE`: the planned re-run of a cascade failure; it never counts as a reasoning failure, and a
  package whose first verdict carries it is left out of the first-round ACCEPT rate.
- Git guard (`scripts/git-guard.cjs`, config `git.guard`, off by default; `/ghorc:setup` item `gitGuard`, never part of
  `--apply all`): PreToolUse on Bash and PowerShell, for every session (lead, worker, subagent). It denies `--no-verify`
  (and `git commit -n`), force push (`--force`, `-f`, `--force-with-lease`, `+refspec`), push to a protected branch
  (`git.protectedBranches`, default `main` and `master`, in any spelling, and `--all`/`--mirror`), push without an
  explicit remote and branch (bare push, `HEAD`, `@`, a variable or a glob), and writing `core.hooksPath` or `alias.*`
  (`git config`, `git -c`). Each deny names the rule and the safe form (`git push -u origin <feature-branch>`).
- CI retry guard (`scripts/ci-retry-guard.cjs`, config `ciRetry`, off by default; `/ghorc:setup` item `ciRetry`):
  PreToolUse on Bash, PowerShell and MCP retry tools (`mcp__*retry_pipeline|retry_job|play_job|rerun|retry*`). CI
  restarts (`glab ci retry|run|trigger`, `gh run rerun`, `gh workflow run`, the REST retry endpoints) are counted per
  project in `.claude/ghorc-out/ci-retry-ledger.jsonl`: within `windowHours` (24) the first `freeRetries` (1) pass, the
  next need a fresh `.claude/ghorc-out/ci-retry-reason.md` (what failed, the error signature, why a retry and not a fix;
  written within 30 minutes and after the last restart), and from `hardCap` (3) every restart is denied with "report to
  the owner". The ledger is a plain, unprotected file.
- `scripts/lib/cmd.cjs` exports `variants()` (the wrapper-peeled forms of a segment) for the git guard.
- Ledger: main sessions. SessionStart writes a `session` line (id, role, transcript path), SessionEnd a totals
  snapshot; `ledger.cjs report` prices the lead, tab workers and candidate leads from their transcripts, one row per
  session kind (from the `-n` name) and model, with message ids deduplicated across a resume and sidechain rows
  skipped, and prints `estimated cost with sessions`. Until now only subagents were priced, while the lead is
  usually the biggest item.
- Agent guard (`scripts/agent-guard.cjs`, PreToolUse `Agent|Task`, on by default in opted-in projects, key
  `agentGuard.enabled`): the lead's Agent calls name a model, and the built-in `Explore`, `Plan` and `general-purpose`
  agents (which run on the session's model) are denied unless the project defines its own.
- Setup item `effortGlobal` (warning, owner decision): a top-level `effortLevel` and per-model values above medium for
  models other than the lead's make every session and subagent without an explicit effort run high; `--apply
  effortGlobal` removes the top-level key and sets the others to medium.

### Changed
- **Agent guard:** a call without `subagent_type` (it starts general-purpose) and `subagent_type: fork` (the lead's
  whole context at the lead's model; a per-call model is ignored) are denied too; the reason for the built-in agents
  is the missing report contract, and the session model only when no model is passed.
- **Critic of a significant decision:** `red-team-critic` runs on opus/medium in a fresh context even for an Opus-made
  plan; Fable/medium only for a migration, data-model or external-contract decision. The critical reviewer of Opus
  work stays on Fable/medium; the "another model" rule is documented as ghorc's own, not the guide's.
- `docs/models.md`: why the handoff point stays at 265K (cost per turn is flat between about 150K and 265K; fewer
  handoffs and the 25K handoff budget decide).
- Literal NUL bytes in `scripts/ledger.cjs` and ESC bytes in a test are written as escapes, so git and grep treat the
  files as text.
- **Model guide audit:** cascade failures re-run at `high` (the guide's measured form); the money and recovery
  implementer moves past high to Opus/medium with the critical reviewer on Fable/medium; scout, media and
  evidence-scout start at medium (the model's default, per the guide's row for search and summary subagents); the
  critical review of Opus work runs on Fable at medium and the closure check at medium; brief Template 3 (Haiku) never
  produces a code diff; log-reader stays under 100K tokens of input (Haiku's price tier); the lead's effort and fast
  mode change only at a handoff, like its model; setup item `model` recommends `opus` as the global model even for a
  Fable lead (the lead starts with `--model`); a routing change follows the guide's method (same tasks, 2-3 effort
  levels, a single-model baseline, not lower on score and lower on cost, then a shadow run); the tabs guard's
  corrected form takes model and effort from the role in the tab name. Docs: alias caveats outside the Anthropic
  API, Fable and Opus share the cache-read price, the cache TTL cost of a long pause.
- **ctx files out of the project:** the status line writes `<os tmp>/ghorc-<user>/ctx/<root hash>/ctx-<session>.json`
  instead of `<project>/.claude/ctx-<session>.json`; the context guard, `ctx.cjs`, the capacity guard and setup read
  there. Session start deletes the old project files whatever their age (in projects with `.claude/ghorc.json`); in
  others delete `.claude/ctx-*.json` by hand. Setup item `exclude` now needs only `.claude/ghorc-out/`.
- **Only projects that opted in:** every hook (read guard, heavy guard, context guard, session start, capacity guard,
  call ledger, tabs guard) and the status line's ctx file act only where `.claude/ghorc.json` exists. ghorc installs at
  user scope, and before this a project that never ran `/ghorc:setup` still got denies (a 4th read, an Edit past
  `ctxHandoff`), five SessionStart lines and `.claude/ctx-*.json` files that its git did not exclude. The status line is
  still shown everywhere (it is a user setting). `/ghorc:setup` item `config` opts a project in.
- **Context thresholds:** `ctxPrepare` 235000 and `ctxHandoff` 265000 (were 120000 and 150000), so `/ghorc:setup` item
  `pct` recommends autocompact at 30% of a 1M window (was 19%). The lead keeps almost twice the context; on Opus a
  turn's cache read then costs about $0.05 instead of $0.03. On a window smaller than `ctxHandoff` + 35K set
  `ctxHandoff` lower by hand; the recommendation is capped at 95.
- **Permission mode:** the owner chooses it at `/ghorc:setup`: new item `permissions` (warning item, owner decision,
  never part of `--apply all`) asks `bypass`, `acceptEdits` or `prompts`, and `--apply permissions --mode <m>` writes
  both `worker.permissionArgs` and `handoff.candidatePermissionArgs`. The defaults stay `[]`; a lead whose project has
  not chosen gets a SessionStart reminder. ghorc's hooks still deny under bypass (verified live: a worker's heavy check
  is denied). `SECURITY.md` has a section on it.
- **Routing:** migrations and performance optimization go to an Opus/medium implementer with a Fable/medium critical
  reviewer (a clear spec alone does not justify Sonnet there); a major migration to Fable/medium. Money and recovery
  stay Sonnet/high with an Opus/high critical reviewer.
- **Lead:** Opus/medium by default; Fable/medium for a major refactor, migration, architecture plan, many parallel
  packages or a long unattended run (`lead.model: fable`). The lead's model changes only at a handoff (new section in
  `ghorc:handoff`), never with `/model` in a running lead.
- **Haiku** starts at medium (its default) and is used only where a mistake is cheap to spot: `log-reader` and
  mechanical work with a machine check (brief Template 3).
- **Escalation** follows the guide: verification first, then one effort level, then the next model up at medium.
  `xhigh` and `max` are no longer used by default; the critical reviewer's `xhigh` step is replaced by the Fable
  arbiter at medium.
- The lead passes `model` as well as `effort` on every Agent call and does not start the built-in `Explore`, `Plan` or
  `general-purpose` agents; work that fits one context and is one dependent chain goes to one implementer.
- The Routing table in `ghorc:lead` gains a "next step" column; `docs/workflow.md` points to `docs/models.md` instead of
  repeating the table.
- **No model versions are pinned:** roles, skills, docs and config use only the aliases `haiku`, `sonnet`, `opus`,
  `fable`, which Claude Code resolves to the newest model of each family. `/ghorc:setup` item `effort` no longer maps
  aliases through a fixed table: it takes the full id of the lead model from the newest ctx file of the project (the
  status line records the model each session ran on) and writes nothing until one session has run on it. The ledger's
  price table is the one place with model ids; a model missing from it is reported as unpriced.

### Fixed
- One project root reached by two spellings (a link or junction, a Windows 8.3 short name such as `RUNNER~1` next to
  the long name git prints) gave two ctx hashes, so the context guard found no ctx file and handoff mode never started;
  `sessionRoot` took a plain checkout for a linked worktree, and the handoff edit check compared spellings. All three now
  use `canonPath` (`scripts/lib/root.cjs`: realpath.native of the path or its nearest existing ancestor). The status
  line of an older ghorc writes under the old hash until it is updated too.
- `tests/tabs-guard.test.cjs` expected the Windows form of the corrected `hc run` command on every platform.


## 0.10.0 - 2026-11-12

### Added
- `heavy-slot.cjs run -- npm.cmd <args>` on Windows (.cmd/.bat with separate arguments, quoted by fixed rules; `"`, `%`, line breaks and a quoted trailing `\` are refused with a message).
- `heavyGuard.agentsWhenFree` (default false): agents and workers may start a heavy check while a heavy slot is free.
- `backend.prefer` (`"hc"` default, or `"herdr"`): which terminal backend wins when both are present in a session; with `"herdr"` a herdr server that does not answer leaves hc. Validated.
- `worker.permissionArgs` (`[]`): permission arguments for the workers the lead starts (read by the skills; no hook reads it). Validated as an array of strings.
- `capacity.weeklyAgentsStepPct` (0 = off): from this weekly usage the agent limit drops to `agentsOverPace`. `capacity.weeklyNoNewPct` (0 = off): from this usage the prompt line says no new packages, only finish and merge what is in flight, and Stop does not demand more work. The cap wins over both; the steps never fire on stale or missing data and work with `weeklyCapPct` 0. Validation: each of the three keys is 0..100 and, when non-zero, step <= noNew <= cap (a violation is a config error; 0..100 for `weeklyCapPct` is new too).
- Proven lead (`provenLead` in `scripts/lib/role.cjs`): a session with no `GHORC_ROLE` counts as the lead when its terminal proves it (hc: the terminal name starts with `capacity.leadNamePrefix` or it has no parent; herdr: this session's agent name starts with the prefix as configured, dash included). `GHORC_ROLE=worker` is never a lead and asks nothing. The lookup is lazy, takes at most 1.5 s (`GHORC_TOOL_TIMEOUT_MS`) and never throws; a failed one is "not proven". The capacity guard's Stop uses it too (it used the role only).
- Skills and templates: `--outlive-parent` for long-lived hc tabs, tab names, closing after acceptance and children at handoff; the herdr `agent wait` form with three `--until` and `--timeout`; `DONE`/`BLOCKED`/`HANDOFF` and `VERDICT` last lines in the agents, brief templates and example; a stop-loss line; the fate of each review finding; STATE (8192 bytes) and HANDOFF (3072 + 1600 acceptance block) limits; `backend.prefer` and `worker.permissionArgs` in the lead and handoff skills.

### Changed
- **Default behaviour change:** a roleless lead on hc/herdr (no `GHORC_ROLE`, terminal named `lead-*` or without a parent) is now blocked in sticky mode (`handoff.stickyOnCompact`) after a compaction, as `GHORC_ROLE=lead` was before. A worker (`GHORC_ROLE=worker`) and a session whose lookup fails are never blocked.
- `STATE.md` and `HANDOFF.md` are resolved against the root of the session's own worktree (`sessionRoot` in `scripts/lib/root.cjs`): inside a linked git worktree the worktree's top level, before the main checkout. With `CLAUDE_PROJECT_DIR` set it is that directory whatever the cwd; elsewhere the project root as before. Ctx files and watchdog alerts stay under the project root.
- The heavy matcher reads stdin scripts (`bash <<EOF`, `echo ... | sh`, `| xargs`), quoted/pathed/.cmd programs, call operator, PowerShell assignment, shell keywords, wsl/corepack/cross-env/eval/env -S/gtimeout, `-EncodedCommand`, `npm t|exec|x`, `npx -y`, line continuations, glued quotes. Only adds matches.
- Autocompact advice is `ctxHandoff` + 35K (was + 20K): `/ghorc:setup` item `pct` recommends 19% of a 1M window (was 17%; 93% of 200K, was 85%). The skills and docs name the context thresholds by key (`ctxPrepare`, `ctxWarn`, `ctxHandoff`) instead of numbers; with no agents in flight `ctxWarn` starts the handoff at once.
- Test environment: `runScript` clears `HC_TERMINAL_ID` and `HERDR_ENV`, so hook tests never reach a real hc or herdr.

### Removed
- From "Known": the `.cmd`/`.bat` argument-list limitation of `heavy-slot.cjs run` (see 0.9.0).

### Fixed
- `sessionRoot` follows `CLAUDE_PROJECT_DIR` when it is set: a lead started in the main checkout whose cwd drifted into a linked worktree edits and is released by `<main>/HANDOFF.md`, as in 0.9.0 (review finding P1).
- `capacity-guard.cjs` Stop reads HANDOFF.md through `sessionRoot`, like `context-guard.cjs`: a lead that wrote `status: SENT` is no longer told "Machine underloaded".
- herdr: the lead prefix is matched as configured (`lead-` no longer matches `leaderboard-ui`, `leads-export`, `leadtime`); a prefix configured without a dash still matches `lead1`. **Behaviour change:** a herdr tab named exactly `lead` is no longer a proven lead under the default prefix `lead-` (name it `lead-...` or set `GHORC_ROLE=lead`).

### Known
- On `hc` a terminal without a parent counts as a proven lead (an owner-opened helper session or a nested `claude` in the lead's terminal is blocked as the lead); the `hc get` output shape was not verified against a live herdr-app.
- With both backends present and a dead preferred backend the proven-lead lookup may exceed the hook timeout; the guard then fails open (no block).
- Open in the heavy matchers: `& $npm test`, `iex $x`, `base64 | sh`.

## 0.9.0 - 2026-11-05

### Added
- Two terminal backends. `scripts/lib/backend.cjs` and the CLI `node scripts/backend.cjs [--name]` decide which one is
  active: `hc` (herdr-app) when `HC_TERMINAL_ID` is set, `herdr` (the older CLI) when `HERDR_ENV=1` and
  `herdr agent list` answers, otherwise `none`; `hc` wins when both are present. The hooks and the skills use the same
  detection, and no skill claims that only one backend works.
- Capacity guard: workers are counted on the active backend (`hc ls --json`: live, `working` or `blocked`, has a
  `parent`, name not starting with `leadNamePrefix`, not this terminal; or `herdr agent list` as before). Test seams
  `GHORC_CAPACITY_HC_JSON`, `GHORC_HC_BIN`, `GHORC_HERDR_BIN`.
- Heavy-check guard: subagents and workers may not run `hc run|exec|keys|interrupt` (as they may not run
  `herdr agent start|prompt|send-keys` and `herdr pane run|send-keys|send-text`). `hc send` is denied as well, except for
  a worker (not a subagent) sending to its own parent terminal (`hc get $HC_TERMINAL_ID`) or to a live lead from
  `hc ls --json` (a live `claude-code` terminal without a parent, or named `lead-*`; a shell is never a lead, and its cwd must lie inside the project root or the parent's cwd; after a lead handover the new lead is not the
  parent); a target that is neither, or nothing readable, means deny. The command forms are read through Windows paths
  (`C:\x\hc.exe`), `env`/`env.exe` with a path and options (`-i`, `-u NAME`), quoted program paths (`& "C:\x\hc.exe"`),
  `xargs`, PowerShell `Start-Process hc -ArgumentList ...` and herdr options with a value (`herdr --session x agent start`). `handoff.pushGuard` also covers `hc run ... claude`.
- The built-in agent-start deny and the agent-start detection look through `timeout` (with `-k D`, `-s SIG`, combined
  options such as `-vk 1`, the long forms, the duration, `inf`), `nice` (`-n N`, `-N`, `--N`, `--adjustment`), `stdbuf`,
  `sudo` (case-sensitive options: `-H` and `-P` without a value, `-u U`, `-D dir`), `doas`, `setsid`, `chroot DIR`,
  `watch [-n N]`, `parallel [-j N]`, `ionice -c N`, `chrt N`, `taskset MASK`, `flock FILE` (and `flock FILE -c "cmd"`),
  `script -c "cmd"`, `find -exec|-execdir|-ok`, `Invoke-Expression`/`iex "cmd"` and `cmd /c start ["title"]`, as they
  already did through `xargs`, `env` and the shells (`scripts/lib/cmd.cjs`, `EXTRA_PREFIX`, `SUDO_PREFIX`; tests
  `tests/wrappers.test.cjs`, `tests/wrappers-fix1.test.cjs`, with the commands that must stay allowed). This closes the
  wrapper forms listed as open in 0.8.0 (E402#1); `heavyCommands` patterns are tried on the peeled command too
  (`timeout 5 npm test` is heavy), a pattern on the wrapper itself still matches. Still open, a seat belt and not a
  sandbox (`docs/hooks.md`): another binary or alias, a program path in a variable (`& $path`), run-time built commands
  (`eval`, `iex $x`, `node -e`).
- Skills `ghorc:lead` and `ghorc:handoff`: first determine the backend, then the command forms of both backends (start a
  worker with a role, wait, read, send, close, READY/ACTIVATE handoff).

### Changed
- Outside a backend (neither `HC_TERMINAL_ID` nor `HERDR_ENV=1`) no herdr process is asked and workers count as 0 (before:
  `herdr agent list` was asked whenever herdr was installed). The capacity line reads `(workers N)` instead of
  `(herdr workers N)`.

### Known
- The `.cmd`/`.bat` wrapper of `heavy-slot.cjs run` (`scripts/lib/runcmd.cjs`) listed as deferred to 0.8.1 in 0.8.0 is not
  done in 0.9.0: a `.cmd`/`.bat` first word in an argument list on Windows is still refused (exit 2), give the command as
  one string.

## 0.8.0 - 2026-11-02

### Added
- Sticky handoff, opt-in with `handoff.stickyOnCompact` (default false; off or absent, the compaction paths behave as
  in 0.7.0: no output and no flag on a compaction, Stop blocks at most 2 times and lets go once STATE is newer). On: a
  compaction (`SessionStart`, source `compact`, new matcher entry in `hooks/hooks.json`) writes the same per-session
  flag as crossing `ctxHandoff` (`handoff-<session_id>.json`, now with `compacted`). The flag is cleared only when
  HANDOFF.md has `status: SENT` and `old_session_id` equal to this session; a token number never clears it, and a
  SENT session is not flagged again by a high number. A flag caused by a compaction denies edits and agents and
  blocks Stop only for a session with `GHORC_ROLE=lead`; any other session gets a reminder only, so enable the key
  only when leads run with `GHORC_ROLE=lead`. The flag from crossing `ctxHandoff` keeps its 0.7.0 reach.
- `scripts/unpushed.cjs [--branches a,b]`: local branches ahead of or missing on `origin/<branch>` (local refs, no
  network), exit 1 when any. `handoff.pushGuard` (default false): in handoff mode the lead's `herdr agent start` is
  denied while a branch named in STATE `in_flight` (`branch: <name>`) is unpushed; no such field, no `origin` remote or
  a fetch refspec that does not cover the branch: nothing is checked (a reminder when `in_flight` names no branch).
  Skill `ghorc:handoff` gets a push-and-check step before the candidate launch.
- `ctx.cjs` prints one extra line after a compaction of the session (with `handoff.stickyOnCompact`): the number is
  unreliable and, for a lead, the handoff is due.
  The numbers themselves are unchanged.
- Capacity guard (`scripts/capacity-guard.cjs`; Stop, UserPromptSubmit, SubagentStart, SubagentStop), off by default
  (`capacity.enabled`). Stop returns the lead's turn once when agents < `capacity.agents`, CPU < `cpuStartPct` and free
  RAM >= `minFreeRamGb`, unless the last answer has a line starting with `idleMarker` (default `Idle:`) and a real
  reason. Agents: `background_tasks` of the Stop input, else the SubagentStart/Stop ledger, plus herdr workers of
  `herdr agent list` (a herdr failure keeps the hook silent). UserPromptSubmit adds `agents N/M, CPU X%, free Y GB`.
  `weeklyCapPct` and `agentsOverPace` add a weekly brake from `rate_limits.seven_day` of the status line ctx files.
  Errors go to `.claude/ghorc-out/capacity-guard.log`.
- Heavy-check slots, off by default (`heavySlots: { slots: 0, minFreeRamGb: 0 }`; 1-8, above 8 is clipped with a
  warning). `scripts/heavy-slot.cjs run --label <text> -- <command>` takes a slot (claim file `slot-<n>.json`, created
  exclusively, with pid and heartbeat; a dead pid or a stale heartbeat frees it), runs the command, passes its exit code
  and releases on exit; exit 75 and a message naming holder, label and age when no slot is free. `status`,
  `release --session <id>`. Slots above the first need `minFreeRamGb` of free RAM. With slots on, `heavy-check-guard`
  also denies `heavyCommands` to the lead while every slot holds a live claim of another session (own session passes,
  read errors fail open). `checks.full` should call the wrapper. Every change of a slot file runs under a per-slot lock
  file, so one process wins a slot and a dead claim is removed without touching a live one (not guaranteed for three
  racers after a process was killed inside the lock, see `docs/hooks.md`); the claim's session
  defaults to `--session`, `$GHORC_SESSION`, `$CLAUDE_CODE_SESSION_ID`, then `pid-<ppid>`; the command is started
  without a shell (an argument list, arguments arrive unchanged), one string with spaces runs in the shell;
  `--minutes` marks an overrunning claim in `status`. On Windows an argument list whose first word is a `.cmd` or
  `.bat` is refused (exit 2, nothing runs, no slot taken): give the whole command as one string
  (`run -- "npm test"`).

### Changed
- Context guard with `handoff.stickyOnCompact` on: Stop blocks the lead once per turn until SENT (was: at most 2 times,
  released by a newer STATE); never when `stop_hook_active`; a repeat block within 60 s for the session passes; the
  reason has no token numbers and names the literal `status: SENT` and `old_session_id: <id>` lines. After a
  compaction no message quotes token numbers. A non-lead session (`GHORC_ROLE=worker`, or no role after a compaction)
  gets a reminder only. The reminder also goes to the model through the `additionalContext` of `UserPromptSubmit`.
- `HANDOFF.md` `status: SENT` is recognised with markdown noise (`**status:** SENT`, a backticked or comma-ended id).
- `in_flight` branch parsing: only a field that starts an item counts (`base branch: main` does not); main/master
  and the `origin/HEAD` branch are never required; a `###` sub-heading no longer ends the section; quoted and bold
  names are read.
- Worker role: `GHORC_ROLE=worker herdr agent start` never reached the session (`herdr agent start` types the command
  into an existing pane's shell). Checked live: the role must be set with `herdr tab create --env GHORC_ROLE=worker`.
  Skills and docs corrected (`herdr agent start` also needs `--pane <pane_id>`).
- Skill `ghorc:handoff` fallback without herdr: write `status: SENT` with `old_session_id` so the Stop block lifts.
- Review limit: at most 2 fix rounds (`review.maxFixRounds`, default 2), then a cheap closure check instead of a full
  re-review; P0/P1 open after round 2 means blocked. Replaces "3 rounds" in the lead skill, workflow, templates.
- The documented subagent ban list is now `herdr agent start|prompt|send-keys` and `herdr pane run|send-keys|send-text`.
- `setup --check` prints an information line for `handoff.candidatePermissionArgs`; `setup --apply` never writes it.

### Fixed
- `GHORC_ROLE` is read by one helper that trims and lowercases it (`worker `, `Worker` and `WORKER` are the worker
  role for the context guard, the heavy check guard, the read guard and the SessionStart line).
- A worker session without a flag returns from the context guard before the config is loaded.
- `unpushed.cjs` spawns git through the shared helper (timeout and budget).
- `ghorc:handoff`: the candidate accepts exactly the READY `seq` + 1 together with `status: SENT`.
- A ctx file that exists but is not valid JSON is reported as "found, bad JSON", not "no ctx file".
- With `handoff.stickyOnCompact` on, the sticky Stop block reaches only a session with `GHORC_ROLE=lead`; a roleless
  session with a flag from crossing `ctxHandoff` takes the 0.7.0 Stop (at most 2 blocks, released by a newer STATE).
- With the key off, a compaction-only flag left by a run with the key on counts as no flag.
- With the key on, the compaction reminder of a roleless session is added to the stage lines and watchdog alerts.
- `in_flight` parsing: a qualifier (`base`, `target`, `main`, ...) counts only when whitespace alone separates it from
  `branch`; every `branch:` field on a line is read (`branch: a, branch: b`).
- The status line prints the role through the shared role helper. SessionStart says so when the key is on and
  `GHORC_ROLE` is unset (no enforcement until `GHORC_ROLE=lead`). Skill `ghorc:handoff` corrected (Stop rule, exit 2
  and "cannot tell" of `unpushed.cjs`, the lead role of the candidate).
- Capacity guard review round 1: Stop is silent when `last_assistant_message` is not a string, when the handoff is SENT
  for the session and while the handoff flag is set; the ledger is cleared only when no `workflow`, cloud session or
  other agent-bearing task is in flight; a stopped herdr server (`server_not_running`) counts as 0 workers; ledger
  compaction keeps late events and removes its temp file on failure (`cleanup` covers it); `**Idle**: reason` counts.
- Capacity guard review round 2: `server_not_running` is read from stderr as well as stdout (herdr 0.9.5 prints it on
  stderr; stderr is piped, never shown); with a running workflow or cloud session the agent count is the larger of the
  listed subagents and the ledger; the idle-line regex no longer backtracks quadratically (100 KB of blank lines took
  16 s); the docs state that phantom agents are possible under heavy concurrency and expire in 3 hours.
- `statusline.cjs` removes its `ctx-<id>.json.<pid>.tmp` file when the rename fails (busy target on Windows) instead of
  leaving it behind. `/ghorc:setup` exclude item and `.gitignore` also cover `.claude/ctx-*.tmp`; a project excluded
  with the old two lines gets the new line proposed. `cleanup` already removes old leftovers.
- Slots: EPERM and EACCES on the exclusive create of the slot lock or the claim (Windows, a file being deleted) count as
  busy and are retried until the lock deadline; `tryTake` and `acquire` never throw. "No free slot" keeps the
  "(slot lock busy)" label. A single word that is an existing file path (with a space) is run as a program,
  `node --no-warnings ... heavy-slot.cjs` is looked through, the wrapper starts its command with `windowsHide`.
- Slots: when the root lookup times out in git (`GHORC_HOOK_GIT_TIMEOUT_MS`), the project config may have been looked up
  in the wrong place and heavy slots may read as off; `heavy-slot.cjs run` and `status` now print a warning on stderr.
  The command still runs and the exit code is the command's.
- Merge follow-ups: the capacity guard reads the worker role through the shared role helper (`worker ` and `Worker`
  are workers), and ignores a compaction-only handoff flag (`handoff.stickyOnCompact`) unless the session is
  `GHORC_ROLE=lead`, like the context guard. `/ghorc:setup` offers `stickyOnCompact` as an opt-in guard (never part of
  `--apply all`); the `heavySlots` item reads its key like the slot wrapper does (a non-integer is off).

### Changes that apply with the key off
Two changes of this branch are not gated by `handoff.stickyOnCompact`:
- `status: SENT` of the HANDOFF header is read through markdown noise (`**status:** SENT`, a comma-ended id), so a Stop
  that 0.7.0 blocked can now be silent, and only the first `status:` of the header counts.
- A ctx file that is not valid JSON is reported as "found, bad JSON" (was "no ctx file").

### Known
- Deferred to 0.8.1: the `.cmd`/`.bat` wrapper of `heavy-slot.cjs run` (`scripts/lib/runcmd.cjs`) and the bypass forms of
  the built-in agent-start deny (E402#1). What 0.8.0 does instead: a `.cmd`/`.bat` first word in an argument list on
  Windows is refused (exit 2, nothing runs, no slot taken) and the command goes in as one string
  (`run -- "npm test"`); the deny sees what it saw in v0.7.0, so herdr global options that take a value
  (`--session x`) and the wrappers `timeout`, `nice`, `stdbuf` and `xargs` stay open (listed in `docs/hooks.md`). The
  two open findings of the last review of the wrapper, unchanged:
  > P1-A, in `runcmd.cjs:22`, new in c0f0c71: `[\\/]node_modules` needs a separator before it, so a relative path misses KNOWN_SHIM. In a project: `run -- node_modules\.bin\show-argv.cmd "a(b)"`, or `node_modules/.bin/show-argv "a(b)"`: exit 2, 16 of 16 metacharacter words refused, and the message says it is not a `node_modules\.bin` shim. 6a03e71, 9cc1fc3 and fde30cf gave `["a(b)"]`, exit 0. Breaks task 2 and `docs/hooks.md:132` ("any"), for ordinary use such as `vitest -t "a (b)"`. Nothing runs, so not a security item. Expected: `(?:^|[\\/])node_modules`, with a relative case at `tests/heavy-slots-cmdargs.test.cjs:253`.

  > P1-B, in `runcmd.cjs:37`, from the rule as the brief wrote it: `set "F=%~1"`, `if "%F%"=="src\"` or `if "%~1"=="src\"`, with `run -- x.cmd src\`: exit 0 QUICK-PATH, the script reads `src\\`; expected exit 3. `%~1` to node gives `["a\\\\"]` for `a\`. A word changed silently with exit 0, the class of P1-2; `docs/hooks.md:128` says `\` arrives whole. `set` same on all refs; `if` same on 6a03e71, exit 255 on 9cc1fc3 and fde30cf. No quoting serves both: `"%~1"` and `%*` to node need the doubling, `if` must not have it. Lead's decision: refuse a trailing `\` to a `.cmd` outside the shim set, exit 2 (shims are right, node consumes it), or list it in `### Known` and correct `:128`.
- `in_flight` branch parsing (`scripts/lib/ctxguard.cjs:190`): a qualifier before bold or backticked `branch:` no longer
  counts as a qualifier, so `- w1 base **branch:** develop, branch: feat/x` reads `develop` and `feat/x` (it read only
  `feat/x`). Effect: with `handoff.pushGuard` on, a false deny while `develop` is unpushed; editing STATE clears it.
- Capacity guard idle marker (`scripts/lib/capacity.cjs:47`): `<no-break space>Idle: reason` and `Idle`, a line break,
  `: reason` are no longer accepted as an idle line (they were); the Stop is blocked until the line is retyped.
- Linux, node 24 container (same on v0.7.0): `tests/v03.test.cjs` "setup.cjs: --check finds everything missing..." and
  `tests/v051.test.cjs` "#17: applying statusLine..." fail when the checkout path does not contain `ghorc` (for example
  `/w`): setup treats a status line command as ghorc's only when it matches `/ghorc/i`. Both pass in a directory named
  `ghorc`. Not a product fault on a plugin installed as `ghorc`.
- A quoted one-string command (`node heavy-slot.cjs run -- "npm test"`) is not seen by `heavy-check-guard`, because quoted text is blanked, so the deny for subagents and workers and the lead's early hint do not apply to it; the wrapper still takes the slot. `run -- cmd /c npm test` is an argument list the guard does match.

## 0.7.0 - 2026-11-02

### Added
- Context guard (`scripts/context-guard.cjs`, hooks UserPromptSubmit, PreToolUse on every tool, Stop) for the lead: the
  thresholds `ctxPrepare` / `ctxWarn` / `ctxHandoff` are now enforced, not only written in the skills. From `ctxHandoff`
  (handoff mode, kept by a sticky flag file that compaction does not clear) a new Agent and Edit/Write outside
  `handoff.statePath` / `handoff.handoffPath` are denied; Stop blocks (at most 2 times, never when `stop_hook_active`)
  until STATE is updated. Transcript size and unread watchdog alerts are shown as lines. No ctx file, or one older than
  10 minutes, without a flag: warn only.
- `thresholds.ctxWarn` (0 = `ctxHandoff` - 10000).

### Changed
- `setup`: the recommended autocompact percentage is `ctxHandoff` + 20K as a share of the window, rounded up (17 for a
  1M window, was a fixed 18); a value that compacts at or below `ctxHandoff` is reported as wrong, so a compaction
  cannot reset the counter before the guard reacts.
- skill `ghorc:handoff`: ACTIVATE and any prompt to the candidate or a worker go through `herdr pane run <pane_id> "<text>"`,
  sent by the old lead itself (never the owner); delivery is checked by status `working` or "running UserPromptSubmit
  hooks", not by the input field (`herdr agent prompt`/`send-keys enter` could leave a grey suggestion unsent). Closing the
  old tab is a mandatory verified step 6 (`herdr agent wait` idle, `MSYS_NO_PATHCONV=1 herdr pane run <pane> "/exit"`, the
  pane is gone from `herdr pane list`). The Stop context guard stays silent once HANDOFF says `status: SENT` for the
  session, so the old lead can go idle.
- `heavy-check-guard`: the built-in subagent/worker deny now also covers `herdr pane run|send-keys|send-text` and
  `herdr agent send-keys` (the prompt channels of the lead), also behind an env prefix, `env`, `bash -c` or a binary path;
  the lead is not affected. `cleanup` removes `handoff-*.json` flags older than `maxAgeDays`. Context lines round the
  token count down (149999 reads 149K). Only the first `status:` of HANDOFF counts for a SENT header.

## 0.6.1 - 2026-10-16

- 0.6.1: `templates/CLAUDE-section.md`: a "Project roles" paragraph (project roles in `.claude/agents/` take precedence) and a
  critical reviewer line that allows the project's own role.
- `setup`: detects `.claude/agents/*.md`, reports them on the `claudemd` item and appends a ready-to-fill project roles
  table on apply; no change for projects without `.claude/agents/`.
- skill `ghorc:lead`: rule 8 (launch project roles instead of `ghorc:*`), rule 18 (sharper herdr worker criterion).

## 0.6.0 - 2026-10-16

### Added
- ledger: a PostToolUse hook on `Agent` appends one line per subagent call to `.claude/ghorc-out/ledger.jsonl`
  (`scripts/ledger.cjs hook`); `ledger.cjs verdict` records the lead's review verdicts with a cause code;
  `ledger.cjs report` and `/ghorc:status` show per-role tokens, duration and tools, and the first-round accept rate
  (overall and per class). Background calls are recorded in two stages: a `launch` line, then a `done` line with
  transcript totals from a SubagentStop hook (`ledger.cjs stop`).
- effort table with move-up conditions, cause-first escalation, per-model role lines, methodology lines (lead, brief,
  roles, docs).

### Fixed
- `setup --check` treats a missing top-level `effortLevel` as ok; `--apply effort` writes only
  `modelSettings.<full lead model id>.effortLevel` (opus -> claude-opus-5-5), never a top-level key.

## 0.5.1
Robustness fixes; no contract or config key changes.

### Fixed
- R9 The heavy guard reads the PowerShell tool and `powershell`/`pwsh -Command` with PowerShell quoting (a backslash is
  plain text), so `cd "D:\a\"; npm test` no longer hides `npm test`.
- R10 Bash heredoc bodies are not matched as commands (a subagent may write a doc that mentions `npm test`); an
  unterminated heredoc hides nothing.
- R12 All git calls share one helper with a 1 s call timeout, a 2.5 s budget and a stop after the first timeout; a
  hanging git no longer stretches SessionStart.
- R13 `setup --project` no longer fails on a broken global `settings.json`: it prints a WARN line and applies the
  project items.
- R14 The config validity cache key includes the defaults template (mtime and size), so a template change drops a
  stale verdict.
- R15 `setup --check` proposes every test/e2e/full/build/lint/typecheck script not already covered by `checks.fast`
  (the demo now gets `npm run test:full`).

### Added
- #17 `setup --apply statusLine` saves the status line it replaces in `~/.claude/ghorc-statusline-backup.json`;
  `setup --restore statusline` puts it back; `setup --check` prints `statusline: ghorc (previous saved)` or `other`.

## 0.5.0
Entries are grouped by change number. **Breaking: the marketplace name, the lead skill name and the watchdog default.**
- #1 Marketplace renamed `ghorc-local` -> `ghorc`. Users of 0.4.x: run `claude plugin marketplace remove ghorc-local`,
  then `claude plugin marketplace add gagharutyunyan1993/ghorc` and `claude plugin install ghorc@ghorc`.
- #18 `plugin.json` has `license`, `repository`, `homepage`; the CI matrix adds Node 20; CI runs `npm test`, which
  runs only `tests/*.test.cjs` (`scripts/test.cjs`), so `examples/` never joins the plugin test run.
- #2 **Breaking:** the transcript watchdog is opt-in (`watchdog.autostart` defaults to false). `/ghorc:setup` lists
  `watchdog` (`--apply watchdog` sets it true in the project config; `--check` shows on/off). New
  `scripts/watchdog.cjs --stop` kills the project's watchdog and removes its pid and heartbeat files.
- #3 `GHORC_ROLE` is optional: SessionStart prints `role=lead` for a plain main session instead of
  `role=unknown (set GHORC_ROLE)`. `worker` stays explicit.
- #4 **Breaking:** `readGuard.leadNoMedia` applies only when `GHORC_ROLE=lead` is set; a plain main session reads images
  and PDFs (a PDF still needs `pages`).
- #5 `setup --check` proposes `heavyCommands` from the `package.json` scripts (root and `app/`: test, e2e, build,
  lint names; never a pattern that matches `checks.fast`); `setup --apply heavy` prints and writes them. Not part
  of `--apply all`.
- #6 Skill `ghorc:orc` is now `ghorc:lead`; `ghorc:orc` stays one release as a short alias that points to it.
- #7 New skill `ghorc:status`: role, guards, heavy patterns, watchdog, context numbers and the last denials in one block
  (`setup.cjs --check --status` plus `ctx.cjs --session <id>`).
- #8 Denial log: every deny of the read guard and the heavy-check guard appends `<iso time> <session8> <hook> <reason>`
  to `<tmp>/ghorc-<user>/denials.log`; cleanup keeps 7 days.
- #9 `templates/ghorc.json` is short (checks, heavyCommands, thresholds, watchdog.autostart, readGuard.maxRepeat,
  lead.model); every other key keeps its default from `scripts/lib/defaults.json`. All keys are in
  `docs/configuration.md`. The validator still accepts every key. Agent descriptions are one line and start with the
  role name. The CLAUDE.md section template is wrapped to 120 columns.
- #11 `ghorc:handoff` description says it works without herdr.

## 0.4.0
Entries are grouped by the id of the attack digest finding.
- Fix: `setup.cjs` and `check-config.cjs` resolve the project root from cwd (git toplevel, `--cwd` overrides), not
  `CLAUDE_PROJECT_DIR`; `--apply claudemd` no longer writes into another tree. Hooks keep the old rule.
- SessionStart derives the transcript dir from either slash style (fallback: encoded cwd under ~/.claude/projects) and does not
  start the watchdog for a drive root, "/", the home dir or a missing dir (prints "watchdog: not started (reason)"); the
  watchdog itself exits 2 on such a --transcript-dir. `GHORC_WATCHDOG_DRY=1` prints the spawn argv to stderr.
- Watchdog exits (and removes its pid and heartbeat files) when its project root no longer exists. Tests stop every watchdog
  they spawn (`taskkill /T /F` on Windows) and run session-start with `GHORC_NO_AUTOSTART=1` (also honored by session-start).
- A1, A2, A3: read-guard counts reads per agent and per resolved path (lower-cased on Windows); offset, limit and pages no
  longer make a new key, so round-robin reading is caught. PostToolUse resets only the edited path (Edit, Write,
  NotebookEdit); the Bash/PowerShell reset is gone.
- A8, A24: PDF and image reads are for media roles only (`readGuard.mediaRoles`, default `ghorc:media`, `media`); a
  stat error on an image still counts as a read.
- A5, A9, A13: budgets per agent: `pdfPageBudget` (60), `mediaByteBudget` (8 MiB), `maxScreenshots` (60, MCP
  screenshot/snapshot/read_page tools; the Read matcher in hooks.json now includes them).
- I4: invalid project config (JSON, type, regex) makes the heavy guard deny heavy commands for everyone, lead included,
  with the reason; validity is cached by mtime and size; read-guard keeps working with defaults.
- A10, A16: per-user tmp dir `<tmp>/ghorc-<user>`; atomic writes for state, pid, ctx and offset files.
- G1: `GHORC_ROLE=worker` counts as a subagent for the heavy guard; built-in subagent denies: `claude -p`,
  `herdr agent start`, `herdr agent prompt`.
- I5: heavy command matching per segment (`&&`, `||`, `;`, `|`, newline), anchored at the segment start, quotes
  ignored, `npm run`/`npx` prefix tolerated. **Patterns written for the old "match anywhere" rule may need a leading
  `^`.**
- A11: config lookup tries `CLAUDE_PROJECT_DIR` and cwd ancestors first and spawns git only on a miss.
- A18, A19, A21: `GHORC_HOOK_DUMP=<file>` records raw hook input; hook-io and root helpers hardened.
- A23: `setup --check` has a warning-only `heavy` item (empty `heavyCommands`, or no match for `checks.full`).
- E1: setup `pct` is labelled GLOBAL; `--project` writes `<project>/.claude/settings.local.json` instead.
- E2: setup exclude path comes from `git rev-parse --git-path info/exclude` (worktrees); adds `.claude/ghorc-out/`.
- E3, E4: `ctx.cjs` needs `--session <id>` (full or 8-char prefix, or `GHORC_SESSION`) or `--all`; alerts are per
  session, up to 10, oldest first, only shown ones marked read.
- E6: status line shows `#<8 chars of session id>`; the 7d reset is shown as `~Nd` from 48 h.
- E8, F1, F2: SessionStart prints `session=<id>` and `role=unknown (set GHORC_ROLE)`, alerts first, cut at 299
  characters with `+more: run ctx`; removes ctx files and tmp state older than 7 days.
- F3, F4, F6, F7, F8, F9: watchdog is one per project root and scans only that project's transcript directory
  (`--transcript-dir`, `--project-root`); JSON pid file with version, heartbeat file, SessionStart restarts a dead,
  stale or old-version watchdog; stop alarm on first sight; growth streak decays instead of resetting; `--notify` is
  an argv array without a shell (`cmd /c script.cmd` for scripts); per-session, per-project alert offsets.
- E1, G2, I3: docs (README: hooks, scripts, config, troubleshooting, development) follow the code above.
- B1, B2a: handoff has an explicit step: after READY the old lead sends `ACTIVATE <handoff_id>` as its last action; the
  candidate refuses a different id.
- B3, B4, B5: STATE.md has mandatory `in_flight`, `unanswered_owner_messages`, `head` and `seq`; the candidate
  re-reads STATE at activation and refuses if `head` moved without a note.
- B8: READY deadline polled every 60 s up to `handoff.readyTimeoutMin` (default 10, in the template and the
  validator), then report and keep leading.
- C1: reviewers may mark findings `UNREPRODUCED` (file:line, reasoning); they count at P0/P1 only with a stated reason.
- C2, C11, E3: orc rule for a model override when implementer and reviewer models are equal; the final full runs on the
  merge SHA and the report quotes it; rule 11 reads the session id from SessionStart or the `#id` segment.
- C8: media role gets Grep and greps the pdftotext output before reading it.
- D4: `.claude/ghorc-out/` is the artifact dir in the brief skill and every role prompt.
- H1: consult role secrets rule with a pre-send grep of the question file.
- Review fixes: SessionStart kills no stale watchdog pid (it may be a foreign process); a watchdog exits when the
  pid file names another pid. Heavy matching also sees through shell wrappers (`bash -c`, `cmd /c`,
  `powershell -Command`), `$(...)`, backticks, `&`, parentheses, braces and npm global options; `claude --print` is
  an agent start; the lead may start agents with an invalid config. read-guard starts a new count for a file whose
  mtime or size changed; heap snapshots are not screenshots. `handoff.readyTimeoutMin` is in the template.
- Skill, template and README sentences made current: `ctx.cjs --session`, global `pct` and `--project`, `heavy` item,
  heavy guard for workers, subagent denies.

## 0.3.1
- Follow-up: statusline git timeout overridable (`GHORC_GIT_TIMEOUT_MS`, tests deterministic); reset shown as `~Nh` or `~Nm`; verified live rate_limits/effort shape documented; test uses plain `node --test`.
- Root: one rule in `scripts/lib/root.cjs` (`CLAUDE_PROJECT_DIR`, else git common root, else cwd) used by config, setup, statusline and ctx; setup now finds and writes the config at the main root from a worktree.
- setup: new check item `statusLineStale` (statusLine points to an older plugin cache version than the running one).
- read-guard: `leadNoMedia` no longer treats `GHORC_ROLE=worker` sessions as the lead.
- read-guard: PDF/image extension checks are case-insensitive on every OS.
- watchdog: size alerts persist in `<tmp>/ghorc/watchdog-state.json`; a restart does not repeat them, re-alert after growth of `warnMiB`/2 or a level rise.
- statusline writer and `ctx.cjs` reader now agree on the root (the writer ignored `CLAUDE_PROJECT_DIR` before).
- Docs: heavy-check-guard header says `Bash|PowerShell`; statusline `--help` shows the real separator.

## 0.3.0
- All user-facing text, comments and tests translated to English; skill triggers are English only.
- session-start autostarts the transcript watchdog for lead sessions (config `watchdog.*`, pid lock, `--notify-file`, alerts shown by `ctx.cjs`).
- New skill `/ghorc:setup` and `scripts/setup.cjs` (check and apply the recommended setup).
- session-start reminds about a missing `<!-- ghorc -->` section in CLAUDE.md; README gains "Daily use" and "With and without herdr"; `/ghorc:handoff` prints a fallback without herdr.
- statusline saves a raw stdin sample once to `<tmp>/ghorc/statusline-sample.json`.
- Names are namespaced everywhere: `/ghorc:*`, `ghorc:<role>`.

## 0.2.0
- statusline: subscription-oriented line (model, effort, ctx with autocompact marker, 5h/7d rate limits, role, git branch, session), colors, no cost; opt-in raw dump via GHORC_STATUSLINE_DUMP; ctx file gains effort and rate_limits keys (additive).

## 0.1.2
- review rounds 1-2 fixes.
