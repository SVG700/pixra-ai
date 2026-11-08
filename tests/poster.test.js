'use strict';
require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { registerFonts, FAMILIES, font } = require('../src/services/poster/fonts');
const { fitText, wrapLines, sanitize } = require('../src/services/poster/fit-text');
const { composePoster, mockBackground, TEMPLATE_IDS } = require('../src/services/poster');
const { pickAccent, inkFor, regionBrightness } = require('../src/services/poster/style');

registerFonts();
const ctx = createCanvas(10, 10).getContext('2d');

const BRIEF = {
  business_name: 'Sharma Sweets', headline: 'Sweet Diwali Savings', key_details: '20% off all sweet boxes',
  date_time: '28 Oct - 3 Nov', contact_or_cta: 'Call 98110 00001', size: 'square', style_preference: 'red and gold',
};

test('wrapLines keeps every line within the width, and breaks over-long words', () => {
  ctx.font = font(FAMILIES.body, 40);
  const lines = wrapLines(ctx, 'A short line and then Supercalifragilisticexpialidociousword', 300);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(ctx.measureText(l).width <= 300 + 0.5, `"${l}" too wide`);
  assert.equal(lines.join('').replace(/\s/g, ''), 'AshortlineandthenSupercalifragilisticexpialidociousword');
});

test('fitText uses the max size for short text and shrinks long text to fit the box', () => {
  const short = fitText(ctx, 'Sale', { family: FAMILIES.display, maxSize: 120, minSize: 40, maxWidth: 900, maxHeight: 400 });
  assert.equal(short.size, 120);
  assert.equal(short.truncated, false);

  const long = fitText(ctx, 'We are hiring passionate developers designers and product managers right now', {
    family: FAMILIES.display, maxSize: 120, minSize: 40, maxWidth: 900, maxHeight: 400, maxLines: 4,
  });
  assert.ok(long.size < 120 && long.size >= 40, `size ${long.size}`);
  assert.ok(long.height <= 400);
  assert.ok(long.lines.length <= 4);
  assert.ok(long.width <= 900);
  assert.equal(long.truncated, false);
});

test('fitText truncates with an ellipsis only when even the minimum size cannot fit', () => {
  const r = fitText(ctx, 'word '.repeat(200), { family: FAMILIES.body, maxSize: 40, minSize: 30, maxWidth: 300, maxHeight: 100, maxLines: 2 });
  assert.equal(r.truncated, true);
  assert.equal(r.size, 30);
  assert.ok(r.lines.length <= 2);
  assert.match(r.lines.at(-1), /…$/);
});

test('sanitize strips emoji and WhatsApp bold markers', () => {
  assert.equal(sanitize('🎉 *Big* Sale 🔥  today'), 'Big Sale today');
});

test('accent colour follows style words and ink keeps contrast', () => {
  assert.equal(pickAccent({ style_preference: 'warm brown and cream' }), '#E0A96D');
  assert.equal(pickAccent({ style_preference: 'blue and red' }), '#4C8DFF'); // earliest mention wins
  assert.equal(pickAccent({ brand_colors: ['#123456'], style_preference: 'red' }), '#123456');
  assert.equal(inkFor('#FFFFFF'), '#14110F');
  assert.equal(inkFor('#101030'), '#FFFFFF');
});

for (const template of TEMPLATE_IDS) {
  for (const [size, W, H] of [['square', 1080, 1080], ['portrait', 1080, 1350]]) {
    test(`template ${template} renders ${size} ${W}x${H} JPEG with no truncation`, async () => {
      const bg = (await mockBackground('red gold', { seed: 1 })).buffer;
      const out = await composePoster({ background: bg, brief: { ...BRIEF, size }, template, size });
      assert.equal(out.mimeType, 'image/jpeg');
      assert.equal(out.buffer[0], 0xff);
      assert.equal(out.buffer[1], 0xd8);
      const img = await loadImage(out.buffer);
      assert.equal(img.width, W);
      assert.equal(img.height, H);
      assert.deepEqual(out.truncated, []);
    });
  }
}

test('scrim darkens a white background behind the text', async () => {
  const white = createCanvas(1024, 1024);
  const wctx = white.getContext('2d');
  wctx.fillStyle = '#fff';
  wctx.fillRect(0, 0, 1024, 1024);
  const out = await composePoster({ background: await white.encode('png'), brief: BRIEF, template: 'bold_top', size: 'square' });
  const img = await loadImage(out.buffer);
  const c = createCanvas(img.width, img.height);
  const cctx = c.getContext('2d');
  cctx.drawImage(img, 0, 0);
  // Headline band (top area) must be clearly darker than the white source.
  assert.ok(regionBrightness(cctx, 0, 0, 1080, 300) < 0.6);
});

test('logo is accepted and an unreadable logo does not break rendering', async () => {
  const bg = (await mockBackground('blue', { seed: 2 })).buffer;
  const logoCanvas = createCanvas(300, 120);
  const l = logoCanvas.getContext('2d');
  l.fillStyle = '#0a0';
  l.fillRect(0, 0, 300, 120);
  const withLogo = await composePoster({ background: bg, brief: BRIEF, template: 'centered_card', size: 'portrait', logo: await logoCanvas.encode('png') });
  assert.ok(withLogo.buffer.length > 1000);
  const badLogo = await composePoster({ background: bg, brief: BRIEF, template: 'bold_top', size: 'square', logo: Buffer.from('not an image') });
  assert.ok(badLogo.buffer.length > 1000);
});
