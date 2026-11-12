'use strict';
// The one reader of GHORC_ROLE: trimmed and lowercased, so 'worker ', 'Worker' and 'WORKER' are all the worker role.
const roleOf = (env = process.env) => String(env.GHORC_ROLE || '').trim().toLowerCase();
const role = () => roleOf();

// Is this session a lead that may be blocked (the sticky handoff block)? Order: GHORC_ROLE=lead -> yes; GHORC_ROLE=worker
// -> never; no role -> only if the terminal proves it (lib/backend.cjs terminalIsLead: on hc the terminal name starts with
// capacity.leadNamePrefix or it has no parent; on herdr the tab label starts with the prefix without its dash). A failed or
// timed-out lookup is "not proven": a false block on a worker is worse than a missed block. The lookup is asked only when
// the role variable does not answer. opts: { env, exec, session, leadPrefix, prefer, cwd }. Never throws.
function provenLead(opts = {}) {
  try {
    const r = roleOf(opts.env || process.env);
    if (r === 'lead') return true;
    if (r === 'worker') return false;
    return require('./backend.cjs').terminalIsLead(opts) === true;
  } catch {
    return false;
  }
}

module.exports = { role, roleOf, provenLead, isWorker: () => role() === 'worker', isLead: () => role() === 'lead' };
