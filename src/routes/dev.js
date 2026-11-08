'use strict';
// Dev-only simulator (mounted only when DEV_MODE=true). Runs the exact same pipeline as the
// webhook, but the customer is flagged "simulated" so replies are stored, not sent to WhatsApp.
const crypto = require('crypto');
const express = require('express');
const db = require('../services/db');
const inbound = require('../pipeline/inbound');

const config = require('../config');

const router = express.Router();

// Every /dev route is a hard 404 unless DEV_MODE=true (and never in production).
router.use((req, res, next) => {
  if (config.devMode && !config.isProduction) return next();
  return res.status(404).type('text/plain').send('Not found');
});

const cleanPhone = (p) => String(p || '').replace(/\D/g, '');

router.get('/chat', (_req, res) => res.render('dev-chat'));

// POST /dev/simulate { phone, text?, name?, image_base64?, audio_base64?, mime?, wait? }
router.post('/simulate', async (req, res) => {
  const { text = '', name = null, image_base64: imageB64, audio_base64: audioB64, mime, wait = true } = req.body || {};
  const phone = cleanPhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const existing = await db.getCustomerByPhone(phone);
  if (existing && !existing.simulated) {
    return res.status(400).json({ error: 'this phone belongs to a real WhatsApp customer; use a different test number' });
  }

  const msg = {
    waMessageId: `dev-in-${crypto.randomUUID()}`,
    from: phone,
    name,
    timestamp: new Date().toISOString(),
    simulated: true,
    channel: 'dev',
    type: 'text',
    text: String(text),
  };
  if (imageB64) Object.assign(msg, { type: 'image', mediaBuffer: Buffer.from(imageB64, 'base64'), mimeType: mime || 'image/png' });
  else if (audioB64) Object.assign(msg, { type: 'audio', mediaBuffer: Buffer.from(audioB64, 'base64'), mimeType: mime || 'audio/ogg' });
  else if (!msg.text.trim()) return res.status(400).json({ error: 'text, image_base64 or audio_base64 is required' });

  const p = inbound.enqueue(msg);
  if (wait && p) await p;
  res.json({ ok: true, id: msg.waMessageId });
});

// GET /dev/messages?phone=...  -> chat history for the simulator page
router.get('/messages', async (req, res) => {
  const customer = await db.getCustomerByPhone(cleanPhone(req.query.phone));
  if (!customer) return res.json({ messages: [] });
  const [messages, convo] = await Promise.all([db.listMessages(customer.id), db.getConversation(customer.id)]);
  res.json({ customer, conversation: convo, messages });
});

module.exports = router;
