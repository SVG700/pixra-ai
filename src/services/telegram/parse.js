'use strict';
// Turns a Telegram Update into the same normalized inbound message the WhatsApp webhook produces.
// Only private-chat `message` updates are used (no groups, channels, edits or callbacks).
// Customer identity = chat id, stored as phone "tg:<chat id>" with channel "telegram".

const IMAGE_DOC = /^image\/(png|jpe?g|webp)$/i;

function parseUpdate(update) {
  const m = update?.message;
  if (!m || !m.chat || m.chat.type !== 'private' || typeof update.update_id !== 'number') return null;
  const base = {
    waMessageId: `tg-${update.update_id}`, // dedup key (update_id is unique per bot)
    updateId: update.update_id,
    from: `tg:${m.chat.id}`,
    chatId: m.chat.id,
    name: null, // we ask the customer for their name instead of using the profile name
    timestamp: m.date ? new Date(m.date * 1000).toISOString() : new Date().toISOString(),
    simulated: false,
    channel: 'telegram',
    type: 'unsupported',
    text: '',
  };

  if (typeof m.text === 'string') return { ...base, type: 'text', text: m.text };
  if (m.voice) return { ...base, type: 'audio', mediaId: m.voice.file_id, mimeType: m.voice.mime_type || 'audio/ogg' };
  if (m.audio) return { ...base, type: 'audio', mediaId: m.audio.file_id, mimeType: m.audio.mime_type || 'audio/mpeg', text: m.caption || '' };
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = [...m.photo].sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height))[0];
    return { ...base, type: 'image', mediaId: largest.file_id, mimeType: 'image/jpeg', text: m.caption || '' };
  }
  if (m.document && IMAGE_DOC.test(m.document.mime_type || '')) {
    // Logos sent "as file" keep full quality and transparency.
    return { ...base, type: 'image', mediaId: m.document.file_id, mimeType: m.document.mime_type.toLowerCase(), text: m.caption || '' };
  }
  return { ...base, originalType: Object.keys(m).find((k) => ['sticker', 'video', 'video_note', 'document', 'location', 'contact', 'animation', 'poll'].includes(k)) || 'other' };
}

module.exports = { parseUpdate };
