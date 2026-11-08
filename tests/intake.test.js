'use strict';
const { startApp } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/services/db');
const { MOCK_TRANSCRIPT } = require('../src/services/cloudflare/mock');
const jobs = require('../src/pipeline/jobs');

let app;
before(async () => { app = await startApp(); });
after(async () => { await jobs.idle(); await app.close(); });

const PNG_2x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDqdzTqAAAAABJRU5ErkJggg==';

async function say(phone, body) {
  const r = await fetch(`${app.base}/dev/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(typeof body === 'string' ? { phone, text: body } : { phone, ...body }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const data = await (await fetch(`${app.base}/dev/messages?phone=${phone}`)).json();
  return { reply: data.messages.filter((m) => m.direction === 'out').at(-1)?.content || '', data };
}

test('full intake: questions one at a time, logo, summary, YES creates a job', async () => {
  const phone = '919900000101';
  let r = await say(phone, 'hi');
  assert.match(r.reply, /Welcome to \*PIXRA AI\*/);
  assert.match(r.reply, /business/i);

  r = await say(phone, 'Chai Point Cafe');
  assert.match(r.reply, /poster for/i);
  r = await say(phone, 'Weekend coffee offer');
  assert.match(r.reply, /headline/i);
  r = await say(phone, 'Buy 1 Get 1 Free');
  assert.match(r.reply, /details/i);
  r = await say(phone, 'All coffees, Sat & Sun only');
  assert.match(r.reply, /date or time/i);
  r = await say(phone, '25-26 Oct, 8am to 8pm');
  assert.match(r.reply, /contact/i);
  r = await say(phone, 'Call 98765 43210');
  assert.match(r.reply, /square/i);
  r = await say(phone, 'portrait please');
  assert.match(r.reply, /style/i);
  r = await say(phone, 'warm brown and cream, cosy');
  assert.match(r.reply, /logo/i);

  r = await say(phone, { image_base64: PNG_2x2, mime: 'image/png', text: '' });
  assert.match(r.reply, /poster brief/i);
  assert.match(r.reply, /Buy 1 Get 1 Free/);
  assert.match(r.reply, /portrait/);
  assert.equal(r.data.conversation.state, 'confirming');

  // change request while confirming -> updated summary
  r = await say(phone, 'change headline to Coffee BOGO Weekend');
  assert.match(r.reply, /Coffee BOGO Weekend/);

  r = await say(phone, 'YES');
  assert.match(r.reply, /Confirmed/);
  assert.match(r.reply, /IST/);
  assert.equal(r.data.conversation.state, 'in_production');

  const customer = await db.getCustomerByPhone(phone);
  const job = await db.getLatestJobForCustomer(customer.id);
  assert.ok(['brief_confirmed', 'generating', 'qa_done', 'pending_review'].includes(job.status), job.status);
  assert.equal(job.brief.headline, 'Coffee BOGO Weekend');
  assert.equal(job.brief.size, 'portrait');
  assert.ok(job.brief.logo_url, 'logo url saved in brief');
  const hours = (new Date(job.deadline) - new Date(job.created_at)) / 3600000;
  assert.ok(Math.abs(hours - 3) < 0.01, `deadline is 3h after creation (got ${hours})`);
  assert.equal(customer.business_name, 'Chai Point Cafe');
  assert.ok(customer.logo_url);

  // while in production, customer gets a status update
  await jobs.idle();
  r = await say(phone, 'any update?');
  assert.match(r.reply, /final review/);
  assert.match(r.reply, /reply \*NEW\*/);
});

test('returning customer is not asked for business name or logo again', async () => {
  const phone = '919900000101';
  let r = await say(phone, 'NEW');
  assert.match(r.reply, /new poster for \*Chai Point Cafe\*/);
  r = await say(phone, 'Diwali special menu');
  assert.match(r.reply, /headline/i);
  const answers = ['suggest one', 'Sweets and snacks combos', 'no', 'Order on WhatsApp', 'square', 'you decide'];
  for (const a of answers) r = await say(phone, a);
  assert.match(r.reply, /poster brief/i, 'went straight to the summary without asking for logo/business');
  assert.match(r.reply, /Logo:\* yes/);
});

test('an image without a logo caption is held until the customer says LOGO', async () => {
  const phone = '919900000202';
  await say(phone, 'Hello');
  let r = await say(phone, { image_base64: PNG_2x2, mime: 'image/png', text: '' });
  assert.match(r.reply, /Reply LOGO/);
  r = await say(phone, 'LOGO');
  const customer = await db.getCustomerByPhone(phone);
  assert.ok(customer.logo_url, 'logo saved after confirmation');
});

test('voice notes are transcribed and used as the message', async () => {
  const phone = '919900000303';
  const r = await say(phone, { audio_base64: Buffer.from('fake-ogg').toString('base64'), mime: 'audio/ogg' });
  const inbound = r.data.messages.find((m) => m.direction === 'in');
  assert.equal(inbound.type, 'audio');
  assert.equal(inbound.content, MOCK_TRANSCRIPT);
  assert.equal(r.data.conversation.collected_fields.poster_purpose, MOCK_TRANSCRIPT);
});
