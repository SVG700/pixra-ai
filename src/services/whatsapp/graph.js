'use strict';
// Real WhatsApp: Meta WhatsApp Cloud API (Graph API).
const { fetchWithRetry, ensureOk } = require('../../lib/http');

// Friendlier explanations for the Graph API errors you will actually hit on the free test number.
const KNOWN_ERRORS = {
  131047: 'More than 24 hours since the customer last messaged; WhatsApp only allows template messages now. Ask the customer to send any message first, then retry.',
  131030: 'This phone number is not in the test number\'s allowed recipient list. Add it in Meta: WhatsApp -> API Setup -> "To" -> Manage phone number list.',
  190: 'WHATSAPP_TOKEN is invalid or expired. Generate a new token (MANUAL_STEPS step 12 or 17).',
  131026: 'Message undeliverable: the number may not be on WhatsApp.',
  131053: 'WhatsApp could not download the image. Check that the image URL is public https (Supabase bucket must be public).',
};

function explain(err) {
  const code = Number((String(err.message).match(/"code"\s*:\s*(\d+)/) || [])[1]);
  if (KNOWN_ERRORS[code]) {
    const e = new Error(`${KNOWN_ERRORS[code]} (WhatsApp error ${code})`);
    e.status = err.status;
    return e;
  }
  return err;
}

const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

function createGraphWhatsApp({ token, phoneNumberId, graphApiVersion }) {
  const base = `https://graph.facebook.com/${graphApiVersion}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function send(payload, label) {
    const res = await fetchWithRetry(`${base}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    }, { label });
    try {
      await ensureOk(res, label);
    } catch (err) {
      throw explain(err);
    }
    const data = await res.json();
    return { id: data.messages?.[0]?.id || null };
  }

  return {
    kind: 'graph',

    sendText: (to, text) => send({
      to, type: 'text', text: { body: String(text).slice(0, MAX_TEXT), preview_url: false },
    }, 'whatsapp sendText'),

    // link must be a public https URL WhatsApp can fetch
    sendImage: (to, link, caption = '') => send({
      to, type: 'image', image: { link, caption: String(caption).slice(0, MAX_CAPTION) },
    }, 'whatsapp sendImage'),

    // Two steps: media id -> temporary URL -> bytes (both need the bearer token)
    async downloadMedia(mediaId) {
      const metaRes = await ensureOk(await fetchWithRetry(`${base}/${mediaId}`, { headers: auth }, { label: 'whatsapp media info' }), 'whatsapp media info');
      const meta = await metaRes.json();
      const fileRes = await ensureOk(await fetchWithRetry(meta.url, { headers: auth }, { label: 'whatsapp media download' }), 'whatsapp media download');
      return { buffer: Buffer.from(await fileRes.arrayBuffer()), mimeType: meta.mime_type || fileRes.headers.get('content-type') };
    },
  };
}

module.exports = { createGraphWhatsApp };
