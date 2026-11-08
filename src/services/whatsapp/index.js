'use strict';
const config = require('../../config');
const log = require('../../logger');
const { select, modes } = require('../select');

// WHATSAPP_ENABLED=false (web demo mode): no WhatsApp keys needed; any attempt to use WhatsApp
// fails with a clear error. Customers then use the /demo web chat (channel "web").
function disabled() {
  modes.whatsapp = 'disabled';
  log.info('whatsapp: disabled (WHATSAPP_ENABLED=false) - web demo mode');
  const fail = () => { throw new Error('WhatsApp not configured (WHATSAPP_ENABLED=false)'); };
  return { kind: 'disabled', sendText: fail, sendImage: fail, downloadMedia: fail };
}

module.exports = config.whatsapp.enabled
  ? select('whatsapp', {
    required: { WHATSAPP_TOKEN: config.whatsapp.token, WHATSAPP_PHONE_NUMBER_ID: config.whatsapp.phoneNumberId },
    real: () => require('./graph').createGraphWhatsApp(config.whatsapp),
    mock: () => require('./mock').createMockWhatsApp(),
  })
  : disabled();
