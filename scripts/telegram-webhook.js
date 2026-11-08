'use strict';
// Registers the production Telegram webhook (with the secret token) - never prints the bot token.
//   npm run telegram:set-webhook -- https://<service>.onrender.com     register https://<service>.onrender.com/telegram/webhook
//   npm run telegram:set-webhook                                        uses PUBLIC_BASE_URL / RENDER_EXTERNAL_URL
//   npm run telegram:set-webhook -- --info                              show current webhook status
//   npm run telegram:set-webhook -- --delete                            remove it (e.g. to go back to local long polling)
// TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are read from .env and must be the SAME values as on Render.
const config = require('../src/config');
const { createTelegramApi } = require('../src/services/telegram/api');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const urlArg = args.find((a) => !a.startsWith('--'));

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

(async () => {
  const { botToken, webhookSecret } = config.telegram;
  if (!botToken) fail('TELEGRAM_BOT_TOKEN is not set in .env');
  const api = createTelegramApi(config.telegram);
  const me = await api.getMe().catch((e) => fail(`token rejected by Telegram: ${e.message}`));
  console.log(`bot: @${me.username}`);

  const show = async () => {
    const info = await api.getWebhookInfo();
    console.log(`webhook: ${info.url || '(none - long polling mode)'}`);
    console.log(`pending updates: ${info.pending_update_count ?? 0}`);
    if (info.last_error_message) console.log(`last error: ${info.last_error_message} (${new Date(info.last_error_date * 1000).toISOString()})`);
  };

  if (flags.has('--info')) return show();
  if (flags.has('--delete')) {
    await api.deleteWebhook();
    console.log('✔ webhook removed (local long polling can be used again)');
    return show();
  }

  if (!webhookSecret || webhookSecret.length < 32) fail('TELEGRAM_WEBHOOK_SECRET must be set (32+ characters) - the same value as on Render');
  const base = (urlArg || config.publicBaseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) fail('give the public https URL of the app, e.g. npm run telegram:set-webhook -- https://pixra-ai.onrender.com');
  const url = `${base}/telegram/webhook`;
  await api.setWebhook({ url, secretToken: webhookSecret });
  console.log(`✔ webhook set to ${url} (secret token attached)`);
  await show();
})().catch((e) => fail(e.message));
