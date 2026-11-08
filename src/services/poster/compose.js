'use strict';
// Composes a final poster: background image (cover-fit) + template (scrims, text, logo).
// All text is drawn here, never by the image model, so spelling is always exact.
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { registerFonts } = require('./fonts');
const { pickAccent, drawCover } = require('./style');
const { TEMPLATES, SIZES } = require('../../templates');

const JPEG_QUALITY = 90;

/**
 * @param {object} p
 * @param {Buffer} p.background  image bytes (any size; cropped to fit)
 * @param {object} p.brief       brief fields (headline, key_details, ...)
 * @param {string} p.template    'bold_top' | 'centered_card'
 * @param {string} p.size        'square' | 'portrait'
 * @param {Buffer} [p.logo]      logo image bytes (optional)
 * @returns {Promise<{buffer: Buffer, mimeType: string, width: number, height: number, truncated: string[]}>}
 */
async function composePoster({ background, brief, template = 'bold_top', size = 'square', logo = null }) {
  registerFonts();
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`unknown template "${template}"`);
  const { W, H } = SIZES[size] || SIZES.square;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  drawCover(ctx, await loadImage(background), W, H);

  let logoImg = null;
  if (logo) {
    try {
      logoImg = await loadImage(logo);
    } catch {
      logoImg = null; // unreadable logo -> poster without it (QA will flag nothing; reviewer sees it)
    }
  }

  const { truncated } = tpl.render(ctx, { W, H, brief, logo: logoImg, accent: pickAccent(brief) });
  const buffer = await canvas.encode('jpeg', JPEG_QUALITY);
  return { buffer, mimeType: 'image/jpeg', width: W, height: H, truncated };
}

module.exports = { composePoster };
