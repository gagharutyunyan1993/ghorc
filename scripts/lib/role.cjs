'use strict';
// The one reader of GHORC_ROLE: trimmed and lowercased, so 'worker ', 'Worker' and 'WORKER' are all the worker role.
const role = () => String(process.env.GHORC_ROLE || '').trim().toLowerCase();

module.exports = { role, isWorker: () => role() === 'worker', isLead: () => role() === 'lead' };
