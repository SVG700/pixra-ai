'use strict';
// Colours + readability helpers: accent colour from the style text, background luminance,
// automatic scrim strength, and small drawing primitives shared by templates.

const ACCENTS = [
  [/\b(gold|golden|diwali|festive|yellow|sunny)\b/i, '#F6C744'],
  [/\b(red|maroon|crimson|christmas)\b/i, '#EF4444'],
  [/\b(pink|rose|valentine)\b/i, '#FF6FA5'],
  [/\b(orange|saffron|holi)\b/i, '#FF8A1F'],
  [/\b(green|eco|nature|fresh|organic|mint)\b/i, '#3CCB7F'],
  [/\b(teal|turquoise|aqua|ocean|sea)\b/i, '#22C7B8'],
  [/\b(blue|navy|corporate|tech|professional)\b/i, '#4C8DFF'],
  [/\b(purple|violet|lavender|royal)\b/i, '#A274FF'],
  [/\b(brown|coffee|cafe|chocolate|cream|beige|cosy|cozy|earthy)\b/i, '#E0A96D'],
  [/\b(black|white|minimal|monochrome|elegant)\b/i, '#FFFFFF'],
];
const DEFAULT_ACCENT = '#FFC83D';

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
}

// WCAG relative luminance 0..1
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function pickAccent(brief = {}) {
  const brand = Array.isArray(brief.brand_colors) ? brief.brand_colors.find((c) => /^#?[0-9a-f]{3,6}$/i.test(c)) : null;
  if (brand) return brand.startsWith('#') ? brand : `#${brand}`;
  // Style words win over purpose words; within a text, the earliest-mentioned colour wins.
  for (const text of [brief.style_preference, brief.poster_purpose]) {
    let best = null;
    for (const [re, color] of ACCENTS) {
      const m = re.exec(String(text || ''));
      if (m && (!best || m.index < best.index)) best = { index: m.index, color };
    }
    if (best) return best.color;
  }
  return DEFAULT_ACCENT;
}

const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const DARK_INK = '#14110F';

// Dark or white text on top of a colour - whichever has the higher WCAG contrast.
function inkFor(hex) {
  const l = luminance(hexToRgb(hex));
  return contrast(l, luminance(hexToRgb(DARK_INK))) >= contrast(l, 1) ? DARK_INK : '#FFFFFF';
}

// Average perceived brightness 0..1 of a canvas region (sampled).
function regionBrightness(ctx, x, y, w, h) {
  const X = Math.max(0, Math.floor(x));
  const Y = Math.max(0, Math.floor(y));
  const W = Math.max(1, Math.floor(w));
  const H = Math.max(1, Math.floor(h));
  const { data } = ctx.getImageData(X, Y, W, H);
  let sum = 0;
  let n = 0;
  const stride = 4 * 7; // every 7th pixel
  for (let i = 0; i < data.length; i += stride) {
    sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    n++;
  }
  return n ? sum / n : 0.5;
}

// Brighter background -> stronger dark scrim, so white text always has contrast.
const scrimAlpha = (brightness, min = 0.45, max = 0.88) => Math.min(max, Math.max(min, 0.3 + brightness * 0.75));

function verticalScrim(ctx, x, y, w, h, stops) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  for (const [pos, alpha] of stops) g.addColorStop(pos, `rgba(8,8,12,${alpha.toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Logo on a white rounded badge (keeps dark logos visible on dark scrims). Returns badge size.
function drawLogoBadge(ctx, img, { x, y, maxW, maxH, align = 'left' }) {
  const pad = Math.round(maxH * 0.12);
  const scale = Math.min((maxW - 2 * pad) / img.width, (maxH - 2 * pad) / img.height);
  const lw = Math.max(1, img.width * scale);
  const lh = Math.max(1, img.height * scale);
  const bw = lw + 2 * pad;
  const bh = lh + 2 * pad;
  const bx = align === 'center' ? x - bw / 2 : x;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, bx, y, bw, bh, Math.min(24, bh / 4));
  ctx.fill();
  ctx.restore();
  ctx.drawImage(img, bx + pad, y + pad, lw, lh);
  return { width: bw, height: bh };
}

// Draws an image to fill w x h (like CSS object-fit: cover), centred.
function drawCover(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

const isNA = (v) => !v || /^(n\/?a|none|no|not applicable|-)$/i.test(String(v).trim());

module.exports = {
  pickAccent, inkFor, hexToRgb, luminance, regionBrightness, scrimAlpha, verticalScrim,
  roundRect, drawLogoBadge, drawCover, isNA,
};
