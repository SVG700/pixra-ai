'use strict';
// Word-wrap + auto-shrink: finds the largest font size at which text fits a box.
const { font } = require('./fonts');

// Remove characters our fonts can't draw (emoji etc.) and normalise whitespace.
function sanitize(text) {
  return String(text ?? '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\*([^*]+)\*/g, '$1') // WhatsApp *bold* markers
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// Splits a word that is wider than maxWidth into chunks that fit.
function breakWord(ctx, word, maxWidth) {
  const parts = [];
  let cur = '';
  for (const ch of word) {
    if (cur && ctx.measureText(cur + ch).width > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

// Wraps text to lines no wider than maxWidth using the ctx's current font. Honours "\n".
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of sanitize(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ').filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
        continue;
      }
      if (line) lines.push(line);
      if (ctx.measureText(word).width > maxWidth) {
        const chunks = breakWord(ctx, word, maxWidth);
        lines.push(...chunks.slice(0, -1));
        line = chunks[chunks.length - 1];
      } else line = word;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function ellipsize(ctx, line, maxWidth) {
  let s = line;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/**
 * Largest size in [minSize, maxSize] where text fits maxWidth x maxHeight within maxLines.
 * If it doesn't fit even at minSize, the text is truncated with an ellipsis (truncated=true).
 * Returns { size, lines, lineHeight (px), height, width, truncated, family }.
 */
function fitText(ctx, text, { family, maxSize, minSize, maxWidth, maxHeight = Infinity, maxLines = Infinity, lineHeight = 1.15, step = 2 }) {
  const clean = sanitize(text);
  const measure = (size, lines) => {
    const lh = size * lineHeight;
    const width = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    return { size, lines, lineHeight: lh, height: lines.length ? (lines.length - 1) * lh + size : 0, width, family };
  };
  if (!clean) return { ...measure(minSize, []), truncated: false };

  for (let size = maxSize; size >= minSize; size -= step) {
    ctx.font = font(family, size);
    const lines = wrapLines(ctx, clean, maxWidth);
    const m = measure(size, lines);
    if (lines.length <= maxLines && m.height <= maxHeight) return { ...m, truncated: false };
  }
  ctx.font = font(family, minSize);
  let lines = wrapLines(ctx, clean, maxWidth);
  const lh = minSize * lineHeight;
  const allowed = Math.max(1, Math.min(maxLines, Math.floor((maxHeight - minSize) / lh) + 1));
  lines = [...lines.slice(0, allowed - 1), ellipsize(ctx, lines[allowed - 1], maxWidth)];
  return { ...measure(minSize, lines), truncated: true };
}

/** Draws a fitText() result. align: left|center|right; x is the left edge, centre or right edge. */
function drawFitted(ctx, fit, { x, y, align = 'left', color = '#fff', shadow = true }) {
  ctx.save();
  ctx.font = font(fit.family, fit.size);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = Math.max(4, fit.size * 0.12);
    ctx.shadowOffsetY = Math.max(1, fit.size * 0.03);
  }
  fit.lines.forEach((line, i) => ctx.fillText(line, x, y + i * fit.lineHeight));
  ctx.restore();
  return y + fit.height;
}

module.exports = { sanitize, wrapLines, fitText, drawFitted };
