'use strict';
// Mock "AI background": a generated gradient with soft light blobs. No text, like the real one.
// Colours follow the style keywords in the prompt; the seed varies the layout per option.
const crypto = require('crypto');
const { createCanvas } = require('@napi-rs/canvas');
const { pickAccent, hexToRgb } = require('./style');

function rng(seedText) {
  let s = crypto.createHash('sha256').update(String(seedText)).digest().readUInt32LE(0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const mix = (rgb, target, t) => rgb.map((c, i) => Math.round(c + (target[i] - c) * t));
const css = ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`;

async function mockBackground(prompt, { seed = 0, size = 1024 } = {}) {
  const rand = rng(`${prompt}|${seed}`);
  const accent = hexToRgb(pickAccent({ style_preference: prompt }));
  const deep = mix(accent, [10, 8, 20], 0.72);
  const mid = mix(accent, [40, 20, 60], 0.45);

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const angle = rand() * Math.PI * 2;
  const g = ctx.createLinearGradient(
    size / 2 + Math.cos(angle) * size, size / 2 + Math.sin(angle) * size,
    size / 2 - Math.cos(angle) * size, size / 2 - Math.sin(angle) * size,
  );
  g.addColorStop(0, css(deep));
  g.addColorStop(0.55, css(mid));
  g.addColorStop(1, css(mix(accent, [255, 255, 255], 0.15)));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 7; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.12 + rand() * 0.35);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tint = mix(accent, [255, 255, 255], rand() * 0.5);
    rg.addColorStop(0, css(tint, 0.35 + rand() * 0.25));
    rg.addColorStop(1, css(tint, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, size, size);
  }
  // subtle diagonal light streaks for texture
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = '#ffffff';
  for (let i = 0; i < 18; i++) {
    ctx.lineWidth = 2 + rand() * 10;
    const off = rand() * size * 2 - size / 2;
    ctx.beginPath();
    ctx.moveTo(off, 0);
    ctx.lineTo(off - size * 0.6, size);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return { buffer: await canvas.encode('jpeg', 90), mimeType: 'image/jpeg' };
}

module.exports = { mockBackground };
