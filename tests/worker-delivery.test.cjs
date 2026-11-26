'use strict';
// Text pins for two skill rules: delivery check after a send to a worker (lead skill) and the old-lead close fallback (handoff).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\n\s+/g, ' ');
const lead = read('skills', 'lead', 'SKILL.md');
const handoff = read('skills', 'handoff', 'SKILL.md');
const delivery = lead.slice(lead.indexOf('- **Delivery (herdr):**'), lead.indexOf('- **Watch** in the background'));
const step6 = handoff.slice(handoff.indexOf('6. Closing the old tab is mandatory'), handoff.indexOf('Git Bash trap'));
const docStep6 = flat(read('docs', 'handoff.md')).split('6. **Closing the old tab**')[1].split('Git Bash turns')[0];

test('M1: delivery is a bounded wait for working, then the screen; a submitted message counts as delivered', () => {
  assert.ok(delivery.length > 100, 'the Delivery bullet sits before Watch');
  assert.match(delivery, /`herdr agent wait <n> --until working --until blocked --timeout 5000`/);
  assert.match(delivery, /On a timeout read `herdr pane read <pane_id> --source recent --lines 40`/);
  assert.match(delivery, /A message shown as submitted above an empty input box, or one showing only a grey suggestion, was delivered, even if the worker is already `idle` or `done` again/);
  assert.match(delivery, /The background `agent wait` of Watch starts once delivery is confirmed/);
  assert.ok(delivery.indexOf('--until working') < delivery.indexOf('The background `agent wait`'), 'check before the watch');
});

test('lead skill: one Enter via send-keys when the text sits in the box, never a second send, otherwise the owner', () => {
  assert.match(delivery, /still in the input box and no dialog is on screen, press Enter once with `herdr pane send-keys <pane_id> enter`/);
  assert.match(delivery, /The text is never sent twice, because a resend can run the task twice/);
  assert.match(delivery, /no `working` after that one Enter: tell the owner/);
  assert.doesNotMatch(lead, /before sending it again/, 'the old resend permission is gone');
  assert.match(lead, /follow the Delivery rule; the text is not sent twice/);
});

test('M2 and M3: send only to idle or done; a working worker is waited for; a blocked worker gets no send and no Enter', () => {
  assert.match(delivery, /send only to a worker whose `herdr agent get <n>` shows `idle` or `done`/);
  assert.match(delivery, /A `working` worker keeps the follow-up on hold: the lead sends it when the background wait already watching that worker wakes on `idle` or `done`, never with a foreground wait/);
  assert.doesNotMatch(delivery, /agent wait <n> --until idle --until done --until blocked`/, 'N1: no foreground wait for a busy worker');
  assert.match(delivery, /A `blocked` or `unknown` worker is the owner's: no send and no Enter/);
  assert.match(delivery, /or one showing only a grey suggestion, was delivered/);
  assert.match(lead, /a worker reported BLOCKED is not watched again until the owner has answered/);
  assert.match(delivery, /`blocked` means delivered and waiting on a dialog/);
});

test('lead skill: the first task is read once after agent start returns, a dialog goes to the owner', () => {
  assert.match(lead, /after `agent start` returns without `agent_not_ready`, read the screen once with `herdr pane read <pane_id>/);
  assert.match(lead, /a dialog goes to the owner; a ready, empty input prompt gets the task/);
});

test('lead skill: the handoff exception names pane close only for an idle old session', () => {
  assert.match(lead, /when the pane stays listed and the old session is idle, `herdr pane close <old_pane_id>`; step 6 of skill `ghorc:handoff`/);
});

test('docs/workflow.md and docs/with-herdr.md agree with the lead skill on delivery', () => {
  const wf = read('docs', 'workflow.md');
  assert.match(wf, /only while it is `idle` or `done`; a busy one keeps the follow-up on hold until the background wait already watching it wakes/);
  assert.match(wf, /a `blocked` or `unknown` one gets no send and no Enter/);
  assert.match(wf, /counts as delivered even if the worker has already finished/);
  assert.match(wf, /the text is never sent twice/);
  assert.match(read('docs', 'with-herdr.md'), /`herdr pane run`, then the delivery check/);
});

test('template and skill: old_lead is written fresh from the old lead\'s own ids and may have no agent name', () => {
  const t = read('templates', 'HANDOFF.md');
  assert.match(t, /^old_lead: agent <name or none>, pane <pane id>, tab <tab id>.*never copied from an older HANDOFF/m);
  assert.match(handoff, /written fresh at every handoff and never copied from an earlier HANDOFF/);
  assert.match(handoff, /pane `\$HERDR_PANE_ID`, tab `\$HERDR_TAB_ID`/);
  assert.match(handoff, /agent name from `herdr agent get \$HERDR_PANE_ID`, or `none`/);
  assert.match(handoff, /`send-keys enter` is not a way to send, only the one recovery step/);
});

test('M5 and N2: no-wait checks first, then the wait, then the last-reply check, then /exit', () => {
  const at = (s, re) => { const m = s.search(re); assert.ok(m >= 0, String(re)); return m; };
  const own = at(step6, /it is not the new lead's own `\$HERDR_PANE_ID`, and it is in `herdr pane list`/);
  const wait = at(step6, /Then `herdr agent wait <old_pane_id> --until idle --until done --until blocked --timeout 60000`/);
  const reply = at(step6, /the old lead's last reply in `herdr agent read <old_pane_id>` is `HANDOFF SENT - STOP`/);
  const exit = at(step6, /MSYS_NO_PATHCONV=1 herdr pane run <old_pane_id> "\/exit"/);
  assert.ok(own < wait && wait < reply && reply < exit, 'order: own/listed checks, wait, last reply, /exit');
  assert.match(step6, /its last reply, not the last line of the screen, which is the input box/);
  assert.match(step6, /on a timeout, `blocked` or a different last reply: no `\/exit`, no close, one line to the owner/);
  assert.match(step6, /reported to the owner as "not found: already closed, or the line is stale" \(the old tab may still be open\), never as a close that succeeded/);
  assert.doesNotMatch(step6, /reported as already closed/);
  const d = (re) => { const m = docStep6.search(re); assert.ok(m >= 0, String(re)); return m; };
  assert.ok(d(/not its own/) < d(/Then `herdr agent wait <old_pane_id>/) && d(/Then `herdr agent wait <old_pane_id>/) < d(/last reply in/) && d(/last reply in/) < d(/"\/exit"/), 'docs order');
  assert.match(docStep6, /"not found: already closed, or the line is stale", never as a successful close/);
});

test('M4: the close gate uses the pane id and closes only on idle, done or no agent, after /exit and its retry', () => {
  assert.match(step6, /Every agent command here takes the pane id/);
  assert.doesNotMatch(step6, /<old agent>|<old pane or agent>/);
  const send = step6.indexOf('MSYS_NO_PATHCONV=1 herdr pane run <old_pane_id> "/exit"');
  const retry = step6.indexOf('repeat `/exit` once');
  const close = step6.indexOf('close it with `herdr pane close <old_pane_id>`');
  const gate = step6.indexOf('`herdr agent get <old_pane_id>` shows `idle` or `done`, or says the pane holds no agent');
  assert.ok(send > 0 && retry > send && gate > retry && close > gate, 'close is after /exit, the retry and the state gate');
  assert.ok(step6.indexOf('otherwise the owner closes it') < send, 'everything sits behind the permission gate');
  assert.match(step6, /on `working`, `blocked` or `unknown` do not close and report to the owner/);
  assert.match(docStep6, /shows `idle` or `done`, or no agent, the new lead closes it with `herdr pane close <old_pane_id>`/);
  assert.match(docStep6, /on `working`, `blocked` or `unknown` it does not close and reports to the owner/);
});

test('without permission the owner gets one line naming the old tab from old_lead', () => {
  assert.match(step6, /tells the owner in one line which tab is idle and waiting to be closed, taken from the `old_lead:` line of HANDOFF/);
  assert.match(docStep6, /taken from the `old_lead:` line of HANDOFF \(herdr: agent name, pane id and tab id/);
});

test('M6: every place that describes the standing permission names pane close next to /exit', () => {
  const files = [
    ['skills', 'setup', 'SKILL.md', /`\/exit` through `herdr pane run`, then `herdr pane close` of the leftover pane/],
    ['scripts', 'setup.cjs', /\/exit through herdr pane run, then herdr pane close of the leftover pane/],
    ['docs', 'configuration.md', /`\/exit` through `herdr pane run`, then `herdr pane close` of the leftover pane/],
    ['docs', 'handoff.md', /`\/exit` through\s+`herdr pane run`, then `herdr pane close` if the pane stays/],
    ['skills', 'handoff', 'SKILL.md', /`\/exit` through `herdr pane run`, then `herdr pane close` if the pane stays/],
  ];
  for (const f of files) assert.match(read(...f.slice(0, -1)), f[f.length - 1], f.slice(0, -1).join('/'));
});

test('fix C: the lead skill and hooks doc say the capacity line is machine-wide and tabs.maxWorkers is the own limit', () => {
  assert.match(lead, /`agents N\/M machine-wide, CPU X%, free Y GB`/);
  assert.match(lead, /The line counts agents of every project on the machine and is a load indicator; the limit on this lead's own workers is `tabs\.maxWorkers`/);
  const hooks = flat(read('docs', 'hooks.md'));
  assert.match(hooks, /`agents N\/M machine-wide, CPU X%, free Y GB`/);
  assert.match(hooks, /it is a load indicator, not the limit on one lead's workers \(that is `tabs\.maxWorkers`\)/);
});

test('fix D: after ACTIVATE the new lead dispatches the first open step without waiting for the owner (skill, rule 7, docs)', () => {
  const s7 = handoff.slice(handoff.indexOf('\n7. After ACTIVATE'));
  assert.match(s7, /dispatches the first open step from the handoff file to a worker without waiting for the owner's word, because a lead that prepares at length before the first dispatch spends the context the handoff just freed; the owner's word is needed only where a rule names it \(a release, closing the old tab without recorded permission, a destructive action\)/);
  assert.ok(handoff.indexOf('\n7. After ACTIVATE') > handoff.indexOf('6. Closing the old tab'), 'step 7 follows step 6');
  assert.match(lead, /After a handoff the lead keeps its bookkeeping to the steps skill `ghorc:handoff` lists and dispatches the first open step from HANDOFF to a worker without waiting for the owner's word .*because long preparation before the first dispatch spends the context the handoff just freed/);
  assert.match(flat(read('docs', 'handoff.md')), /7\. After ACTIVATE the new lead keeps its own bookkeeping to the steps listed here, then dispatches the first open step from the handoff file to a worker without waiting for the owner's word, because a lead that prepares at length/);
});

test('fix F: the reading rule says a range of up to 100 lines is fine and why a long file goes to a scout', () => {
  assert.match(lead, /does not read a transcript, a log, a diff or a long file as a whole, because that fills its context; those go to a scout/);
  assert.match(lead, /A range of up to 100 lines is fine when the lead needs that text itself \(for example an instruction file it has to follow\)/);
  assert.match(lead, /reads a transcript, a log, a diff or a long file as a whole \(a range of up to 100 lines it needs itself is fine\)/);
  assert.doesNotMatch(lead, /files over 100 lines whole/);
});

test('fix F: the already-read deny points to a scout for a long file', () => {
  const g = read('scripts', 'read-guard.cjs');
  assert.match(g, /do not re-read it, use what you have or edit it first\. For a long file, send a scout \(ghorc:scout\) instead of reading it in parts\./);
});
