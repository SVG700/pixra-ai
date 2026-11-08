'use strict';
// Turns a Meta webhook payload into a flat list of normalized inbound messages.
// Status callbacks (sent/delivered/read/failed) are ignored.

function normalizeMessage(m, contacts) {
  const contact = contacts.find((c) => c.wa_id === m.from);
  const base = {
    waMessageId: m.id,
    from: String(m.from || '').replace(/\D/g, ''),
    name: contact?.profile?.name || null,
    timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
    simulated: false,
    type: 'unsupported',
    text: '',
  };
  switch (m.type) {
    case 'text':
      return { ...base, type: 'text', text: m.text?.body || '' };
    case 'audio': // includes voice notes (m.audio.voice === true)
      return { ...base, type: 'audio', mediaId: m.audio?.id, mimeType: m.audio?.mime_type };
    case 'image':
      return { ...base, type: 'image', mediaId: m.image?.id, mimeType: m.image?.mime_type, text: m.image?.caption || '' };
    case 'button':
      return { ...base, type: 'text', text: m.button?.text || '' };
    case 'interactive':
      return {
        ...base,
        type: 'text',
        text: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '',
      };
    default:
      return { ...base, originalType: m.type };
  }
}

function parseWebhook(body) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account') return out;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (!Array.isArray(value.messages)) continue; // statuses-only callback
      const contacts = value.contacts || [];
      for (const m of value.messages) {
        if (m && m.id && m.from) out.push(normalizeMessage(m, contacts));
      }
    }
  }
  return out;
}

module.exports = { parseWebhook };
