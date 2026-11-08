'use strict';
// Tiny structured logger. Use log.child({ jobId }) so every line for a job carries its id.
// Privacy: phone numbers are masked (91XXXXXX1234) and configured secret values are redacted
// from every log line, including error messages.
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

// 91XXXXXX1234: keep country code-ish prefix (2 digits) and last 4. "tg:<chat id>" -> tg:XXXXX6789
function maskPhone(p) {
  if (String(p ?? '').startsWith('tg:')) return `tg:${maskId(String(p).slice(3))}`;
  const d = String(p ?? '').replace(/\D/g, '');
  if (d.length < 7) return d ? 'X'.repeat(d.length) : '';
  return `${d.slice(0, 2)}${'X'.repeat(d.length - 6)}${d.slice(-4)}`;
}

// Any run of 10-15 digits (optionally +, spaces or dashes between) is treated as a phone number.
const PHONE_RE = /(?<![\w.])\+?\d(?:[ -]?\d){9,14}(?![\w])/g;

// Secret values from config (>= 8 chars) are replaced wherever they appear.
const SECRETS = [
  config.whatsapp.token, config.whatsapp.appSecret, config.whatsapp.verifyToken, config.gemini.apiKey,
  config.cloudflare.apiToken, config.supabase.serviceRoleKey, config.admin.password, config.admin.sessionSecret,
  config.telegram?.botToken, config.telegram?.webhookSecret, config.demo?.password, config.huggingface?.token,
].filter((s) => s && s.length >= 8);

// Telegram chat ids ("tg:123456789", "chat 123456789", chat_id":123456789) -> tg:XXXXX6789
const TG_RE = /\b(tg:|chat[ _]?id"?:?\s*"?|chat\s)(-?\d{5,})/gi;
const maskId = (id) => `${'X'.repeat(Math.max(0, id.length - 4))}${id.slice(-4)}`;

function scrub(text) {
  let s = String(text);
  for (const secret of SECRETS) s = s.split(secret).join('[redacted]');
  s = s.replace(/bot\d+:[A-Za-z0-9_-]{30,}/g, 'bot[redacted]'); // any bot token in a URL
  s = s.replace(/hf_[A-Za-z0-9]{20,}/g, 'hf_[redacted]'); // any Hugging Face token
  s = s.replace(TG_RE, (_m, prefix, id) => `${prefix}${maskId(id.replace('-', ''))}`);
  return s.replace(PHONE_RE, (m) => maskPhone(m));
}

function format(level, bindings, msg, extra) {
  const ctx = { ...bindings, ...extra };
  const tags = [];
  if (ctx.jobId) tags.push(`job:${String(ctx.jobId).slice(0, 8)}`);
  if (ctx.phone) tags.push(String(ctx.phone).startsWith('tg:') ? `tg:${maskId(String(ctx.phone).slice(3))}` : `ph:${maskPhone(ctx.phone)}`);
  const { jobId, phone, err, ...rest } = ctx;
  let body = msg;
  if (Object.keys(rest).length) body += ` ${JSON.stringify(rest)}`;
  if (err) body += ` :: ${err.message || err}${threshold <= LEVELS.debug && err.stack ? `\n${err.stack}` : ''}`;
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${tags.length ? `[${tags.join(' ')}] ` : ''}${scrub(body)}`;
}

function make(bindings = {}) {
  const emit = (level) => (msg, extra) => {
    if (LEVELS[level] < threshold) return;
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(format(level, bindings, msg, extra));
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (more) => make({ ...bindings, ...more }),
  };
}

module.exports = make();
module.exports.maskPhone = maskPhone;
module.exports.scrub = scrub;
