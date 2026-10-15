'use strict';
// SessionStart derives the transcript dir correctly; the watchdog refuses root dirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runScript, TEST_TMP } = require('./helpers.cjs');
const { deriveTranscriptDir, dirnameAny, encodeCwd, refuseReason } = require('../scripts/lib/scandir.cjs');

const noRootEnv = { GHORC_WATCHDOG_ROOT: '' };

test('dirnameAny handles escaped-backslash, forward-slash and posix paths', () => {
  assert.equal(dirnameAny('C:\\Users\\ENV\\.claude\\projects\\D--p\\smoke.jsonl'), 'C:\\Users\\ENV\\.claude\\projects\\D--p');
  assert.equal(dirnameAny('C:/Users/ENV/.claude/projects/D--p/smoke.jsonl'), 'C:/Users/ENV/.claude/projects/D--p');
  assert.equal(dirnameAny('/home/u/.claude/projects/-p/s.jsonl'), '/home/u/.claude/projects/-p');
});

test('encodeCwd matches Claude Code naming', () => {
  assert.equal(encodeCwd('D:\\Projects\\vids\\vids'), process.platform === 'win32' ? 'D--Projects-vids-vids' : encodeCwd('D:\\Projects\\vids\\vids'));
  if (process.platform === 'win32') assert.equal(encodeCwd('D:/Projects/vids/vids'), 'D--Projects-vids-vids');
});

test('deriveTranscriptDir: transcript_path (both slash styles) and the absent fallback', () => {
  const old = process.env.GHORC_WATCHDOG_ROOT;
  delete process.env.GHORC_WATCHDOG_ROOT;
  try {
    const want = 'C:\\Users\\ENV\\.claude\\projects\\D--Projects-vids-vids';
    assert.equal(deriveTranscriptDir({ transcript_path: `${want}\\smoke.jsonl` }, 'D:\\x'), want);
    assert.equal(deriveTranscriptDir({ transcript_path: 'C:/Users/ENV/.claude/projects/D--Projects-vids-vids/smoke.jsonl' }, 'D:\\x'), 'C:/Users/ENV/.claude/projects/D--Projects-vids-vids');
    assert.equal(deriveTranscriptDir({}, 'D:\\Projects\\vids\\vids'), path.join(os.homedir(), '.claude', 'projects', encodeCwd('D:\\Projects\\vids\\vids')));
  } finally {
    if (old !== undefined) process.env.GHORC_WATCHDOG_ROOT = old;
  }
});

test('refuseReason: drive root, slash, drive-relative C:, home, missing dir; accepts a real dir', () => {
  for (const d of ['C:', 'C:\\', 'C:/', '/', os.homedir(), path.parse(os.tmpdir()).root]) assert.ok(refuseReason(d), d);
  assert.match(refuseReason(path.join(TEST_TMP, 'nope')), /does not exist/);
  assert.equal(refuseReason(TEST_TMP), null);
});

function dry(input, extraEnv = {}) {
  const r = runScript('session-start.cjs', input, { env: { ...noRootEnv, GHORC_NO_AUTOSTART: '', GHORC_WATCHDOG_DRY: '1', GHORC_ROLE: 'lead', GHORC_TMP: fs.mkdtempSync(path.join(TEST_TMP, 'd-')), ...extraEnv } });
  const m = r.err.match(/watchdog-args: (.*)/);
  return { out: r.out, args: m ? JSON.parse(m[1]) : null };
}

test('session-start dry run: transcript_path in a real dir gives that dir (backslash and forward slash)', () => {
  const proj = path.join(TEST_TMP, 'proj-a');
  fs.mkdirSync(proj, { recursive: true });
  for (const tp of [`${proj}\\smoke.jsonl`.replace(/\//g, '\\'), `${proj}/smoke.jsonl`.replace(/\\/g, '/')]) {
    const { args } = dry({ session_id: 'smoke', cwd: proj, transcript_path: tp });
    assert.ok(args, tp);
    assert.equal(path.resolve(args[args.indexOf('--transcript-dir') + 1]), path.resolve(proj));
  }
});

test('session-start refuses a mangled transcript_path that collapses to a drive root', () => {
  const { out, args } = dry({ session_id: 'smoke', cwd: TEST_TMP, transcript_path: 'C:Users.claudeprojectsD--x\\smoke.jsonl'.replace(/\\/g, '') });
  assert.equal(args, null);
  assert.match(out, /watchdog: not started \(/);
});

test('session-start refuses a missing dir and the home dir', () => {
  const missing = path.join(TEST_TMP, 'absent-dir', 's.jsonl');
  assert.match(dry({ session_id: 's', cwd: TEST_TMP, transcript_path: missing }).out, /watchdog: not started \(dir does not exist/);
  assert.match(dry({ session_id: 's', cwd: TEST_TMP, transcript_path: path.join(os.homedir(), 's.jsonl') }).out, /watchdog: not started \(home dir/);
});

test('session-start absent transcript_path falls back to the encoded cwd under ~/.claude/projects (refused when missing)', () => {
  const { out, args } = dry({ session_id: 's', cwd: path.join(TEST_TMP, 'no-such-project') });
  assert.equal(args, null);
  assert.match(out, /watchdog: not started \(dir does not exist/);
});

test('watchdog exits 2 and never scans a drive root, slash or home dir', () => {
  for (const d of ['C:', 'C:\\', '/', os.homedir()]) {
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'watchdog.cjs'), '--transcript-dir', d, '--once', '--pid-file', path.join(TEST_TMP, 'x.pid'), '--heartbeat-file', path.join(TEST_TMP, 'x.beat')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 2, d);
    assert.match(r.stderr, /refusing to scan/);
  }
});
