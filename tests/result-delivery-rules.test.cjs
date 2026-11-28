'use strict';
// Text pins: the report file is named by an absolute path, a missing result line means "not delivered", and the
// lead's wait is never described as reading the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const lead = read('skills', 'lead', 'SKILL.md');
const brief = read('skills', 'brief', 'SKILL.md');
const missing = lead.slice(lead.indexOf('- **Missing result:**'), lead.indexOf('- **Close** right after'));
const templates = brief.slice(brief.indexOf('## Template 1.'), brief.indexOf('## Antipatterns'));
const owned = ['skills/lead/SKILL.md', 'skills/brief/SKILL.md', 'docs/troubleshooting.md']
  .concat(fs.readdirSync(path.join(__dirname, '..', 'agents')).map((f) => `agents/${f}`));

test('the lead skill and the brief skill name the report file by an absolute path in the lead project root', () => {
  assert.match(lead, /gives the ABSOLUTE path of the report file, `<lead project root>\/\.claude\/ghorc-out\/<name>\.md`/);
  assert.match(lead, /never the worker's worktree, because the tabs guard reads the file only there/);
  assert.match(lead, /lead session's project directory .the one the lead was started in/);
  assert.doesNotMatch(lead, /project root is the lead's main checkout/);
  assert.match(brief, /by its ABSOLUTE path, `<lead project root>\/\.claude\/ghorc-out\/<name>\.md`/);
  assert.match(brief, /never the worker's worktree/);
  assert.match(brief, /lead session's project directory .the one the lead was started in/);
  assert.doesNotMatch(brief, /project root is the lead's main checkout/);
});

test('every brief template shows an absolute-path placeholder and no bare relative report path', () => {
  const reports = templates.match(/<report_back>[\s\S]*?<\/report_back>/g);
  assert.equal(reports.length, 3);
  for (const r of reports) {
    assert.match(r, /<absolute path: lead project root>\/\.claude\/ghorc-out\/<name>\.md/);
    assert.match(r, /does not count: the lead does not see your screen as a result/);
  }
});

test('the brief templates say the LAST line of the report file (or review file)', () => {
  assert.match(templates, /The LAST line of the report file: `DONE <name>` \/ `BLOCKED/);
  assert.match(templates, /the LAST line of the review file is `VERDICT/);
  assert.match(templates, /the LAST line of the report file `DONE <name>` or `BLOCKED <name>: <reason>`/);
  assert.doesNotMatch(templates, /the LAST line `DONE/);
});

test('lead skill: a wait that returns without a fresh result line means the package is not delivered', () => {
  assert.ok(missing.length > 200, 'the Missing result bullet sits before Close');
  assert.match(missing, /No fresh result line means the package is NOT delivered, whatever the worker's screen says/);
  assert.match(missing, /send the SAME worker one prompt that tells it to write its result to the absolute report path/);
  assert.match(missing, /by the Delivery rule .wait until it is `working` first.*/);
  assert.ok(lead.includes('- **Delivery (herdr):**'), 'the rule the Missing result bullet points to exists');
  assert.match(missing, /result line last/);
  assert.match(missing, /close the tab and re-brief the package/);
  assert.match(missing, /never takes a result from the screen, never records the package as delivered or accepted/);
  assert.match(missing, /never starts a step that depends on the package until a fresh result line is in the file/);
  assert.match(missing, /never builds a wait that polls for the file/);
});

test('lead skill: fresh means written after the last task sent; an earlier line is not a result', () => {
  assert.match(missing, /fresh only if the report file was written after you last sent that worker a task/);
  assert.match(missing, /with no send the guard recorded, after the guard first saw the tab/);
  assert.doesNotMatch(missing, /not before the tab was first seen/);
  assert.match(missing, /earlier round or by an earlier worker with the same name is not a result/);
  assert.match(read('docs', 'troubleshooting.md').replace(/\n\s+/g, ' '), /last sent that worker a task \(with no send the guard recorded, after the guard first saw the tab\)/);
});

test('lead skill: any text sent to a worker starts a new round; no question after a result; one prompt is the remedy', () => {
  assert.match(missing, /Every text sent to a worker, other than a session command/);
  assert.match(missing, /is a new round to the guard and makes the worker's earlier result line stale/);
  assert.match(missing, /do not send a question to a worker whose result you have/);
  assert.match(missing, /fix-round prompt says to rewrite the report file with the result line last/);
  assert.match(missing, /the one prompt to the same worker .*is the whole remedy; that is not a failed package and not a re-brief/);
  assert.match(missing, /on `hc` with `hc send <n> "<text>"`, then `hc wait <n>`/);
});

test('rule 16 and the hc line agree: hc send is a notice, the result is the last line of the report file', () => {
  assert.doesNotMatch(lead, /a worker reports to its parent with `hc send`/);
  assert.match(lead, /on `hc` a worker may notify its parent with `hc send`, a notice only: its result is the last line of the report file/);
});

test('role files give the report place as the absolute path of the lead project directory', () => {
  for (const f of ['implementer', 'integrator', 'release', 'scout']) {
    const s = read('agents', `${f}.md`);
    assert.match(s, /lead session's project directory/, f);
    assert.doesNotMatch(s, /`<project>\/\.claude\/ghorc-out\/`/, f);
  }
});

test('lead skill: one re-brief at most, then BLOCKED and the owner', () => {
  assert.match(missing, /re-brief the package once/);
  assert.match(missing, /stop delegating that package, record it as BLOCKED and report it to the owner/);
  assert.match(missing, /never re-brief a third time/);
});

test('lead skill: the guard reads at SessionStart too; an hc send line is a notice, not the result', () => {
  assert.match(missing, /at SessionStart, when the lead submits a prompt and when it stops/);
  assert.match(lead, /notice to the lead only and never the result/);
  assert.doesNotMatch(lead, /A worker on `hc` reports with `hc send/);
});

test('example brief and workflow doc follow the brief skill: absolute placeholder, tab-named file', () => {
  const demo = read('examples', 'demo', 'briefs', 'fix-slugify.md');
  const wf = read('docs', 'workflow.md');
  assert.ok(demo.includes('<absolute path: lead project root>/.claude/ghorc-out/d1-implementer.md'));
  assert.match(demo, /LAST line of the report file/);
  assert.doesNotMatch(demo, /fix-slugify-report/);
  assert.ok(wf.includes('<absolute path: lead project root>/.claude/ghorc-out/<name>.md'));
  assert.ok(wf.split(/\s+/).join(' ').includes('LAST line of the report file'));
});

test('lead skill: the NORESULT flag is listed with the same action', () => {
  assert.match(lead, /NORESULT - the worker was given a task or was seen working, is now idle or done, and has no fresh result line/);
  assert.match(lead, /names the absolute report path and blocks the lead's Stop once per tab, like FINISHED/);
  assert.match(lead, /rule "Missing result" below/);
});

test('the example report ends with the result line of the example tab, and the docs say the result is the last line', () => {
  const lines = read('examples', 'demo', 'expected-report.md').split('\n').filter((l) => l.trim());
  assert.equal(lines[lines.length - 1], 'DONE d1-implementer');
  assert.doesNotMatch(lines[0], /^STATUS:/);
  const wf = read('docs', 'workflow.md').replace(/\n\s+/g, ' ');
  assert.match(wf, /The result is the LAST line of the report file/);
  assert.doesNotMatch(wf, /The first line is `STATUS/);
  assert.match(read('examples', 'demo', 'README.md').replace(/\n\s+/g, ' '), /lead's project directory, at the absolute path the brief gives/);
});

test('no owned file says the lead wait reads the file', () => {
  for (const f of owned) {
    const s = read(...f.split('/')).replace(/\n\s+/g, ' ');
    assert.doesNotMatch(s, /wait (never )?(reads|fires)/i, f);
    assert.doesNotMatch(s, /which is what the wait reads/i, f);
    assert.doesNotMatch(s, /because the lead's wait reads/i, f);
  }
  assert.match(read('agents', 'implementer.md'), /the lead's tabs guard reads that file and not your screen/);
  assert.match(read('docs', 'troubleshooting.md').replace(/\n\s+/g, ' '), /it does not read the report file\. Only the tabs guard reads the file/);
});
