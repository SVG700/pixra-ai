'use strict';
// Lists Gemini models available to an API key and suggests a sensible free Flash model.

async function listModels({ apiKey, apiVersion = 'v1beta' }) {
  const out = [];
  let pageToken = '';
  do {
    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
    if (!res.ok) throw Object.assign(new Error(`list models: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`), { status: res.status });
    const data = await res.json();
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) {
        out.push({ name: String(m.name).replace(/^models\//, ''), displayName: m.displayName || '' });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Text+vision Flash models only (no image-generation / TTS / live / embedding variants).
const isTextFlash = (name) => /flash/i.test(name) && !/(image|tts|audio|live|embedding|thinking|native|computer)/i.test(name);

function versionOf(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Picks the best Flash model: newest version, stable before preview/experimental,
 * full Flash before Flash-Lite, plain alias before dated variants. Returns { primary, fallback }.
 */
function suggestFlashModels(names) {
  const flash = names.filter(isTextFlash);
  const score = (n) => [
    versionOf(n),
    /preview|exp/i.test(n) ? 0 : 1,
    /lite/i.test(n) ? 0 : 1,
    /-\d{3}$|-\d{2}-\d{4}$|latest/i.test(n) ? 0 : 1,
  ];
  const cmp = (a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return a.localeCompare(b);
  };
  const sorted = [...flash].sort(cmp);
  const stable = sorted.filter((n) => !/preview|exp/i.test(n));
  const primary = (stable[0] || sorted[0]) || null;
  const fallback = sorted.find((n) => n !== primary && /lite/i.test(n) && !/preview|exp/i.test(n))
    || sorted.find((n) => n !== primary) || null;
  return { primary, fallback, flash: sorted };
}

/**
 * Real tiny generateContent call. Listed != usable: retired models answer 404 "no longer available
 * to new users" and paid-only models answer 429 with a zero quota.
 * Returns { ok, status, ms, message }.
 */
async function probeModel({ apiKey, apiVersion = 'v1beta', model, timeoutMs = 30000 }) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with {"ok": true}' }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, message: res.ok ? '' : String(body.error?.message || '').slice(0, 160) };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - t0, message: err.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000}s` : err.message };
  }
}

module.exports = { listModels, suggestFlashModels, isTextFlash, probeModel };
