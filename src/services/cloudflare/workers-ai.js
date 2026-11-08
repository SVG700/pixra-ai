'use strict';
// Real Cloudflare Workers AI (REST): Whisper speech-to-text and FLUX image generation.
const { fetchWithRetry, ensureOk } = require('../../lib/http');

function createWorkersAi({ accountId, apiToken, imageModel, imageSteps = 4, whisperModel }) {
  const runUrl = (model) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const auth = { Authorization: `Bearer ${apiToken}` };

  async function run(model, { body, contentType = 'application/json', label, timeoutMs = 120000 }) {
    const res = await fetchWithRetry(runUrl(model), {
      method: 'POST', headers: { ...auth, 'Content-Type': contentType }, body,
    }, { label, retries: 3, baseDelayMs: 2000, timeoutMs });
    await ensureOk(res, label);
    const data = await res.json();
    if (data.success === false) throw new Error(`${label}: ${JSON.stringify(data.errors || data).slice(0, 300)}`);
    return data.result;
  }

  return {
    kind: 'workers-ai',

    // Returns the transcript text. Newer Whisper models take base64 JSON; the original takes raw bytes.
    async transcribe(buffer) {
      const jsonInput = /large-v3|turbo/i.test(whisperModel);
      const result = await run(whisperModel, jsonInput
        ? { body: JSON.stringify({ audio: buffer.toString('base64'), language: 'en' }), label: 'whisper' }
        : { body: buffer, contentType: 'application/octet-stream', label: 'whisper' });
      return String(result?.text || '').trim();
    },

    // FLUX returns a ~1024x1024 JPEG as base64. Backgrounds only - prompts forbid text.
    async generateImage(prompt, { steps = imageSteps } = {}) {
      const result = await run(imageModel, {
        body: JSON.stringify({ prompt: String(prompt).slice(0, 2048), steps }),
        label: 'flux',
      });
      if (!result?.image) throw new Error('flux: response had no image');
      return { buffer: Buffer.from(result.image, 'base64'), mimeType: 'image/jpeg' };
    },
  };
}

module.exports = { createWorkersAi };
