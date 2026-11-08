'use strict';
// Central config. Every tunable (model names, API versions, limits) comes from env vars.
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const env = process.env;
const str = (v, def = '') => (v === undefined || String(v).trim() === '' ? def : String(v).trim());
const flag = (v, def = false) => (str(v) === '' ? def : /^(1|true|yes|on)$/i.test(str(v)));
const int = (v, def) => {
  const n = parseInt(str(v), 10);
  return Number.isFinite(n) ? n : def;
};

const config = {
  root: ROOT,
  port: int(env.PORT, 3000),
  // Absolute URL of this app (used for links in WhatsApp messages). Render sets RENDER_EXTERNAL_URL.
  publicBaseUrl: str(env.PUBLIC_BASE_URL, str(env.RENDER_EXTERNAL_URL)).replace(/\/+$/, ''),
  mockMode: flag(env.MOCK_MODE, false),
  devMode: flag(env.DEV_MODE, false),
  // Production = NODE_ENV=production, or neither mock nor dev mode. Enables all startup safety checks.
  isProduction: str(env.NODE_ENV) === 'production' || (!flag(env.MOCK_MODE, false) && !flag(env.DEV_MODE, false)),
  logLevel: str(env.LOG_LEVEL, 'info'),
  ffmpegPath: str(env.FFMPEG_PATH), // optional: use a system ffmpeg instead of ffmpeg-static

  // Local mock storage (only used when Supabase is mocked)
  dataDir: path.resolve(ROOT, str(env.DATA_DIR, 'data')),
  uploadsDir: path.resolve(ROOT, str(env.UPLOADS_DIR, 'uploads')),

  whatsapp: {
    // false = web demo mode: no WhatsApp variables needed, /webhook answers 503, customers use /demo.
    enabled: flag(env.WHATSAPP_ENABLED, true),
    token: str(env.WHATSAPP_TOKEN),
    phoneNumberId: str(env.WHATSAPP_PHONE_NUMBER_ID),
    verifyToken: str(env.WHATSAPP_VERIFY_TOKEN),
    appSecret: str(env.WHATSAPP_APP_SECRET),
    // Dev-only escape hatch: skip X-Hub-Signature-256 checks (ignored in production).
    skipSignature: flag(env.WEBHOOK_SKIP_SIGNATURE, false),
    graphApiVersion: str(env.GRAPH_API_VERSION, 'v21.0'),
  },
  telegram: {
    // Third customer channel (alongside WhatsApp and the /demo web chat).
    enabled: flag(env.TELEGRAM_ENABLED, false),
    botToken: str(env.TELEGRAM_BOT_TOKEN),
    // Sent by Telegram in X-Telegram-Bot-Api-Secret-Token on every webhook call (set via setWebhook).
    webhookSecret: str(env.TELEGRAM_WEBHOOK_SECRET),
    // Long polling (getUpdates) instead of the webhook - only when DEV_MODE=true, never in production.
    polling: flag(env.TELEGRAM_POLLING, flag(env.DEV_MODE, false)),
    apiBase: str(env.TELEGRAM_API_BASE, 'https://api.telegram.org'),
  },
  gemini: {
    apiKey: str(env.GEMINI_API_KEY),
    model: str(env.GEMINI_MODEL, 'gemini-3.5-flash-lite'),
    fallbackModel: str(env.GEMINI_FALLBACK_MODEL), // optional, used on "model not found" or persistent 429
    apiVersion: str(env.GEMINI_API_VERSION, 'v1beta'),
  },
  cloudflare: {
    accountId: str(env.CF_ACCOUNT_ID),
    apiToken: str(env.CF_API_TOKEN),
    imageModel: str(env.CF_IMAGE_MODEL, '@cf/black-forest-labs/flux-1-schnell'),
    imageSteps: int(env.CF_IMAGE_STEPS, 4),
    whisperModel: str(env.CF_WHISPER_MODEL, '@cf/openai/whisper-large-v3-turbo'),
  },
  images: {
    // Which generator makes poster backgrounds: cloudflare | huggingface | compare
    // (compare = version 1 from Hugging Face, version 2 from Cloudflare, to compare quality).
    provider: str(env.IMAGE_PROVIDER, 'cloudflare').toLowerCase(),
    // If Hugging Face fails (out of credits, quota, auth, model gone, timeout) use Cloudflare instead.
    fallbackEnabled: flag(env.IMAGE_FALLBACK_ENABLED, true),
  },
  huggingface: {
    token: str(env.HF_TOKEN),
    imageModel: str(env.HF_IMAGE_MODEL, 'black-forest-labs/FLUX.1-schnell'),
    // "auto" = first provider in your HF settings order, or a specific one such as fal-ai / nscale.
    inferenceProvider: str(env.HF_INFERENCE_PROVIDER, 'auto'),
    // Optional organization to bill (X-HF-Bill-To), e.g. when PRO/Team credits belong to an org.
    billTo: str(env.HF_BILL_TO),
    imageSteps: int(env.HF_IMAGE_STEPS, 4),
    timeoutMs: int(env.HF_TIMEOUT_MS, 90000),
  },
  supabase: {
    url: str(env.SUPABASE_URL),
    serviceRoleKey: str(env.SUPABASE_SERVICE_ROLE_KEY),
    bucket: str(env.SUPABASE_BUCKET, 'posters'),
  },
  admin: {
    password: str(env.ADMIN_PASSWORD),
    sessionSecret: str(env.SESSION_SECRET),
  },
  limits: {
    webhookPerMinute: int(env.WEBHOOK_RATE_LIMIT_PER_MIN, 600), // per IP (WhatsApp and Telegram webhooks)
    loginAttempts: int(env.ADMIN_LOGIN_MAX_ATTEMPTS, 5), // per IP per 15 minutes
  },
  demo: {
    // Allowed numbers for "Send test poster" (empty = any)
    testNumbers: str(env.DEMO_TEST_NUMBERS).split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
    // Password for the customer web demo chat at /demo (separate from ADMIN_PASSWORD)
    password: str(env.DEMO_PASSWORD),
    messagesPer10Min: int(env.DEMO_RATE_LIMIT_PER_10MIN, 40), // per IP
  },
  business: {
    deliveryHours: int(env.DELIVERY_HOURS, 3),
    timezone: str(env.DISPLAY_TIMEZONE, 'Asia/Kolkata'),
  },
};

module.exports = config;
