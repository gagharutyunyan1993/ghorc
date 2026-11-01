'use strict';
// Heavy-check slots: at most `heavySlots.slots` heavy checks at a time on the machine (0 = off).
// One claim file per slot in <tmp>/heavy-slots/slot-<n>.json, created exclusively (flag wx). The real lock is
// scripts/heavy-slot.cjs (the wrapper that holds the claim while the command runs); the heavy-check hook only reads
// the claims and gives an early hint.
// Claim: { session, pid, ts, heartbeat, minutes, label, nonce, slot } (times in ms since the epoch). It is alive while
// its pid is alive and the heartbeat is younger than STALE_MS; a dead claim holds nobody and is removed.
// Every change of a slot file (create, remove a dead claim, heartbeat, release) happens under a per-slot lock file
// (slot-<n>.lock, created with wx), so a removal can only ever act on the claim it has just read as dead, and of any
// number of processes racing for a slot exactly one wins. Readers (hook, status) take no lock.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tmpDir, isAlive } = require('./tmp.cjs');

// The file system calls go through this object so tests can slip a competitor in between two calls.
const io = Object.assign({}, fs);

const MAX_SLOTS = 8;
const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
// GHORC_SLOT_* are read at call time so tests can shorten them.
const staleMs = () => Math.max(1, num(process.env.GHORC_SLOT_STALE_MS, 120000));
const heartbeatMs = () => Math.max(1, num(process.env.GHORC_SLOT_HEARTBEAT_MS, 15000));
const lockWaitMs = () => Math.max(0, num(process.env.GHORC_SLOT_LOCK_WAIT_MS, 2000));
const LOCK_STALE_MS = 10000;
// A create with `wx` that fails with one of these means "someone has it": EEXIST, and on Windows EPERM or EACCES while
// the file is being deleted (delete pending) or held open by another process. Treated as busy, retried until the deadline.
const BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const LOCK_BUSY = '(slot lock busy)';

const slotsDir = () => path.join(tmpDir(), 'heavy-slots');
const slotFile = (i) => path.join(slotsDir(), `slot-${i}.json`);
const lockFile = (i) => path.join(slotsDir(), `slot-${i}.lock`);

// heavySlots config -> { slots: 0..8, minFreeRamGb, warning }. 0 or anything unusable means off.
function slotConfig(cfg) {
  const raw = cfg && cfg.heavySlots && typeof cfg.heavySlots === 'object' ? cfg.heavySlots : {};
  let slots = num(raw.slots, 0);
  let warning = '';
  if (slots !== Math.floor(slots) || slots < 0) {
    warning = `heavySlots.slots ${JSON.stringify(raw.slots)} is not an integer from 0 to ${MAX_SLOTS}: slots are off`;
    slots = 0;
  } else if (slots > MAX_SLOTS) {
    warning = `heavySlots.slots ${slots} is above ${MAX_SLOTS}: clipped to ${MAX_SLOTS}`;
    slots = MAX_SLOTS;
  }
  return { slots, minFreeRamGb: Math.max(0, num(raw.minFreeRamGb, 0)), warning };
}

// GHORC_TEST_FREE_RAM_GB replaces the real figure in tests.
function freeRamGb() {
  const t = process.env.GHORC_TEST_FREE_RAM_GB;
  if (t !== undefined && t !== '' && Number.isFinite(Number(t))) return Number(t);
  return os.freemem() / 1024 ** 3;
}

// Slots above the first need minFreeRamGb of free RAM (os.freemem counts cache, so it is a weak signal).
const ramAllows = (slot, minFreeRamGb) => slot <= 1 || minFreeRamGb <= 0 || freeRamGb() >= minFreeRamGb;

// { claim, mtimeMs } or null when there is no file. claim is null when the file is empty or not JSON (being written).
function readClaim(file) {
  let mtimeMs;
  try {
    mtimeMs = io.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(io.readFileSync(file, 'utf8'));
    return { claim: j && typeof j === 'object' ? j : null, mtimeMs };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { claim: null, mtimeMs };
  }
}

// True when the claim still holds its slot. An unreadable claim counts by the age of the file (a writer may be mid-write).
function isLive(read, now = Date.now()) {
  if (!read) return false;
  const c = read.claim;
  if (!c) return now - read.mtimeMs <= staleMs();
  if (!isAlive(Number(c.pid))) return false;
  const beat = Number(c.heartbeat) || Number(c.ts) || read.mtimeMs;
  return now - beat <= staleMs();
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

// A lock file is stale when its owner is gone (or, if it cannot be read, when it is old); a live owner is only
// overridden after LOCK_STALE_MS. Breaking moves the file away first; the file that was moved is checked to be the one
// read as stale and put back if it is not. The lock is held for milliseconds, so this only matters after a crash.
function breakStaleLock(file) {
  let text;
  let mtimeMs;
  try {
    mtimeMs = io.statSync(file).mtimeMs;
    text = io.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const [pid, at] = text.split(' ');
  const age = Date.now() - (Number(at) || mtimeMs);
  const stale = Number(pid) ? !isAlive(Number(pid)) && age > 50 : age > 2000;
  if (!stale && age <= LOCK_STALE_MS) return;
  const moved = `${file}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    io.renameSync(file, moved);
  } catch {
    return;
  }
  try {
    if (io.readFileSync(moved, 'utf8') !== text) io.copyFileSync(moved, file, fs.constants.COPYFILE_EXCL);
  } catch {
    /* ignore */
  } finally {
    try {
      io.rmSync(moved, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// Runs fn() while holding the lock of slot i. { locked: false } when the lock was not obtained in time.
function withLock(i, fn) {
  io.mkdirSync(slotsDir(), { recursive: true });
  const file = lockFile(i);
  const token = `${process.pid} ${Date.now()} ${crypto.randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + lockWaitMs();
  for (;;) {
    try {
      const fd = io.openSync(file, 'wx');
      try {
        io.writeSync(fd, token);
      } finally {
        io.closeSync(fd);
      }
      break;
    } catch (e) {
      if (!BUSY_CODES.has(e.code)) throw e;
    }
    breakStaleLock(file);
    if (Date.now() >= deadline) return { locked: false };
    sleepSync(3 + Math.floor(Math.random() * 8));
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    try {
      if (io.readFileSync(file, 'utf8') === token) io.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function writeNew(file, claim) {
  const fd = io.openSync(file, 'wx');
  try {
    io.writeSync(fd, JSON.stringify(claim));
  } finally {
    io.closeSync(fd);
  }
}

const unreadableHolder = (read) => ({ session: '?', label: '(being written)', ts: read.mtimeMs });

// Creates the claim file. EPERM and EACCES (Windows: the old file is still delete-pending or held open) are retried for
// a moment; EEXIST is thrown at once (someone else has the slot).
function writeNewRetry(file, claim) {
  const end = Date.now() + Math.min(lockWaitMs(), 1000);
  for (;;) {
    try {
      return writeNew(file, claim);
    } catch (e) {
      if (e.code === 'EEXIST' || !BUSY_CODES.has(e.code) || Date.now() >= end) throw e;
    }
    sleepSync(3 + Math.floor(Math.random() * 8));
  }
}

const busyHolder = (label) => ({ session: '?', label, ts: Date.now() });

// Takes slot i for `claim`. { ok: true } or { ok: false, holder } (a live claim of someone else, or the slot lock is
// busy). Never throws: a file system error leaves the slot untaken and names the error as the holder's label.
function tryTake(i, claim) {
  const file = slotFile(i);
  try {
    const r = withLock(i, () => {
      const read = readClaim(file);
      if (isLive(read)) return { ok: false, holder: read.claim || unreadableHolder(read) };
      if (read) io.rmSync(file, { force: true }); // read as dead a moment ago, and nobody else can change the slot now
      try {
        writeNewRetry(file, claim);
      } catch (e) {
        if (!BUSY_CODES.has(e.code)) throw e;
        const again = e.code === 'EEXIST' ? readClaim(file) : null;
        return { ok: false, holder: (again && again.claim) || busyHolder(e.code === 'EEXIST' ? '(busy)' : LOCK_BUSY) };
      }
      return { ok: true };
    });
    return r.locked ? r.value : { ok: false, holder: busyHolder(LOCK_BUSY) };
  } catch (e) {
    return { ok: false, holder: busyHolder(BUSY_CODES.has(e.code) ? LOCK_BUSY : `(slot error: ${e.code || e.message})`) };
  }
}

function ageText(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (Number(ts) || now)) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
}
// True when a live claim has run longer than the minutes it announced (it is reported, never removed).
const isOver = (c, now = Date.now()) => Number(c && c.minutes) > 0 && now - (Number(c.ts) || now) > Number(c.minutes) * 60000;
const holderText = (i, c, now) =>
  `slot ${i}: session ${c.session || '?'}, "${c.label || ''}", ${ageText(c.ts, now)} ago${isOver(c, now) ? `, over its ${c.minutes} min` : ''}`;

// Claims that are live now: [{ slot, claim }] for slots 1..n (a slot with an unreadable live file reports a stub).
function holders(n, now = Date.now()) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const read = readClaim(slotFile(i));
    if (isLive(read, now)) out.push({ slot: i, claim: read.claim || unreadableHolder(read) });
  }
  return out;
}

// Why there is no slot, naming the holders.
// `notes`: [{ slot, label }] for slots that could not be taken although no live claim holds them (the lock was busy).
function busyMessage(n, minFreeRamGb, now = Date.now(), notes = []) {
  const h = holders(n, now);
  const parts = h.map((x) => holderText(x.slot, x.claim, now));
  for (const x of notes) if (!h.some((y) => y.slot === x.slot)) parts.push(`slot ${x.slot}: ${x.label}`);
  if (n > h.length && minFreeRamGb > 0 && freeRamGb() < minFreeRamGb) {
    parts.push(`free RAM ${freeRamGb().toFixed(1)} GB is below heavySlots.minFreeRamGb ${minFreeRamGb} (needed for slots above the first)`);
  }
  return `no free heavy-check slot (${n} configured): ${parts.join('; ') || 'all busy'}`;
}

// Takes the first usable slot. { slot, nonce, claim } or { slot: 0, message }.
function acquire(sc, { session, label, minutes }) {
  const now = Date.now();
  const claim = { session, pid: process.pid, ts: now, heartbeat: now, minutes: minutes || 0, label: label || '', nonce: crypto.randomBytes(6).toString('hex') };
  const notes = [];
  for (let i = 1; i <= sc.slots; i++) {
    if (!ramAllows(i, sc.minFreeRamGb)) break;
    const full = { ...claim, slot: i };
    const t = tryTake(i, full);
    if (t.ok) return { slot: i, nonce: claim.nonce, claim: full };
    if (t.holder && /^\((?:slot lock busy|slot error)/.test(t.holder.label || '')) notes.push({ slot: i, label: t.holder.label });
  }
  return { slot: 0, message: busyMessage(sc.slots, sc.minFreeRamGb, Date.now(), notes) };
}

// True while slot i still carries this nonce.
function owns(i, nonce) {
  const r = readClaim(slotFile(i));
  return Boolean(r && r.claim && r.claim.nonce === nonce);
}

// Rewrites the claim with a fresh heartbeat. False only when the file holds a claim with another nonce (the slot now
// belongs to someone else, the caller stops). A missing or unreadable file, or a busy lock, is not a reason to stop.
function heartbeat(i, claim) {
  try {
    return heartbeatLocked(i, claim);
  } catch {
    return true; // a failed beat is retried at the next interval
  }
}

function heartbeatLocked(i, claim) {
  const file = slotFile(i);
  const r = withLock(i, () => {
    const read = readClaim(file);
    if (!read || !read.claim) return 'keep';
    if (read.claim.nonce !== claim.nonce) return 'lost';
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      io.writeFileSync(tmp, JSON.stringify({ ...claim, slot: i, heartbeat: Date.now() }));
      io.renameSync(tmp, file);
    } catch {
      try {
        io.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
    return 'ok';
  });
  return !(r.locked && r.value === 'lost');
}

function release(i, nonce) {
  try {
    return releaseLocked(i, nonce);
  } catch {
    return false;
  }
}

function releaseLocked(i, nonce) {
  const file = slotFile(i);
  const r = withLock(i, () => {
    const read = readClaim(file);
    if (!read || !read.claim || read.claim.nonce !== nonce) return false;
    io.rmSync(file, { force: true });
    return true;
  });
  return Boolean(r.locked && r.value);
}

// Removes every claim of a session (live or not). Returns the number removed.
function releaseSession(session, n = MAX_SLOTS) {
  let removed = 0;
  for (let i = 1; i <= n; i++) {
    const r = withLock(i, () => {
      const read = readClaim(slotFile(i));
      if (!read || !read.claim || read.claim.session !== session) return false;
      io.rmSync(slotFile(i), { force: true });
      return true;
    });
    if (r.locked && r.value) removed++;
  }
  return removed;
}

// What the hook asks: is there a slot this session could take? Read-only. { ok } or { ok: false, message }.
// A live claim of the same session is not an obstacle (checked on every slot, before the RAM limit); a dead claim holds
// nobody; a claim that cannot be parsed does not block here (the wrapper still waits for it).
function plan(sc, session, now = Date.now()) {
  let free = false;
  for (let i = 1; i <= sc.slots; i++) {
    const read = readClaim(slotFile(i));
    if (read && read.claim && isLive(read, now) && read.claim.session === session) return { ok: true };
    if (!read || !read.claim || !isLive(read, now)) free = free || ramAllows(i, sc.minFreeRamGb);
  }
  return free ? { ok: true } : { ok: false, message: busyMessage(sc.slots, sc.minFreeRamGb, now) };
}

module.exports = {
  MAX_SLOTS,
  io,
  staleMs,
  heartbeatMs,
  slotsDir,
  slotFile,
  lockFile,
  slotConfig,
  freeRamGb,
  readClaim,
  isLive,
  isOver,
  tryTake,
  holders,
  holderText,
  busyMessage,
  acquire,
  owns,
  heartbeat,
  release,
  releaseSession,
  plan,
};
