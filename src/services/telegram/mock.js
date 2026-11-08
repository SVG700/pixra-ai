'use strict';
// Mock Telegram: logs instead of calling the Bot API and records what would have been sent
// (the `sent` array is handy in tests). Outgoing messages are still stored by outbound.js.
const log = require('../../logger');

function createMockTelegram() {
  let n = 0;
  const sent = [];
  const record = (type, chatId, extra) => {
    sent.push({ type, chatId, ...extra });
    log.info(`telegram(mock) ${type}`, { phone: `tg:${chatId}` });
    return { id: `tg-mock-${++n}` };
  };
  return {
    kind: 'mock',
    sent,
    async getMe() { return { username: 'pixra_mock_bot', first_name: 'PIXRA mock' }; },
    async sendMessage(chatId, text) { return record('message', chatId, { text }); },
    async sendPhoto(chatId, buffer, { caption = '' } = {}) { return record('photo', chatId, { caption, bytes: buffer.length }); },
    async sendDocument(chatId, buffer, { caption = '', filename } = {}) { return record('document', chatId, { caption, filename, bytes: buffer.length }); },
    async downloadMedia(fileId) { throw new Error(`telegram(mock) cannot download file ${fileId}`); },
    // Waits like real long polling: returning at once would spin the poller loop and freeze the server.
    async getUpdates({ timeout = 0 } = {}) {
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(timeout, 50)) * 1000));
      return [];
    },
    async deleteWebhook() { return true; },
    async setWebhook() { return true; },
    async getWebhookInfo() { return { url: '' }; },
  };
}

module.exports = { createMockTelegram };
