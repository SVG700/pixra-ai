'use strict';
// Template "Centered card": the background shows around a dark rounded card in the middle that
// holds logo, business name, headline, details, date and a contact pill - all centred.
const { fitText, drawFitted } = require('../services/poster/fit-text');
const { FAMILIES: F } = require('../services/poster/fonts');
const S = require('../services/poster/style');

// Measures all blocks with every size/budget multiplied by k (k < 1 when content is too tall).
function measureBlocks(ctx, { W, H, brief, logo, accent, innerW, maxContentH, cx }, k) {
  const accentInk = S.inkFor(accent);
  const truncated = [];
  const fit = (field, text, opts) => {
    const f = fitText(ctx, text, { ...opts, maxSize: Math.max(opts.minSize, Math.round(opts.maxSize * k)) });
    if (f.truncated) truncated.push(field);
    return f;
  };
  const blocks = [];

  if (logo) {
    const maxH = Math.round(H * 0.1 * k);
    const maxW = innerW * 0.5;
    const pad = Math.round(maxH * 0.12);
    const scale = Math.min((maxW - 2 * pad) / logo.width, (maxH - 2 * pad) / logo.height);
    blocks.push({ h: logo.height * scale + 2 * pad, draw: (y) => S.drawLogoBadge(ctx, logo, { x: cx, y, maxW, maxH, align: 'center' }) });
  }

  const biz = fit('business_name', String(brief.business_name || '').toUpperCase(), {
    family: F.bodyBold, maxSize: 32, minSize: 18, maxWidth: innerW, maxHeight: H * 0.08, maxLines: 2,
  });
  if (biz.lines.length) blocks.push({ h: biz.height, draw: (y) => drawFitted(ctx, biz, { x: cx, y, align: 'center', color: accent, shadow: false }) });

  const headline = fit('headline', brief.headline, {
    family: F.display, maxSize: 124, minSize: 40, maxWidth: innerW, maxHeight: maxContentH * 0.4 * k, maxLines: 4, lineHeight: 1.05,
  });
  blocks.push({ h: headline.height, draw: (y) => drawFitted(ctx, headline, { x: cx, y, align: 'center' }) });

  blocks.push({
    h: 8,
    draw: (y) => {
      ctx.fillStyle = accent;
      S.roundRect(ctx, cx - 50, y, 100, 8, 4);
      ctx.fill();
    },
  });

  const details = fit('key_details', brief.key_details, {
    family: F.bodySemi, maxSize: 40, minSize: 20, maxWidth: innerW, maxHeight: maxContentH * 0.22 * k, maxLines: 4, lineHeight: 1.28,
  });
  if (details.lines.length) blocks.push({ h: details.height, draw: (y) => drawFitted(ctx, details, { x: cx, y, align: 'center', color: 'rgba(255,255,255,0.93)', shadow: false }) });

  if (!S.isNA(brief.date_time)) {
    const date = fit('date_time', brief.date_time, {
      family: F.displayBold, maxSize: 40, minSize: 20, maxWidth: innerW, maxHeight: maxContentH * 0.1, maxLines: 2,
    });
    blocks.push({ h: date.height, draw: (y) => drawFitted(ctx, date, { x: cx, y, align: 'center', color: accent, shadow: false }) });
  }

  const contact = fit('contact_or_cta', brief.contact_or_cta, {
    family: F.bodyBold, maxSize: 36, minSize: 18, maxWidth: innerW - 56, maxHeight: maxContentH * 0.1, maxLines: 2, lineHeight: 1.2,
  });
  if (contact.lines.length) {
    const vpad = Math.round(18 * Math.max(k, 0.7));
    const ph = contact.height + 2 * vpad;
    blocks.push({
      h: ph,
      draw: (y) => {
        const pw = Math.min(innerW, contact.width + 64);
        ctx.fillStyle = accent;
        S.roundRect(ctx, cx - pw / 2, y, pw, ph, Math.min(ph / 2, 32));
        ctx.fill();
        drawFitted(ctx, contact, { x: cx, y: y + vpad, align: 'center', color: accentInk, shadow: false });
      },
    });
  }
  return { blocks, truncated };
}

function render(ctx, { W, H, brief, logo, accent }) {
  const bright = S.regionBrightness(ctx, 0, 0, W, H);

  const margin = Math.round(W * 0.074);
  const cardW = W - 2 * margin;
  const ip = Math.round(W * 0.052);
  const geo = { W, H, brief, logo, accent, innerW: cardW - 2 * ip, maxContentH: H - 2 * margin - 2 * ip, cx: W / 2 };

  // Shrink everything together until the content fits inside the card.
  let k = 1;
  let gap;
  let m;
  let total;
  for (;;) {
    gap = Math.round(H * 0.022 * k);
    m = measureBlocks(ctx, geo, k);
    total = m.blocks.reduce((s, b) => s + b.h, 0) + gap * (m.blocks.length - 1);
    if (total <= geo.maxContentH || k <= 0.55) break;
    k -= 0.05;
  }

  ctx.fillStyle = `rgba(8,8,12,${(0.1 + bright * 0.3).toFixed(3)})`; // light veil over the whole image
  ctx.fillRect(0, 0, W, H);

  const cardH = Math.min(H - 2 * margin, total + 2 * ip);
  const cardY = (H - cardH) / 2;
  const cardAlpha = Math.min(0.86, 0.62 + bright * 0.28);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 40;
  ctx.fillStyle = `rgba(12,12,18,${cardAlpha.toFixed(3)})`;
  S.roundRect(ctx, margin, cardY, cardW, cardH, 36);
  ctx.fill();
  ctx.restore();
  ctx.save();
  S.roundRect(ctx, margin, cardY, cardW, cardH, 36);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(margin, cardY, cardW, 10);
  ctx.restore();

  let y = cardY + ip + Math.max(0, (cardH - 2 * ip - total) / 2);
  for (const b of m.blocks) {
    b.draw(y);
    y += b.h + gap;
  }
  // Anything still taller than the card after max shrink counts as overflow.
  if (total > geo.maxContentH && !m.truncated.includes('layout')) m.truncated.push('layout');
  return { truncated: m.truncated };
}

module.exports = { id: 'centered_card', name: 'Centered card', render };
