'use strict';
// Telegram channel: real Bot API, mock (MOCK_MODE / missing token in DEV_MODE), or disabled.
const config = require('../../config');
const log = require('../../logger');
const { select, modes } = require('../select');

function disabled() {
  modes.telegram = 'disabled';
  const fail = () => { throw new Error('Telegram not configured (TELEGRAM_ENABLED=false)'); };
  return {
    kind: 'disabled', sendMessage: fail, sendPhoto: fail, sendDocument: fail, downloadMedia: fail,
    getUpdates: fail, deleteWebhook: fail, setWebhook: fail, getWebhookInfo: fail, getMe: fail,
  };
}

if (config.telegram.enabled) log.info('telegram: channel enabled');

module.exports = config.telegram.enabled
  ? select('telegram', {
    required: { TELEGRAM_BOT_TOKEN: config.telegram.botToken },
    real: () => require('./api').createTelegramApi(config.telegram),
    mock: () => require('./mock').createMockTelegram(),
  })
  : disabled();
