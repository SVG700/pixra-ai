'use strict';
// Meta WhatsApp webhook: GET = verification handshake, POST = incoming events.
// POST bodies are verified with X-Hub-Signature-256 = HMAC-SHA256(raw body, WHATSAPP_APP_SECRET).
// This router must be mounted BEFORE express.json() so it receives the untouched raw bytes.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const log = require('../logger');
const { parseWebhook } = require('../services/whatsapp/parse');
const inbound = require('../pipeline/inbound');
const { rateLimit } = require('../lib/rate-limit');

const router = express.Router();

// Web demo mode (WHATSAPP_ENABLED=false): the webhook is switched off entirely.
router.use('/webhook', (req, res, next) => {
  if (config.whatsapp.enabled) return next();
  return res.status(503).type('text/plain').send('WhatsApp not configured');
});

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
    log.info('webhook verified by Meta');
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  log.warn('webhook verification failed (check WHATSAPP_VERIFY_TOKEN)');
  return res.sendStatus(403);
});

// Skipping is possible ONLY in MOCK_MODE/DEV_MODE and ONLY with WEBHOOK_SKIP_SIGNATURE=true.
const canSkip = () => (config.mockMode || config.devMode) && !config.isProduction && config.whatsapp.skipSignature;

function verifySignature(raw, header) {
  if (canSkip()) return { ok: true, skipped: true };
  const secret = config.whatsapp.appSecret;
  if (!secret) return { ok: false, reason: 'WHATSAPP_APP_SECRET is not set' };
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || '').trim());
  if (!m) return { ok: false, reason: header ? 'malformed X-Hub-Signature-256 header' : 'missing X-Hub-Signature-256 header' };
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(m[1], 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

router.post(
  '/webhook',
  rateLimit({ name: 'webhook', windowMs: 60 * 1000, max: () => config.limits.webhookPerMinute }),
  express.raw({ type: () => true, limit: '2mb' }),
  (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifySignature(raw, req.get('x-hub-signature-256'));
    if (!check.ok) {
      log.warn(`webhook rejected (401): ${check.reason}`, { ip: req.ip });
      return res.sendStatus(401);
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      log.warn('webhook rejected (400): body is not valid JSON', { ip: req.ip });
      return res.sendStatus(400);
    }
    // Acknowledge immediately; Meta retries if we are slow.
    res.sendStatus(200);
    for (const msg of parseWebhook(body)) inbound.enqueue(msg);
  },
);

module.exports = router;
module.exports.verifySignature = verifySignature;
