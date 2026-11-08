'use strict';
// Hugging Face Inference Providers image generator (routed through Hugging Face, so the account's
// monthly credits / pay-as-you-go apply; X-HF-Bill-To via HF_BILL_TO bills an organization).
// Same contract as the Cloudflare generator: prompt in -> text-free background JPEG/PNG buffer out.
const { InferenceClient } = require('@huggingface/inference');

// Plain-words classification used for logs, the admin page and the fallback decision.
function classifyHfError(err) {
  const status = err?.httpResponse?.status ?? err?.status ?? null;
  const body = typeof err?.httpResponse?.body === 'string' ? err.httpResponse.body : JSON.stringify(err?.httpResponse?.body || '');
  const text = `${err?.message || ''} ${body}`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(text)) {
    return { kind: 'timeout', status, reason: 'Hugging Face timed out' };
  }
  if (status === 402 || /exceeded your monthly included credits|insufficient (credits|balance)|payment required|pre-?paid credits/i.test(text)) {
    return { kind: 'credits', status: status || 402, reason: 'HF out of credits' };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, reason: status === 401 ? 'HF token rejected' : 'HF token lacks the "Inference Providers" permission' };
  }
  if (status === 404 || status === 410 || /not supported by provider|no provider|not available|model .* not found/i.test(text)) {
    return { kind: 'model', status, reason: 'HF model not available' };
  }
  if (status === 429 || /rate limit|quota/i.test(text)) return { kind: 'quota', status: status || 429, reason: 'HF rate limit / quota reached' };
  if (status >= 500) return { kind: 'server', status, reason: `HF provider error (HTTP ${status})` };
  return { kind: 'other', status, reason: 'HF request failed' };
}

function createHuggingFaceImages({ token, imageModel, inferenceProvider = 'auto', billTo = '', imageSteps = 4, timeoutMs = 90000 }) {
  const client = new InferenceClient(token, billTo ? { billTo } : {});
  const scrub = (s) => String(s || '').split(token).join('hf_[redacted]').replace(/hf_[A-Za-z0-9]{20,}/g, 'hf_[redacted]');

  return {
    kind: 'huggingface',
    model: imageModel,

    /** @returns {Promise<{buffer: Buffer, mimeType: string, provider: 'huggingface', model: string, servedBy: string}>} */
    async generateImage(prompt, { width = 1024, height = 1024 } = {}) {
      let servedBy = inferenceProvider;
      // Record which provider the router actually used (router.huggingface.co/<provider>/...).
      const spyFetch = (url, init) => {
        const m = /router\.huggingface\.co\/([^/]+)\//.exec(String(url));
        if (m && m[1] !== 'v1') servedBy = m[1];
        return fetch(url, init);
      };
      try {
        const blob = await client.textToImage(
          {
            provider: inferenceProvider,
            model: imageModel,
            inputs: String(prompt).slice(0, 2000),
            parameters: { width, height, num_inference_steps: imageSteps },
          },
          { outputType: 'blob', signal: AbortSignal.timeout(timeoutMs), retry_on_error: false, fetch: spyFetch },
        );
        const buffer = Buffer.from(await blob.arrayBuffer());
        if (buffer.length < 1000) throw new Error('Hugging Face returned an empty image');
        return { buffer, mimeType: blob.type || 'image/jpeg', provider: 'huggingface', model: imageModel, servedBy };
      } catch (err) {
        const c = classifyHfError(err);
        const e = new Error(`huggingface ${imageModel}: ${c.reason}${c.status ? ` (HTTP ${c.status})` : ''} - ${scrub(err.message).slice(0, 300)}`);
        Object.assign(e, { hfKind: c.kind, status: c.status, reason: c.reason, servedBy });
        throw e;
      }
    },
  };
}

module.exports = { createHuggingFaceImages, classifyHfError };
