# HANDOFF <handoff_id> (<date>)   (at most 3072 bytes, plus the optional acceptance block below)
handoff_id: <id>   status: DRAFT|SENT   old_session_id: <id>   created_at: <time>   reason: <reason, e.g. ctxHandoff>
state_path: <path to STATE.md>

## 1. Package chain and stages
- Merged this shift: <packages and SHA>. Main branch HEAD: <SHA>.
- Active package: <ID>, stage <stage>; worktree <path>, branch <name> (pushed to origin), HEAD <SHA>;
  brief <path>; review <path> (verdict, open P0/P1).
- Queue: <ID> (brief <path>).

## 2. Background processes
- In-flight agents: <none; details in STATE `in_flight`>. Background full: <none>. Terminal workers (hc or herdr): <none / pane id or terminal address and task>.

## 3. Decisions of this shift (not yet in memory)
- <owner decision and link>

## 4. Unclosed messages and promised actions
- <list or "none">

## 5. First 3 steps
1. Verify the facts: <git command>, expected HEAD <SHA>; presence of <files>.
2. Answer READY (format in skill ghorc:handoff); change nothing until `ACTIVATE <handoff_id>` arrives (refuse a different id); then re-read STATE.md (`head`, `seq`).
3. <first working action>

## 6. Acceptance block (optional, at most 1600 bytes and 15 lines; the old lead writes it)
- READY format, the ACTIVATE rule and the first steps in short, so that the candidate need not load skill ghorc:handoff.
