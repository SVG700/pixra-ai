'use strict';
// Runtime self-test of the native pieces (canvas + fonts, ffmpeg). Runs once at startup so
// /health shows whether they work on the deploy machine (Render free has no shell access).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

const FONT_FILES = ['Montserrat_800ExtraBold.ttf', 'Montserrat_700Bold.ttf', 'Inter_400Regular.ttf', 'Inter_600SemiBold.ttf', 'Inter_700Bold.ttf'];

let last = { status: 'pending' };

async function testCanvas() {
  const t0 = Date.now();
  const missing = FONT_FILES.filter((f) => !fs.existsSync(path.join(config.root, 'fonts', f)));
  if (missing.length) return { ok: false, error: `missing fonts: ${missing.join(', ')}` };
  const { composePoster, mockBackground } = require('../services/poster');
  const bg = await mockBackground('blue test', { size: 256 });
  const out = await composePoster({
    background: bg.buffer, template: 'centered_card', size: 'square',
    brief: { business_name: 'Self Test', headline: 'Canvas OK ₹', key_details: 'fonts + layout', contact_or_cta: 'health', date_time: 'N/A' },
  });
  if (out.buffer[0] !== 0xff || out.buffer[1] !== 0xd8) return { ok: false, error: 'canvas did not produce a JPEG' };
  return { ok: true, ms: Date.now() - t0, platform: `${process.platform}-${process.arch}` };
}

function testFfmpeg() {
  const { ffmpegPath } = require('./audio');
  const bin = ffmpegPath();
  if (!bin) return Promise.resolve({ ok: false, error: 'ffmpeg binary not found (ffmpeg-static install script did not run?)' });
  return new Promise((resolve) => {
    const p = spawn(bin, ['-hide_banner', '-version'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve(code === 0
      ? { ok: true, version: (out.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown' }
      : { ok: false, error: `ffmpeg exited with ${code}` }));
  });
}

async function runSelfTest() {
  const result = { status: 'running' };
  last = result;
  const safe = async (fn) => { try { return await fn(); } catch (e) { return { ok: false, error: e.message }; } };
  const [canvas, ffmpeg] = await Promise.all([safe(testCanvas), safe(testFfmpeg)]);
  last = { status: canvas.ok && ffmpeg.ok ? 'ok' : 'failed', canvas, ffmpeg, at: new Date().toISOString() };
  return last;
}

module.exports = { runSelfTest, getSelfTest: () => last, FONT_FILES };
