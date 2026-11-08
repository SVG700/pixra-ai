'use strict';
// Voice note -> text. Tries Whisper on the original file (WhatsApp sends OGG/Opus); if that fails
// or returns nothing, converts to WAV with ffmpeg and retries once. Throws if both fail.
const cloudflare = require('../services/cloudflare');
const { convertToWav } = require('../lib/audio');

async function transcribeVoiceNote(buffer, mimeType, plog) {
  let firstErr;
  try {
    const text = String((await cloudflare.transcribe(buffer, mimeType)) || '').trim();
    if (text) return { text, converted: false };
    firstErr = new Error('Whisper returned an empty transcript');
  } catch (err) {
    firstErr = err;
  }
  plog.warn(`whisper failed on original ${mimeType || 'audio'} (${firstErr.message.slice(0, 120)}); converting to WAV and retrying`);

  let wav;
  try {
    wav = await convertToWav(buffer);
  } catch (convErr) {
    plog.error('audio conversion failed', { err: convErr });
    throw new Error(`transcription failed: ${firstErr.message}; conversion failed: ${convErr.message}`);
  }
  const text = String((await cloudflare.transcribe(wav, 'audio/wav')) || '').trim();
  if (!text) throw new Error('Whisper returned an empty transcript after WAV conversion');
  return { text, converted: true };
}

module.exports = { transcribeVoiceNote };
