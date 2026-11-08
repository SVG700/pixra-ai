'use strict';
// fetch() with timeout + retry/backoff on network errors, HTTP 429 and 5xx.
const log = require('../logger');
const { events: jobEvents, currentJobId } = require('./job-context');
const telemetry = require('./telemetry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options = {}, opts = {}) {
  const { label = 'http', retries = 3, baseDelayMs = 1000, timeoutMs = 60000, logger = log } = opts;
  for (let attempt = 0; ; attempt++) {
    let res;
    let err;
    const started = Date.now();
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      err = e;
    }
    const retryable = err || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      telemetry.externalCall(url, { status: res?.status || 0, ok: !!res?.ok, ms: Date.now() - started, label });
      if (attempt > 0 && res?.ok) jobEvents.emit('recovered', { jobId: currentJobId(), label });
      if (err) throw new Error(`${label}: request failed: ${err.message}`);
      return res;
    }
    const retryAfter = res ? Number(res.headers.get('retry-after')) : 0;
    const delay = retryAfter > 0
      ? Math.min(retryAfter * 1000, 30000)
      : baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
    logger.warn(`${label}: ${err ? err.message : `HTTP ${res.status}`} - retry ${attempt + 1}/${retries} in ${delay}ms`);
    // Lets the job runner / portal show "waiting for a free-tier rate limit" instead of looking stuck.
    jobEvents.emit('wait', { jobId: currentJobId(), label, status: res?.status || 0, attempt: attempt + 1, retries, delayMs: delay });
    if (res) await res.body?.cancel().catch(() => {});
    await sleep(delay);
  }
}

// Throws a readable error for a non-2xx response.
async function ensureOk(res, label) {
  if (res.ok) return res;
  let body = '';
  try {
    body = await res.text();
  } catch { /* ignore */ }
  const err = new Error(`${label}: HTTP ${res.status} ${body.slice(0, 500)}`);
  err.status = res.status;
  throw err;
}

module.exports = { fetchWithRetry, ensureOk, sleep };
