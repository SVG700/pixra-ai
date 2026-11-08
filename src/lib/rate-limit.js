'use strict';
// Tiny in-memory fixed-window rate limiter (single instance app, so memory is enough).
const log = require('../logger');

function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  const limitOf = () => (typeof max === 'function' ? max() : max);
  return {
    // Returns { allowed, remaining, retryAfterSec }
    hit(key) {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || h.resetAt <= now) {
        h = { count: 0, resetAt: now + windowMs };
        hits.set(key, h);
      }
      h.count++;
      if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      const allowed = h.count <= limitOf();
      return { allowed, remaining: Math.max(0, limitOf() - h.count), retryAfterSec: Math.ceil((h.resetAt - now) / 1000) };
    },
    peek(key) {
      const h = hits.get(key);
      return !!h && h.resetAt > Date.now() && h.count >= limitOf();
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// Express middleware: 429 + Retry-After when an IP exceeds the limit.
function rateLimit({ name, windowMs, max, key = (req) => req.ip }) {
  const limiter = createLimiter({ windowMs, max });
  return (req, res, next) => {
    const r = limiter.hit(key(req));
    if (r.allowed) return next();
    log.warn(`${name}: rate limit exceeded`, { ip: req.ip });
    res.set('Retry-After', String(r.retryAfterSec));
    return res.status(429).type('text/plain').send('Too many requests');
  };
}

module.exports = { createLimiter, rateLimit };
