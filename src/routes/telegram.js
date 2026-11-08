'use strict';
// Telegram webhook: POST /telegram/webhook
// Telegram sends X-Telegram-Bot-Api-Secret-Token = the secret_token we passed to setWebhook.
// It is compared in constant time with TELEGRAM_WEBHOOK_SECRET; anything else gets 401.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const log = require('../logger');
const { rateLimit } = require('../lib/rate-limit');
const { handleUpdate } = require('../services/telegram/updates');

const router = express.Router();

function validSecret(header) {
  const expected = config.telegram.webhookSecret;
  if (!expected || !header) return false;
  const a = crypto.createHash('sha256').update(String(header)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

router.post(
  '/telegram/webhook',
  (req, res, next) => (config.telegram.enabled ? next() : res.status(503).type('text/plain').send('Telegram not configured')),
  rateLimit({ name: 'telegram webhook', windowMs: 60 * 1000, max: () => config.limits.webhookPerMinute }),
  express.json({ limit: '1mb' }),
  (req, res) => {
    if (!validSecret(req.get('x-telegram-bot-api-secret-token'))) {
      log.warn(`telegram webhook rejected (401): ${req.get('x-telegram-bot-api-secret-token') ? 'wrong' : 'missing'} secret token`, { ip: req.ip });
      return res.sendStatus(401);
    }
    res.sendStatus(200); // answer fast; Telegram retries slow or failed deliveries
    handleUpdate(req.body);
  },
);

module.exports = router;
module.exports.validSecret = validSecret;
