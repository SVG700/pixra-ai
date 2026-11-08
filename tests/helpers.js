'use strict';
// Shared test setup: isolated temp data dir, MOCK_MODE, app on a random port.
// Must be required BEFORE any src/ module (config is read at require time).
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixra-test-'));
Object.assign(process.env, {
  MOCK_MODE: 'true',
  DEV_MODE: 'true',
  DATA_DIR: path.join(tmp, 'data'),
  UPLOADS_DIR: path.join(tmp, 'uploads'),
  WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  WEBHOOK_SKIP_SIGNATURE: 'false',
  NODE_ENV: 'test',
  // Hermetic: never inherit the developer's .env (real keys, web demo mode, etc.).
  // dotenv does not override variables that already exist, even when empty.
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  DEMO_PASSWORD: '',
  DEMO_TEST_NUMBERS: '',
  GEMINI_API_KEY: '',
  GEMINI_FALLBACK_MODEL: '',
  CF_ACCOUNT_ID: '',
  CF_API_TOKEN: '',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  FFMPEG_PATH: '',
  TELEGRAM_ENABLED: 'false',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_WEBHOOK_SECRET: '',
  TELEGRAM_POLLING: 'false',
  IMAGE_PROVIDER: 'cloudflare',
  IMAGE_FALLBACK_ENABLED: 'true',
  HF_TOKEN: '',
  HF_BILL_TO: '',
  HF_INFERENCE_PROVIDER: 'auto',
  HF_IMAGE_MODEL: 'black-forest-labs/FLUX.1-schnell',
  ADMIN_PASSWORD: 'test-admin',
  SESSION_SECRET: 'test-session-secret-123456',
  LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
  PUBLIC_BASE_URL: '',
});

async function startApp() {
  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

// Builds a minimal Meta webhook payload with one text message.
function textWebhook({ id, from = '919800000001', body = 'hello', name = 'Test User' }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID' },
          contacts: [{ profile: { name }, wa_id: from }],
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
        },
      }],
    }],
  };
}

// POSTs a webhook payload signed like Meta does (HMAC-SHA256 of the raw body).
function signedWebhook(base, payload, { secret = 'test-app-secret', signature, raw } = {}) {
  const body = raw ?? JSON.stringify(payload);
  const sig = signature !== undefined
    ? signature
    : `sha256=${require('crypto').createHmac('sha256', secret).update(body).digest('hex')}`;
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) },
    body,
  });
}

module.exports = { tmp, startApp, textWebhook, signedWebhook };
