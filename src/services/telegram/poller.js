'use strict';
// Long polling (getUpdates) for local development, so Telegram works without a public URL/tunnel.
// Only runs when TELEGRAM_ENABLED=true, DEV_MODE=true and TELEGRAM_POLLING is not false.
// Never in production (production uses the webhook: npm run telegram:set-webhook).
const config = require('../../config');
const log = require('../../logger');
const { handleUpdate } = require('./updates');

let running = false;
let stopRequested = false;

function shouldPoll() {
  return config.telegram.enabled && config.devMode && !config.isProduction && config.telegram.polling;
}

async function startPolling({ api = require('./index'), timeout = 25, errorDelayMs = 5000 } = {}) {
  if (running) return;
  running = true;
  stopRequested = false;
  try {
    // getUpdates and a webhook can't be used together: remove any webhook first.
    await api.deleteWebhook();
    const me = await api.getMe().catch(() => null);
    log.info(`telegram: long polling started${me?.username ? ` - message @${me.username} on Telegram` : ''}`);
  } catch (err) {
    log.error('telegram: could not start polling', { err });
    running = false;
    return;
  }
  let offset;
  while (!stopRequested) {
    try {
      const updates = await api.getUpdates({ offset, timeout });
      for (const u of updates || []) {
        offset = u.update_id + 1;
        handleUpdate(u);
      }
    } catch (err) {
      if (stopRequested) break;
      log.warn(`telegram: getUpdates failed, retrying in ${errorDelayMs / 1000}s`, { err });
      await new Promise((r) => setTimeout(r, errorDelayMs));
    }
  }
  running = false;
  log.info('telegram: long polling stopped');
}

function stopPolling() {
  stopRequested = true;
}

module.exports = { startPolling, stopPolling, shouldPoll, isPolling: () => running };
