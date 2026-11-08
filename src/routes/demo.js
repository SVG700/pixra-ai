'use strict';
// Customer web demo chat (/demo): the same conversation as WhatsApp, in the browser.
// Used when WhatsApp isn't connected yet (WHATSAPP_ENABLED=false). Protected by DEMO_PASSWORD and
// rate limited so strangers can't burn the free-tier quotas. Each demo customer gets channel "web":
// replies and approved posters are stored and shown here instead of being sent on WhatsApp.
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../services/db');
const log = require('../logger');
const inbound = require('../pipeline/inbound');
const { demoSession, secretMatches } = require('../lib/session');
const { createLimiter, rateLimit } = require('../lib/rate-limit');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: () => config.limits.loginAttempts });
const sendLimit = rateLimit({ name: 'demo send', windowMs: 10 * 60 * 1000, max: () => config.demo.messagesPer10Min });

const IMAGE_TYPES = /^image\/(png|jpe?g|webp)$/;
const AUDIO_TYPES = /^(audio\/(ogg|mpeg|mp3|mp4|m4a|x-m4a|aac|wav|x-wav|webm|opus)|video\/webm)(;.*)?$/;
const webPhone = (digits) => `web:${digits}`;

function renderLogin(res, { error = null, status = 200, name = '', phone = '' } = {}) {
  return res.status(status).render('demo/login', { error, configured: !!config.demo.password, name, phone });
}

// Loads the signed-in demo customer, or null.
async function currentCustomer(req) {
  const s = demoSession.get(req);
  if (!s?.cid) return null;
  const c = await db.getCustomer(s.cid);
  return c && c.channel === 'web' ? c : null;
}

async function requireDemo(req, res, next) {
  const c = await currentCustomer(req);
  if (!c) return res.status(401).json({ error: 'Please sign in to the demo again.' });
  req.demoCustomer = c;
  return next();
}

router.get('/', async (req, res) => {
  const c = await currentCustomer(req);
  if (!c) return renderLogin(res);
  return res.render('demo/chat', { name: c.name || 'there' });
});

router.post('/login', async (req, res) => {
  const ip = req.ip;
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (!config.demo.password) return renderLogin(res, { error: 'The demo is not enabled (DEMO_PASSWORD is not set).', status: 503 });
  if (loginLimiter.peek(ip)) {
    log.warn('demo login blocked by rate limit', { ip });
    return renderLogin(res, { error: 'Too many attempts. Try again in 15 minutes.', status: 429, name });
  }
  if (!secretMatches(req.body?.password, config.demo.password)) {
    loginLimiter.hit(ip);
    log.warn('demo login failed', { ip });
    return renderLogin(res, { error: 'Wrong demo password.', status: 401, name, phone });
  }
  if (!name) return renderLogin(res, { error: 'Please enter your name.', status: 400, phone });
  if (phone.length < 8 || phone.length > 15) {
    return renderLogin(res, { error: 'Enter your phone number with country code, e.g. 919876543210.', status: 400, name });
  }
  loginLimiter.reset(ip);

  let customer = await db.getCustomerByPhone(webPhone(phone));
  if (!customer) {
    customer = await db.createCustomer({ phone: webPhone(phone), name, channel: 'web', simulated: false });
    log.info('demo customer created', { phone });
  } else if (customer.name !== name) {
    customer = await db.updateCustomer(customer.id, { name });
  }
  demoSession.set(req, res, { cid: customer.id });
  return res.redirect('/demo');
});

router.post('/logout', (req, res) => {
  demoSession.clear(res);
  res.redirect('/demo');
});

// Chat history of the signed-in customer only (no phone parameter: you can't read other chats).
router.get('/messages', requireDemo, async (req, res) => {
  const c = req.demoCustomer;
  const messages = await db.listMessages(c.id, { limit: 300 });
  res.set('Cache-Control', 'no-store');
  res.json({
    messages: messages.map(({ id, direction, type, content, media_url: mediaUrl, created_at: createdAt }) => ({ id, direction, type, content, media_url: mediaUrl, created_at: createdAt })),
  });
});

// Send a message: text, or one file (image/logo or voice note), optionally with a caption.
router.post('/send', requireDemo, sendLimit, upload.single('file'), async (req, res) => {
  const c = req.demoCustomer;
  const text = String(req.body?.text || '').slice(0, 2000);
  const msg = {
    waMessageId: `web-in-${crypto.randomUUID()}`,
    from: c.phone,
    name: c.name,
    timestamp: new Date().toISOString(),
    simulated: false,
    channel: 'web',
    type: 'text',
    text,
  };
  if (req.file) {
    const mime = String(req.file.mimetype || '').toLowerCase();
    if (IMAGE_TYPES.test(mime)) Object.assign(msg, { type: 'image', mediaBuffer: req.file.buffer, mimeType: mime });
    else if (AUDIO_TYPES.test(mime)) Object.assign(msg, { type: 'audio', mediaBuffer: req.file.buffer, mimeType: mime.replace('video/', 'audio/') });
    else return res.status(400).json({ error: 'Send a JPG/PNG/WebP image or an audio voice note.' });
  } else if (!text.trim()) {
    return res.status(400).json({ error: 'Type a message first.' });
  }
  inbound.enqueue(msg);
  return res.json({ ok: true });
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload failed: ${err.message}` });
  return next(err);
});

module.exports = router;
