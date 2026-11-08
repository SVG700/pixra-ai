'use strict';
// Renders sample posters into samples/ (no API keys needed): npm run samples
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { composePoster, mockBackground } = require('../src/services/poster');

const OUT = path.join(__dirname, '..', 'samples');

async function sampleLogo() {
  const c = createCanvas(400, 400);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#B91C1C';
  ctx.beginPath();
  ctx.arc(200, 200, 190, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FDE68A';
  ctx.beginPath();
  ctx.arc(200, 200, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#B91C1C';
  ctx.beginPath();
  ctx.moveTo(200, 110); ctx.lineTo(280, 250); ctx.lineTo(120, 250); ctx.closePath();
  ctx.fill();
  return c.encode('png');
}

// A very bright background to prove the automatic scrim keeps text readable.
async function brightBackground() {
  const c = createCanvas(1024, 1024);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 1024, 1024);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(1, '#FFF3C4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  return c.encode('jpeg', 90);
}

const BRIEFS = {
  diwali: {
    business_name: 'Sharma Sweets',
    poster_purpose: 'Diwali sale',
    headline: 'Sweet Diwali Savings',
    key_details: '20% off all sweet boxes. Free delivery on orders above ₹999.',
    date_time: '28 Oct - 3 Nov, 9 AM to 10 PM',
    contact_or_cta: 'Call 98110 00001',
    size: 'square',
    style_preference: 'festive red and gold',
  },
  cafe: {
    business_name: 'Chai Point Cafe',
    poster_purpose: 'Weekend coffee offer',
    headline: 'Buy 1 Get 1 Free',
    key_details: 'On all coffees and iced teas',
    date_time: 'N/A',
    contact_or_cta: 'Order on WhatsApp',
    size: 'portrait',
    style_preference: 'warm brown and cream, cosy',
  },
  stress: {
    business_name: 'The Extraordinarily Long Business Name Private Limited of Bengaluru',
    poster_purpose: 'Hiring',
    headline: 'We Are Hiring Passionate Full-Stack Developers, Designers And Product Managers Right Now',
    key_details: 'Join a fast growing startup. Competitive salary, ESOPs, health insurance for family, flexible remote work, learning budget, annual offsite in Goa and a lot more benefits that we cannot fit here.',
    date_time: 'Apply before 15 November 2026, interviews every Saturday 10 AM - 6 PM',
    contact_or_cta: 'Email careers@extraordinarilylongcompanyname.example.com or call +91 98765 43210',
    size: 'square',
    style_preference: 'professional blue',
  },
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const logo = await sampleLogo();
  const jobs = [];
  for (const [name, brief] of Object.entries(BRIEFS)) {
    for (const size of ['square', 'portrait']) {
      for (const [i, template] of ['bold_top', 'centered_card'].entries()) {
        jobs.push({ file: `${name}-${size}-${template}.jpg`, brief, size, template, seed: i, logo: name === 'cafe' ? null : logo });
      }
    }
  }
  jobs.push({ file: 'bright-bg-square-bold_top.jpg', brief: BRIEFS.diwali, size: 'square', template: 'bold_top', bright: true, logo });
  jobs.push({ file: 'bright-bg-portrait-centered_card.jpg', brief: BRIEFS.cafe, size: 'portrait', template: 'centered_card', bright: true });

  for (const j of jobs) {
    const bg = j.bright ? await brightBackground() : (await mockBackground(j.brief.style_preference, { seed: j.seed })).buffer;
    const out = await composePoster({ background: bg, brief: j.brief, template: j.template, size: j.size, logo: j.logo });
    fs.writeFileSync(path.join(OUT, j.file), out.buffer);
    console.log(`${j.file.padEnd(42)} ${out.width}x${out.height} ${(out.buffer.length / 1024).toFixed(0)} KB${out.truncated.length ? `  truncated: ${out.truncated.join(', ')}` : ''}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
