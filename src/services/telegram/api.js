'use strict';
// Real Telegram Bot API client (plain fetch, no framework).
// The bot token is part of every URL, so URLs are never logged and errors never include them.
const { fetchWithRetry } = require('../../lib/http');

const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

// Our messages use WhatsApp-style *bold*. Telegram gets HTML (safe for any user text).
function toTelegramHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function createTelegramApi({ botToken, apiBase = 'https://api.telegram.org' }) {
  const method = (name) => `${apiBase}/bot${botToken}/${name}`;

  // Calls a Bot API method. body: plain object (JSON) or FormData (multipart uploads).
  async function call(name, body, { timeoutMs = 60000, retries = 3 } = {}) {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    let res;
    try {
      res = await fetchWithRetry(method(name), {
        method: 'POST',
        headers: isForm ? {} : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body || {}),
      }, { label: `telegram ${name}`, retries, timeoutMs });
    } catch (err) {
      // fetchWithRetry already prefixes "telegram <method>:" - just make sure the token can't leak.
      throw new Error(String(err.message).split(botToken).join('<token>'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const e = new Error(`telegram ${name}: HTTP ${res.status} ${data.error_code || ''} ${String(data.description || '').slice(0, 300)}`.trim());
      e.status = res.status;
      e.telegramCode = data.error_code;
      throw e;
    }
    return data.result;
  }

  const fileForm = (chatId, field, buffer, filename, mimeType, caption) => {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append(field, new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);
    if (caption) {
      fd.append('caption', toTelegramHtml(caption).slice(0, MAX_CAPTION));
      fd.append('parse_mode', 'HTML');
    }
    return fd;
  };

  return {
    kind: 'telegram',

    getMe: () => call('getMe', {}),

    async sendMessage(chatId, text) {
      const r = await call('sendMessage', { chat_id: chatId, text: toTelegramHtml(text).slice(0, MAX_TEXT), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return { id: `tg-out-${r.message_id}` };
    },

    // Uploads the image bytes (works with local and Supabase storage; Telegram compresses photos).
    async sendPhoto(chatId, buffer, { caption = '', filename = 'poster.jpg', mimeType = 'image/jpeg' } = {}) {
      const r = await call('sendPhoto', fileForm(chatId, 'photo', buffer, filename, mimeType, caption), { timeoutMs: 120000 });
      return { id: `tg-out-${r.message_id}` };
    },

    // Same file as an uncompressed document (full quality for printing/sharing).
    async sendDocument(chatId, buffer, { caption = '', filename = 'poster.jpg', mimeType = 'image/jpeg' } = {}) {
      const r = await call('sendDocument', fileForm(chatId, 'document', buffer, filename, mimeType, caption), { timeoutMs: 120000 });
      return { id: `tg-out-${r.message_id}` };
    },

    // file_id -> bytes (getFile, then download from the file endpoint).
    async downloadMedia(fileId) {
      const f = await call('getFile', { file_id: fileId });
      if (!f?.file_path) throw new Error('telegram getFile: no file_path (file may be larger than 20 MB)');
      let res;
      try {
        res = await fetchWithRetry(`${apiBase}/file/bot${botToken}/${f.file_path}`, {}, { label: 'telegram file download', timeoutMs: 60000 });
      } catch (err) {
        throw new Error(`telegram file download: ${String(err.message).split(botToken).join('<token>')}`);
      }
      if (!res.ok) throw new Error(`telegram file download: HTTP ${res.status}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: null, filePath: f.file_path };
    },

    // Long polling (DEV only). timeout is seconds Telegram holds the request open.
    getUpdates: ({ offset, timeout = 25 } = {}) => call('getUpdates', { offset, timeout, allowed_updates: ['message'] }, { timeoutMs: (timeout + 15) * 1000, retries: 0 }),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false }),
    setWebhook: ({ url, secretToken }) => call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'], max_connections: 10 }),
    getWebhookInfo: () => call('getWebhookInfo', {}),
  };
}

module.exports = { createTelegramApi, toTelegramHtml };
