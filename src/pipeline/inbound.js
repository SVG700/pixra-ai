'use strict';
// Entry point for every inbound message (real webhook or dev simulator).
//  - dedup by WhatsApp message id (in-memory fast path + unique DB column)
//  - one queue per phone number, so a customer's messages are handled in order
//  - resolves media (download, store, transcribe) then hands off to the conversation handler
const db = require('../services/db');
const whatsapp = require('../services/whatsapp');
const { transcribeVoiceNote } = require('./transcribe');
const log = require('../logger');
const conversation = require('./conversation');

const SEEN_MAX = 5000;
const seen = new Set();
const queues = new Map(); // phone -> tail promise
const pending = new Set();

function remember(id) {
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm' };
const extFor = (mime) => EXT[String(mime || '').split(';')[0].trim()] || 'bin';

async function loadMedia(msg) {
  if (msg.mediaBuffer) return { buffer: msg.mediaBuffer, mimeType: msg.mimeType };
  if (msg.channel === 'telegram') return require('../services/telegram').downloadMedia(msg.mediaId);
  return whatsapp.downloadMedia(msg.mediaId);
}

async function processMessage(msg) {
  const plog = log.child({ phone: msg.from });
  if (await db.hasMessage(msg.waMessageId)) {
    plog.info(`duplicate message ${msg.waMessageId} ignored (db)`);
    return;
  }

  let customer = await db.getCustomerByPhone(msg.from);
  if (!customer) {
    customer = await db.createCustomer({
      phone: msg.from, name: msg.name || null, simulated: !!msg.simulated,
      channel: msg.channel || (msg.simulated ? 'dev' : 'whatsapp'),
    });
    plog.info('new customer created');
  } else if (msg.name && !customer.name) {
    customer = await db.updateCustomer(customer.id, { name: msg.name });
  }

  let content = msg.text || '';
  let mediaUrl = null;
  let mediaBuffer = null;

  if (msg.type === 'image' || msg.type === 'audio') {
    try {
      const media = await loadMedia(msg);
      mediaBuffer = media.buffer;
      // Telegram downloads carry no content type, so fall back to the type from the message itself.
      const mime = media.mimeType || msg.mimeType;
      const key = `inbound/${customer.id}/${msg.waMessageId.replace(/[^\w.-]/g, '_')}.${extFor(mime)}`;
      mediaUrl = await db.uploadFile(key, media.buffer, mime || 'application/octet-stream');
      msg.mimeType = mime;
    } catch (err) {
      plog.error(`could not fetch ${msg.type} media`, { err });
      msg.mediaError = true;
    }
  }

  if (msg.type === 'audio' && mediaBuffer) {
    try {
      const t = await transcribeVoiceNote(mediaBuffer, msg.mimeType, plog);
      content = t.text;
      plog.info(`voice note transcribed (${content.length} chars${t.converted ? ', after WAV conversion' : ''})`);
    } catch (err) {
      plog.error('voice note transcription failed', { err });
      msg.mediaError = true;
    }
  }

  const saved = await db.insertMessage({
    customer_id: customer.id,
    wa_message_id: msg.waMessageId,
    direction: 'in',
    type: msg.type,
    content,
    media_url: mediaUrl,
  });
  if (!saved) {
    plog.info(`duplicate message ${msg.waMessageId} ignored (insert race)`);
    return;
  }
  plog.info(`<- ${msg.type}: ${content.slice(0, 60).replace(/\s+/g, ' ')}`);

  try {
    await conversation.handle({ customer, message: { ...msg, content, mediaUrl, mediaBuffer, dbId: saved.id } });
  } catch (err) {
    plog.error('conversation handler failed', { err });
    try {
      await require('./outbound').sendText(customer, "Sorry, something went wrong on our side 🙏 Please send your last message again in a minute.");
    } catch (sendErr) {
      plog.error('could not send apology either', { err: sendErr });
    }
  }
}

// Queue a message for processing. Returns the processing promise, or null if it's a duplicate.
function enqueue(msg) {
  if (!msg.waMessageId || !msg.from) return null;
  if (seen.has(msg.waMessageId)) {
    log.info(`duplicate message ${msg.waMessageId} ignored (memory)`, { phone: msg.from });
    return null;
  }
  remember(msg.waMessageId);

  const prev = queues.get(msg.from) || Promise.resolve();
  const p = prev.then(() => processMessage(msg)).catch((err) => {
    log.error('failed to process inbound message', { phone: msg.from, err });
  });
  queues.set(msg.from, p);
  pending.add(p);
  p.finally(() => {
    pending.delete(p);
    if (queues.get(msg.from) === p) queues.delete(msg.from);
  });
  return p;
}

// Resolves once all queued inbound work has finished (used by tests).
async function idle() {
  while (pending.size) await Promise.allSettled([...pending]);
}

module.exports = { enqueue, idle };
