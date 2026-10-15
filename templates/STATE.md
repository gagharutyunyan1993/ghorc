# STATE (40-80 lines; details live in files, link them here)
Updated: <date, time>   Session: <session_id>   seq: <N, +1 on every write>   handoff_id: <id or none>

## Package, stage, next step
- Package: <ID>   Stage: <stage>
- Next step: <one action>

## Branch, worktree, SHA
- Branch: <name>   Worktree: <path>   Main branch HEAD: <SHA>

## head (mandatory)
- head: <git HEAD SHA at the last STATE write; the candidate refuses if it moved without a note>

## in_flight (mandatory)
- <agent/worker id, kind, expected output path, how to collect; or "none">

## Decisions and links to them
- <decision, date, link>

## Open blockers
- <blocker or "none">

## Checks
| Tree (SHA) | Command | Result | Artifact |
|---|---|---|---|
| <SHA> | <command> | <green/red> | <path> |

## Authority
- <standing owner permissions: paid calls, merge, release, handoff.allowSendKeysExit>

## unanswered_owner_messages (mandatory)
- <HH:MM verbatim owner message not yet answered; or "none">

## Promised actions
- <list or "none">
