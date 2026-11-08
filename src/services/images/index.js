'use strict';
// Background image providers: Cloudflare Workers AI (default) and Hugging Face Inference Providers.
//   IMAGE_PROVIDER=cloudflare   -> every background from Cloudflare
//   IMAGE_PROVIDER=huggingface  -> every background from Hugging Face (Cloudflare as fallback)
//   IMAGE_PROVIDER=compare      -> option 1 from Hugging Face, option 2 from Cloudflare
// Hugging Face failures (out of credits, quota, auth, model gone, timeout) fall back to Cloudflare
// with a plain-words reason. After "out of credits" Hugging Face is paused until the next day.
// Switching the FREE token for a PRO one (or an org via HF_BILL_TO) is an env change only.
const config = require('../../config');
const log = require('../../logger');
const cloudflare = require('../cloudflare');
const { modes } = require('../select');

const PROVIDERS = ['cloudflare', 'huggingface', 'compare'];
const LABEL = { cloudflare: 'Cloudflare', huggingface: 'Hugging Face' };

// ------------------------------------------------------------------ Hugging Face client (optional)
function createHf() {
  if (config.mockMode) {
    const { mockBackground } = require('../poster/mock-background');
    let n = 100;
    return {
      kind: 'mock',
      model: config.huggingface.imageModel,
      async generateImage(prompt) {
        const img = await mockBackground(`${prompt} hf`, { seed: n++ });
        return { ...img, provider: 'huggingface', model: config.huggingface.imageModel, servedBy: 'mock' };
      },
    };
  }
  if (!config.huggingface.token) return null; // optional: Cloudflare is used instead
  return require('./huggingface').createHuggingFaceImages(config.huggingface);
}
const hf = require('../../lib/telemetry').instrument('images', createHf(), { nodeId: 'file:src/services/images/huggingface.js' });
modes.huggingface = hf ? (hf.kind === 'mock' ? 'mock' : 'real') : 'not configured';
if (!PROVIDERS.includes(config.images.provider)) log.error(`IMAGE_PROVIDER "${config.images.provider}" is not one of ${PROVIDERS.join(', ')} - using cloudflare`);
if (!hf && ['huggingface', 'compare'].includes(config.images.provider)) {
  log.warn(`IMAGE_PROVIDER=${config.images.provider} but HF_TOKEN is empty - Hugging Face not configured, using Cloudflare`);
}

// ------------------------------------------------------------------ pause after credits run out
const pause = { until: 0, reason: '' };

// Start of the next day in the display timezone (credits/quotas are checked again then).
function startOfNextDay(now = new Date()) {
  const tz = config.business.timezone;
  const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  const local = new Date(now.getTime() + offsetMin * 60000);
  const nextLocalMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  return nextLocalMidnight - offsetMin * 60000;
}

const PAUSE_FOR = {
  credits: () => startOfNextDay(), // monthly credits gone - don't hammer HF, try again tomorrow
  auth: () => Date.now() + 60 * 60 * 1000, // fix the token (restart picks up new env)
  model: () => Date.now() + 60 * 60 * 1000,
  quota: () => Date.now() + 10 * 60 * 1000,
};

function pauseHf(kind, reason) {
  const until = PAUSE_FOR[kind]?.();
  if (!until) return;
  pause.until = until;
  pause.reason = reason;
  log.warn(`Hugging Face paused until ${new Date(until).toISOString()} (${reason}) - using Cloudflare meanwhile`);
}

function hfStatus() {
  if (!hf) return { state: 'not configured', note: 'Hugging Face not configured (optional)' };
  if (pause.until > Date.now()) return { state: 'paused', until: new Date(pause.until).toISOString(), reason: pause.reason };
  return { state: hf.kind === 'mock' ? 'mock' : 'ready', model: hf.model, provider: config.huggingface.inferenceProvider };
}

// ------------------------------------------------------------------ generation
async function fromCloudflare(prompt, fallbackReason = null) {
  const img = await cloudflare.generateImage(prompt);
  return {
    ...img,
    provider: 'cloudflare',
    model: config.cloudflare.imageModel,
    servedBy: cloudflare.kind === 'mock' ? 'mock' : 'workers-ai',
    fallbackReason,
  };
}

/** Which provider a given option should come from. override: 'huggingface' | 'cloudflare' | null */
function providerFor(index, override) {
  if (override === 'huggingface' || override === 'cloudflare') return override;
  const mode = PROVIDERS.includes(config.images.provider) ? config.images.provider : 'cloudflare';
  if (mode === 'compare') return index === 0 ? 'huggingface' : 'cloudflare';
  return mode;
}

/**
 * Generates one text-free background.
 * @returns {Promise<{buffer, mimeType, provider, model, servedBy, fallbackReason}>}
 */
async function generateBackground(prompt, { index = 0, override = null, logger = log } = {}) {
  const want = providerFor(index, override);
  if (want !== 'huggingface') return fromCloudflare(prompt);

  if (!hf) return fromCloudflare(prompt, 'Hugging Face not configured');
  if (pause.until > Date.now()) {
    return fromCloudflare(prompt, `${pause.reason} - HF paused until ${new Date(pause.until).toLocaleString('en-IN', { timeZone: config.business.timezone })}`);
  }
  try {
    return { ...(await hf.generateImage(prompt)), fallbackReason: null };
  } catch (err) {
    const reason = err.reason || 'HF request failed';
    pauseHf(err.hfKind, reason);
    if (!config.images.fallbackEnabled) throw err;
    logger.warn(`Hugging Face failed (${reason}) - generating this background with Cloudflare instead`, { err });
    return fromCloudflare(prompt, reason);
  }
}

/** "Hugging Face / black-forest-labs/FLUX.1-schnell (via nscale)" or "Cloudflare (fallback: HF out of credits)" */
function describeBackground(a) {
  if (!a?.background_provider) return null;
  const name = LABEL[a.background_provider] || a.background_provider;
  if (a.background_note) return `${name} (fallback: ${a.background_note})`;
  const via = a.background_served_by && !['auto', 'workers-ai', 'mock'].includes(a.background_served_by) ? ` (via ${a.background_served_by})` : '';
  return `${name} / ${a.background_model || '?'}${via}`;
}

module.exports = {
  generateBackground, providerFor, describeBackground, hfStatus, startOfNextDay,
  PROVIDERS, LABEL, _hf: hf, _pause: pause,
};
