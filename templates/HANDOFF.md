# HANDOFF <handoff_id> (<date>)
handoff_id: <id>   status: DRAFT|SENT   old_session_id: <id>   created_at: <time>   reason: <reason, e.g. 150K>
state_path: <path to STATE.md>

## 1. Package chain and stages
- Merged this shift: <packages and SHA>. Main branch HEAD: <SHA>.
- Active package: <ID>, stage <stage>; worktree <path>, branch <name>, HEAD <SHA>;
  brief <path>; review <path> (verdict, open P0/P1).
- Queue: <ID> (brief <path>).

## 2. Background processes
- Active agents: <none>. Background full: <none>. herdr workers: <none / pane id and task>.

## 3. Decisions of this shift (not yet in memory)
- <owner decision and link>

## 4. Unclosed messages and promised actions
- <list or "none">

## 5. First 3 steps
1. Verify the facts: <git command>, expected HEAD <SHA>; presence of <files>.
2. Answer READY (format in skill ghorc:handoff); change nothing until `herdr agent get` shows the old lead has finished.
3. <first working action>
