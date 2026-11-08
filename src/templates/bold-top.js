'use strict';
// Template "Bold headline top": logo + business name header, huge left-aligned headline,
// details / date / contact pill anchored to the bottom. Dark gradient scrims top and bottom.
const { fitText, drawFitted } = require('../services/poster/fit-text');
const { FAMILIES: F } = require('../services/poster/fonts');
const S = require('../services/poster/style');

function render(ctx, { W, H, brief, logo, accent }) {
  const pad = Math.round(W * 0.067);
  const innerW = W - 2 * pad;
  const accentInk = S.inkFor(accent);
  const truncated = [];
  const fit = (field, text, opts) => {
    const f = fitText(ctx, text, opts);
    if (f.truncated) truncated.push(field);
    return f;
  };

  // --- scrims: strength adapts to how bright the background is under the text
  const topA = S.scrimAlpha(S.regionBrightness(ctx, 0, 0, W, H * 0.5));
  const botA = S.scrimAlpha(S.regionBrightness(ctx, 0, H * 0.55, W, H * 0.45));
  S.verticalScrim(ctx, 0, 0, W, H * 0.7, [[0, topA], [0.55, topA * 0.75], [1, 0]]);
  S.verticalScrim(ctx, 0, H * 0.38, W, H * 0.62, [[0, 0], [0.4, botA * 0.8], [1, Math.min(0.93, botA + 0.05)]]);

  // --- header: logo badge + business name
  let y = pad;
  const headerH = Math.round(H * 0.095);
  let hx = pad;
  if (logo) {
    const badge = S.drawLogoBadge(ctx, logo, { x: pad, y, maxW: W * 0.3, maxH: headerH });
    hx += badge.width + 24;
  }
  const biz = fit('business_name', String(brief.business_name || '').toUpperCase(), {
    family: F.bodyBold, maxSize: 38, minSize: 22, maxWidth: W - pad - hx, maxHeight: headerH, maxLines: 2, lineHeight: 1.15,
  });
  drawFitted(ctx, biz, { x: hx, y: y + (headerH - biz.height) / 2, color: 'rgba(255,255,255,0.95)' });
  y += headerH + Math.round(H * 0.045);

  // --- bottom block, built bottom-up so it can never collide with the headline
  let by = H - pad;
  const contact = fit('contact_or_cta', brief.contact_or_cta, {
    family: F.bodyBold, maxSize: 40, minSize: 22, maxWidth: innerW - 64, maxHeight: H * 0.12, maxLines: 2, lineHeight: 1.2,
  });
  if (contact.lines.length) {
    const ph = contact.height + 44;
    const pw = Math.min(innerW, contact.width + 64);
    by -= ph;
    ctx.fillStyle = accent;
    S.roundRect(ctx, pad, by, pw, ph, Math.min(ph / 2, 36));
    ctx.fill();
    drawFitted(ctx, contact, { x: pad + 32, y: by + 22, color: accentInk, shadow: false });
    by -= 30;
  }

  if (!S.isNA(brief.date_time)) {
    const date = fit('date_time', brief.date_time, {
      family: F.displayBold, maxSize: 44, minSize: 24, maxWidth: innerW - 28, maxHeight: H * 0.1, maxLines: 2, lineHeight: 1.15,
    });
    by -= date.height;
    ctx.fillStyle = accent;
    ctx.fillRect(pad, by - 4, 8, date.height + 8);
    drawFitted(ctx, date, { x: pad + 28, y: by, color: '#FFFFFF' });
    by -= 28;
  }

  const detailsMaxH = Math.max(60, Math.min(H * 0.2, by - y - H * 0.2));
  const details = fit('key_details', brief.key_details, {
    family: F.bodySemi, maxSize: 44, minSize: 24, maxWidth: innerW, maxHeight: detailsMaxH, maxLines: 4, lineHeight: 1.25,
  });
  by -= details.height;
  drawFitted(ctx, details, { x: pad, y: by, color: 'rgba(255,255,255,0.95)' });
  by -= 40;

  // --- headline fills the space between header and bottom block
  const headline = fit('headline', brief.headline, {
    family: F.display, maxSize: 150, minSize: 48, maxWidth: innerW, maxHeight: Math.min(by - y - 40, H * 0.42), maxLines: 4, lineHeight: 1.04,
  });
  drawFitted(ctx, headline, { x: pad, y, color: '#FFFFFF' });
  ctx.fillStyle = accent;
  S.roundRect(ctx, pad, y + headline.height + 24, 140, 12, 6);
  ctx.fill();

  return { truncated };
}

module.exports = { id: 'bold_top', name: 'Bold headline top', render };
