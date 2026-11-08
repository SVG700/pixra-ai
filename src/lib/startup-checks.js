'use strict';
// Startup safety checks. server.js refuses to start when any "error" is returned;
// `npm run doctor -- --prod` prints the same list.
const config = require('../config');

const WEAK_PASSWORDS = new Set([
  'admin', 'administrator', 'password', 'password1', 'password123', 'changeme', 'change-me', 'changeme123',
  'letmein', 'welcome', 'qwerty', 'pixra', 'pixraai', 'pixra.ai', 'admin123', 'admin12345', 'adminadmin',
  '123456789012', 'qwertyuiop12', 'your-strong-password', 'your-password-here',
]);

// Real database required? Only MOCK_MODE (outside production) may use the local JSON store.
const requiresRealDb = () => !config.mockMode || config.isProduction;

function passwordProblem(name, pw) {
  if (!pw) return `${name} is not set`;
  if (pw.length < 12) return `${name} is too short (minimum 12 characters)`;
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) return `${name} is a default/common password - choose your own`;
  return null;
}
const adminPasswordProblem = (pw = config.admin.password) => passwordProblem('ADMIN_PASSWORD', pw);

// The web demo chat (/demo) has its own password; it must be strong and differ from the admin one.
function demoPasswordProblem(pw = config.demo.password) {
  const p = passwordProblem('DEMO_PASSWORD', pw);
  if (p) return p;
  if (pw === config.admin.password) return 'DEMO_PASSWORD must be different from ADMIN_PASSWORD';
  return null;
}

/** Synchronous config checks. Returns { errors: string[], warnings: string[] }. */
function checkConfig() {
  const errors = [];
  const warnings = [];
  const need = (value, name, why) => { if (!value) errors.push(`${name} is not set${why ? ` (${why})` : ''}`); };

  if (requiresRealDb()) {
    need(config.supabase.url, 'SUPABASE_URL', 'a real database is required when MOCK_MODE=false or in production');
    need(config.supabase.serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY', 'a real database is required when MOCK_MODE=false or in production');
  }

  if (config.isProduction) {
    if (config.mockMode) errors.push('MOCK_MODE=true is not allowed in production');
    const pw = adminPasswordProblem();
    if (pw) errors.push(pw);
    if (!config.admin.sessionSecret || config.admin.sessionSecret.length < 32) errors.push('SESSION_SECRET must be set to a random string of at least 32 characters');
    if (config.whatsapp.enabled) {
      need(config.whatsapp.token, 'WHATSAPP_TOKEN');
      need(config.whatsapp.phoneNumberId, 'WHATSAPP_PHONE_NUMBER_ID');
      need(config.whatsapp.verifyToken, 'WHATSAPP_VERIFY_TOKEN');
      need(config.whatsapp.appSecret, 'WHATSAPP_APP_SECRET', 'needed to verify webhook signatures');
    } else {
      // Web demo mode: ONLY the WhatsApp variables are skipped; /demo is the customer channel instead.
      const dp = demoPasswordProblem();
      if (dp) errors.push(`${dp} (required when WHATSAPP_ENABLED=false)`);
      warnings.push('WHATSAPP_ENABLED=false: web demo mode - customers use /demo, /webhook answers 503');
    }
    if (config.demo.password && config.whatsapp.enabled) {
      const dp = demoPasswordProblem();
      if (dp) errors.push(dp);
    }
    // Telegram variables are required only when the Telegram channel is switched on.
    if (config.telegram.enabled) {
      const tok = config.telegram.botToken;
      if (!tok) errors.push('TELEGRAM_BOT_TOKEN is not set (required when TELEGRAM_ENABLED=true)');
      else if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(tok)) errors.push('TELEGRAM_BOT_TOKEN does not look like a BotFather token (123456:ABC...)');
      const sec = config.telegram.webhookSecret;
      if (!sec) errors.push('TELEGRAM_WEBHOOK_SECRET is not set (required when TELEGRAM_ENABLED=true)');
      else if (sec.length < 32 || !/^[A-Za-z0-9_-]{1,256}$/.test(sec)) errors.push('TELEGRAM_WEBHOOK_SECRET must be 32-256 characters of A-Z a-z 0-9 _ -');
      if (config.telegram.polling && config.devMode) warnings.push('TELEGRAM_POLLING is ignored in production - the webhook is used');
    }
    // Image provider: Hugging Face is optional - without HF_TOKEN everything uses Cloudflare.
    if (!['cloudflare', 'huggingface', 'compare'].includes(config.images.provider)) {
      errors.push(`IMAGE_PROVIDER must be cloudflare, huggingface or compare (got "${config.images.provider}")`);
    } else if (config.images.provider !== 'cloudflare' && !config.huggingface.token) {
      warnings.push(`IMAGE_PROVIDER=${config.images.provider} but HF_TOKEN is empty - Hugging Face not configured, Cloudflare is used`);
    }
    need(config.gemini.apiKey, 'GEMINI_API_KEY');
    need(config.cloudflare.accountId, 'CF_ACCOUNT_ID');
    need(config.cloudflare.apiToken, 'CF_API_TOKEN');
    if (config.whatsapp.skipSignature) warnings.push('WEBHOOK_SKIP_SIGNATURE is ignored in production');
    if (config.devMode) warnings.push('DEV_MODE=true in production: the /dev simulator is reachable by anyone');
    if (!config.publicBaseUrl) warnings.push('PUBLIC_BASE_URL / RENDER_EXTERNAL_URL not set');
  } else {
    if (config.admin.password && adminPasswordProblem()) warnings.push(`${adminPasswordProblem()} (would block a production start)`);
  }
  return { errors, warnings };
}

/** Async checks that need the network. Returns { errors, warnings }. */
async function checkConnections(db, { timeoutMs = 15000 } = {}) {
  const errors = [];
  if (requiresRealDb()) {
    if (db.kind !== 'supabase') {
      errors.push(`database is "${db.kind}" but Supabase is required (never falls back to the local JSON store)`);
    } else {
      try {
        await Promise.race([
          db.ping(),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
        ]);
      } catch (err) {
        errors.push(`cannot connect to Supabase: ${err.message} (check SUPABASE_URL/KEY and that schema.sql was run)`);
      }
    }
  }
  return { errors, warnings: [] };
}

module.exports = { checkConfig, checkConnections, adminPasswordProblem, demoPasswordProblem, requiresRealDb, WEAK_PASSWORDS };
