'use strict';
// Audio conversion with a bundled ffmpeg (ffmpeg-static, downloaded at `npm install`; works on
// Render's Linux build). FFMPEG_PATH can point to a system ffmpeg instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../config');

function ffmpegPath() {
  if (config.ffmpegPath) return fs.existsSync(config.ffmpegPath) ? config.ffmpegPath : null;
  try {
    const p = require('ffmpeg-static');
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Converts any audio (e.g. WhatsApp OGG/Opus voice notes) to 16 kHz mono 16-bit WAV, which every
 * Whisper variant accepts. Uses temp files so the WAV header has correct sizes.
 */
async function convertToWav(input, { timeoutMs = 30000 } = {}) {
  const bin = ffmpegPath();
  if (!bin) throw new Error('ffmpeg binary not available (reinstall ffmpeg-static or set FFMPEG_PATH)');
  const id = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(os.tmpdir(), `pixra-${id}.in`);
  const outFile = path.join(os.tmpdir(), `pixra-${id}.wav`);
  fs.writeFileSync(inFile, input);
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outFile], { windowsHide: true });
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
      });
    });
    const wav = fs.readFileSync(outFile);
    if (wav.length <= 44) throw new Error('ffmpeg produced empty audio');
    return wav;
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

module.exports = { convertToWav, ffmpegPath };
