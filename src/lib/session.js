'use strict';
// Minimal signed-cookie session for the admin portal (HMAC-SHA256 with SESSION_SECRET).
// Stateless, so it survives Render restarts. Cookie is HttpOnly + SameSite=Lax (+ Secure on https).
const crypto = require('crypto');
const config = require('../config');
const log = require('../logger');

const COOKIE = 'pixra_admin';
const MAX_AGE_MS = 12 * 3600 * 1000;

let secret = config.admin.sessionSecret;
if (!secret || secret.length < 16) {
  secret = crypto.randomBytes(32).toString('hex');
  log.warn('SESSION_SECRET missing/short - using a random one (admin logins reset on every restart)');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// Browsers send the cookie with the most specific Path first; keep that one if a name repeats
// (e.g. a stale cookie from an older Path=/ version next to the current Path=/admin one).
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/**
 * A signed-cookie session type. `aud` is stored in the payload and checked on read, so a cookie of
 * one type (e.g. the customer demo chat) can never be replayed as another (e.g. the admin portal).
 */
function cookieSession({ cookie, path, aud, maxAgeMs = MAX_AGE_MS }) {
  return {
    get(req) {
      const payload = verify(parseCookies(req.headers.cookie)[cookie]);
      return payload && payload.aud === aud ? payload : null;
    },
    set(req, res, data) {
      res.cookie(cookie, sign({ ...data, aud, exp: Date.now() + maxAgeMs }), {
        httpOnly: true, // not readable from JavaScript
        sameSite: 'strict', // never sent on cross-site requests (CSRF protection for forms)
        secure: config.isProduction || req.secure, // https-only in production (Render terminates TLS)
        maxAge: maxAgeMs,
        path,
      });
      if (path !== '/') res.clearCookie(cookie, { path: '/' }); // drop any legacy root-path cookie
    },
    clear(res) {
      res.clearCookie(cookie, { path });
    },
  };
}

const adminSession = cookieSession({ cookie: COOKIE, path: '/admin', aud: 'admin' });
const demoSession = cookieSession({ cookie: 'pixra_demo', path: '/demo', aud: 'demo', maxAgeMs: 24 * 3600 * 1000 });

// Constant-time password check
function secretMatches(input, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
const passwordMatches = (input) => secretMatches(input, config.admin.password);

module.exports = {
  getSession: adminSession.get,
  setSession: adminSession.set,
  clearSession: adminSession.clear,
  demoSession,
  passwordMatches,
  secretMatches,
  sign,
  verify,
};
