'use strict';
// Mock WhatsApp: logs instead of sending. Outgoing messages are still stored in the
// messages table by pipeline/outbound.js, so the /dev/chat page and admin portal show them.
const crypto = require('crypto');
const log = require('../../logger');

function createMockWhatsApp() {
  return {
    kind: 'mock',
    async sendText(to, text) {
      log.info('whatsapp(mock) sendText', { phone: to, preview: String(text).slice(0, 80) });
      return { id: `mock-out-${crypto.randomUUID()}` };
    },
    async sendImage(to, link, caption = '') {
      log.info('whatsapp(mock) sendImage', { phone: to, link, caption: String(caption).slice(0, 80) });
      return { id: `mock-out-${crypto.randomUUID()}` };
    },
    async downloadMedia(mediaId) {
      throw new Error(`whatsapp(mock) cannot download media ${mediaId}; use the /dev simulator to send files`);
    },
  };
}

module.exports = { createMockWhatsApp };
