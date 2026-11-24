'use strict';
// Claude API list prices, USD per 1M tokens, and the cost of one assistant message from its `usage`.
// The only place in ghorc that names model versions: a price belongs to one model id. Everything else uses aliases.
// A new model shows up as unpriced in `ledger.cjs report` until its row is added here.
// Estimates only: list prices as of PRICES_AS_OF, no discounts, no batch pricing. A model that is not in the table is
// unpriced (messageCost returns null); prices are never guessed for other models.
// Cache writes cost 1.25 x the input price for the 5-minute TTL and 2 x for the 1-hour TTL.

const PRICES_AS_OF = '2026-11-24';

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const FAST_MULTIPLIER = 2;

// Each entry has price tiers picked by the prompt length of the request (input + cache read + cache creation tokens):
// the first tier whose `upTo` is not below the prompt length applies.
const flat = (input, output, cacheRead) => [{ upTo: Infinity, input, output, cacheRead }];

const PRICES = {
  'claude-fable-5-2': flat(8, 40, 0.2),
  'claude-opus-5-5': flat(4, 20, 0.2),
  'claude-sonnet-5-5': flat(2, 10, 0.1),
  'claude-haiku-5-5': [
    { upTo: 100000, input: 0.1, output: 0.5, cacheRead: 0.01 },
    { upTo: Infinity, input: 0.5, output: 2.5, cacheRead: 0.05 },
  ],
};

const ALIASES = {
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

// Exact id, alias, or an id followed by a non-digit suffix (claude-opus-5-5[1m], claude-opus-5-5-20261101).
// claude-opus-5 and claude-opus-5-50 do not match claude-opus-5-5.
function priceKey(model) {
  if (typeof model !== 'string' || !model) return null;
  if (Object.hasOwn(PRICES, model)) return model;
  if (Object.hasOwn(ALIASES, model)) return ALIASES[model];
  for (const id of Object.keys(PRICES)) {
    if (model.startsWith(id) && !/^\d/.test(model.slice(id.length))) return id;
  }
  return null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// Cost of one message: { usd, ttlAssumed } or null for an unpriced model.
// ttlAssumed is true when the message wrote cache tokens without usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens,
// so all of them were priced at the 5-minute rate. usd is not rounded.
function messageCost(model, usage) {
  const key = priceKey(model);
  if (!key) return null;
  const u = usage && typeof usage === 'object' ? usage : {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const read = num(u.cache_read_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const w5 = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  const w1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const total = num(u.cache_creation_input_tokens);
  let write5 = total;
  let write1 = 0;
  let ttlAssumed = total > 0;
  if (w5 + w1 > 0) {
    write5 = w5;
    write1 = w1;
    ttlAssumed = false;
  }
  const prompt = input + read + (total || write5 + write1);
  const tier = PRICES[key].find((t) => prompt <= t.upTo);
  // Fast mode (usage.speed "fast", on the models that offer it) bills every token class at twice the standard rate.
  const speed = u.speed === 'fast' ? FAST_MULTIPLIER : 1;
  const usd =
    (speed *
      (input * tier.input +
        output * tier.output +
        read * tier.cacheRead +
        write5 * tier.input * CACHE_WRITE_5M +
        write1 * tier.input * CACHE_WRITE_1H)) /
    1e6;
  return { usd, ttlAssumed };
}

module.exports = { PRICES_AS_OF, PRICES, ALIASES, messageCost };
