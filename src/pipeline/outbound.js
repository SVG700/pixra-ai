'use strict';
// All outgoing messages go through here. Every message is stored in the messages table.
// Where it is delivered depends only on the customer's channel (no code change needed to switch):
//   whatsapp -> WhatsApp Cloud API          telegram -> Telegram Bot API (sendMessage / sendPhoto + sendDocument)
//   web      -> stored only; the /demo chat page shows it
//   dev      -> stored only (/dev simulator)
const crypto = require('crypto');
const config = require('../config');
const db = require('../services/db');
const whatsapp = require('../services/whatsapp');
const telegram = require('../services/telegram');
const log = require('../logger');

// Local storage returns "/uploads/..."; WhatsApp needs an absolute public URL.
function absoluteUrl(url) {
  if (!url || /^https?:\/\//i.test(url)) return url;
  return `${config.publicBaseUrl}${url}`;
}

const channelOf = (customer) => (customer.simulated ? 'dev' : customer.channel || 'whatsapp');
const telegramChatId = (customer) => String(customer.phone || '').replace(/^tg:/, '');

function ensureEnabled(channel) {
  if (channel === 'whatsapp' && !config.whatsapp.enabled) {
    throw new Error('WhatsApp not configured (WHATSAPP_ENABLED=false) - this customer can only be reached on WhatsApp');
  }
  if (channel === 'telegram' && !config.telegram.enabled) {
    throw new Error('Telegram not configured (TELEGRAM_ENABLED=false) - this customer can only be reached on Telegram');
  }
}

async function sendText(customer, text, { jobId } = {}) {
  const channel = channelOf(customer);
  let id;
  if (channel === 'whatsapp' || channel === 'telegram') {
    ensureEnabled(channel);
    const r = channel === 'whatsapp'
      ? await whatsapp.sendText(customer.phone, text)
      : await telegram.sendMessage(telegramChatId(customer), text);
    id = r?.id;
  }
  log.info(`-> text sent (${channel}): ${text.slice(0, 60).replace(/\s+/g, ' ')}`, { phone: customer.phone, jobId });
  return db.insertMessage({
    customer_id: customer.id, wa_message_id: id || `${channel}-out-${crypto.randomUUID()}`, direction: 'out', type: 'text', content: text,
  });
}

async function sendImage(customer, imageUrl, caption = '', { jobId } = {}) {
  const channel = channelOf(customer);
  let id;
  if (channel === 'whatsapp') {
    ensureEnabled(channel);
    const link = absoluteUrl(imageUrl);
    // Real WhatsApp fetches the image itself, so it must be a public https URL (the mock sends nothing).
    if (whatsapp.kind === 'graph' && !/^https:\/\//i.test(link || '')) {
      throw new Error(`cannot send image: "${link}" is not a public https URL (set PUBLIC_BASE_URL or use Supabase storage)`);
    }
    id = (await whatsapp.sendImage(customer.phone, link, caption))?.id;
  } else if (channel === 'telegram') {
    ensureEnabled(channel);
    // Upload the bytes (works for local and Supabase storage): a photo to view in the chat, plus the
    // same file as a document so the customer gets the full-quality, uncompressed poster.
    const buffer = await db.readFile(imageUrl);
    const chatId = telegramChatId(customer);
    const ext = /\.png($|\?)/i.test(imageUrl) ? 'png' : /\.webp($|\?)/i.test(imageUrl) ? 'webp' : 'jpg';
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    id = (await telegram.sendPhoto(chatId, buffer, { caption, filename: `poster.${ext}`, mimeType }))?.id;
    try {
      await telegram.sendDocument(chatId, buffer, { caption: 'Full-quality file for printing and sharing', filename: `pixra-poster.${ext}`, mimeType });
    } catch (err) {
      log.warn('telegram: full-quality document could not be sent (photo was delivered)', { phone: customer.phone, jobId, err });
    }
  }
  log.info(`-> image sent (${channel})`, { phone: customer.phone, jobId });
  return db.insertMessage({
    customer_id: customer.id, wa_message_id: id || `${channel}-out-${crypto.randomUUID()}`, direction: 'out', type: 'image', content: caption, media_url: imageUrl,
  });
}

module.exports = { sendText, sendImage, absoluteUrl, channelOf };
