'use strict';
const { startApp } = require('./helpers');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/services/db');
const whatsapp = require('../src/services/whatsapp');
const jobs = require('../src/pipeline/jobs');
const inbound = require('../src/pipeline/inbound');
const { MOCK_TRANSCRIPT } = require('../src/services/cloudflare/mock');

const DEMO_PW = 'demo-Lantern-77-orbit';
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-voice.ogg'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDqdzTqAAAAABJRU5ErkJggg==', 'base64');

let app;
let adminCookie;
before(async () => {
  app = await startApp();
  config.demo.password = DEMO_PW;
  config.whatsapp.enabled = false;
  config.demo.messagesPer10Min = 1000;
  const r = await fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-admin&name=Reviewer' });
  adminCookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { await jobs.idle(); await app.close(); });
afterEach(() => {
  config.whatsapp.enabled = false;
  config.demo.messagesPer10Min = 1000; // the flow tests send many messages from one IP
});

const form = (o) => new URLSearchParams(o).toString();
async function demoClient(phone, name = 'Asha') {
  const r = await fetch(`${app.base}/demo/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ name, phone, password: DEMO_PW }) });
  assert.equal(r.status, 302, await r.text());
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const send = async (text, file) => {
    const fd = new FormData();
    if (text) fd.append('text', text);
    if (file) fd.append('file', new Blob([file.data], { type: file.type }), file.name);
    const res = await fetch(`${app.base}/demo/send`, { method: 'POST', headers: { cookie }, body: fd });
    await inbound.idle();
    await jobs.idle();
    return res;
  };
  const messages = async () => (await (await fetch(`${app.base}/demo/messages`, { headers: { cookie } })).json()).messages;
  const lastReply = async () => (await messages()).filter((m) => m.direction === 'out').at(-1);
  const customer = () => db.getCustomerByPhone(`web:${phone}`);
  return { cookie, send, messages, lastReply, customer };
}
const adminPost = (p, body) => fetch(`${app.base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
const flash = (res) => decodeURIComponent((res.headers.get('location') || '').split(/[?&](ok|err)=/)[2]?.split('&')[0] || '');

async function runToReview(c) {
  for (const t of ['hi', 'Asha Boutique', 'Festive sale', 'Festive Collection', 'Flat 30% off sarees', '1-5 Nov', 'Call 98111 22233', 'portrait', 'maroon and gold', 'skip', 'YES']) {
    const r = await c.send(t);
    assert.equal(r.status, 200);
  }
  const cust = await c.customer();
  const job = await db.getLatestJobForCustomer(cust.id);
  assert.equal(job.status, 'pending_review', job.error || '');
  return { cust, job };
}

test('full web demo flow: chat -> brief -> YES -> posters -> admin approves -> poster appears in /demo chat (no WhatsApp call)', async (t) => {
  const sendImage = t.mock.method(whatsapp, 'sendImage', async () => { throw new Error('must not be called'); });
  const sendText = t.mock.method(whatsapp, 'sendText', async () => { throw new Error('must not be called'); });
  const c = await demoClient('919811122233');
  const { cust, job } = await runToReview(c);
  assert.equal(cust.channel, 'web');
  assert.equal(cust.name, 'Asha');
  assert.match((await c.lastReply()).content, /final check/);

  const [a1] = await db.listAssets(job.id);
  const r = await adminPost(`/admin/jobs/${job.id}/approve`, { asset_id: a1.id });
  assert.match(flash(r), /sent to the customer via the web demo chat/);
  const listHtml = await (await fetch(`${app.base}/admin?tab=all`, { headers: { cookie: adminCookie } })).text();
  assert.match(listHtml, /\+919811122233 · web demo/);
  const delivered = await c.lastReply();
  assert.equal(delivered.type, 'image');
  assert.equal(delivered.media_url, a1.image_url);
  assert.equal((await db.getJob(job.id)).status, 'delivered');
  assert.equal(sendImage.mock.callCount(), 0);
  assert.equal(sendText.mock.callCount(), 0);

  // revision from the web chat
  await c.send('change headline to Festive Mega Sale');
  assert.equal((await db.getJob(job.id)).brief.headline, 'Festive Mega Sale');
  assert.match((await c.lastReply()).content, /updated poster is ready/);
});

test('voice note upload (OGG/Opus) is transcribed in the web chat', async () => {
  const c = await demoClient('919811122244', 'Ravi');
  const r = await c.send(null, { data: OGG, type: 'audio/ogg', name: 'voice.ogg' });
  assert.equal(r.status, 200);
  const inMsg = (await c.messages()).find((m) => m.direction === 'in');
  assert.equal(inMsg.type, 'audio');
  assert.equal(inMsg.content, MOCK_TRANSCRIPT);
});

test('browser-recorded webm voice note is accepted', async () => {
  const c = await demoClient('919811122245', 'Ravi');
  const r = await c.send(null, { data: OGG, type: 'video/webm', name: 'voice-note.webm' });
  assert.equal(r.status, 200);
  assert.equal((await c.messages()).find((m) => m.direction === 'in').type, 'audio');
});

test('image upload with caption "logo" saves the logo', async () => {
  const c = await demoClient('919811122255', 'Meera');
  await c.send('hi');
  await c.send('this is my logo', { data: PNG, type: 'image/png', name: 'logo.png' });
  const cust = await c.customer();
  assert.ok(cust.logo_url, 'logo saved on the customer');
  const img = (await c.messages()).find((m) => m.type === 'image');
  assert.equal(img.media_url, cust.logo_url);
});

test('unsupported uploads and empty messages are rejected', async () => {
  const c = await demoClient('919811122256');
  let r = await c.send(null, { data: Buffer.from('%PDF-1.4'), type: 'application/pdf', name: 'x.pdf' });
  assert.equal(r.status, 400);
  r = await c.send('   ');
  assert.equal(r.status, 400);
});

test('each demo customer only sees their own chat', async () => {
  const a = await demoClient('919811122266', 'A');
  const b = await demoClient('919811122277', 'B');
  await a.send('message from A only');
  assert.ok((await a.messages()).some((m) => m.content === 'message from A only'));
  assert.ok(!(await b.messages()).some((m) => m.content === 'message from A only'));
});

test('a returning demo customer (same phone) continues their chat and business memory', async () => {
  const first = await demoClient('919811122233', 'Asha');
  const before1 = (await first.messages()).length;
  const again = await demoClient('919811122233', 'Asha');
  assert.equal((await again.messages()).length, before1);
  await again.send('NEW');
  assert.match((await again.lastReply()).content, /new poster for \*Asha Boutique\*/);
});

test('/demo/send is rate limited per IP', async () => {
  config.demo.messagesPer10Min = 2;
  const c = await demoClient('919811122288');
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await c.send(`msg ${i}`)).status);
  assert.deepEqual(codes.slice(-2), [429, 429]);
});

test('switching WHATSAPP_ENABLED=true needs no code change: WhatsApp customers go via WhatsApp, web customers stay in the web chat', async (t) => {
  config.whatsapp.enabled = true;
  const sendImage = t.mock.method(whatsapp, 'sendImage', async () => ({ id: 'wamid.SENT' }));
  t.mock.method(whatsapp, 'sendText', async () => ({ id: 'wamid.TXT' }));

  // a WhatsApp customer with a job ready for review
  const waCustomer = await db.createCustomer({ phone: '919811199999', channel: 'whatsapp' });
  const job = await db.createJob({ customer_id: waCustomer.id, status: 'brief_confirmed', brief: { business_name: 'WA Co', headline: 'Hello', key_details: 'x', date_time: 'N/A', contact_or_cta: 'y', size: 'square', style_preference: 'blue', logo: 'none' }, deadline: new Date(Date.now() + 3e6).toISOString() });
  await jobs.startJob(job.id);
  const [a1] = await db.listAssets(job.id);
  await adminPost(`/admin/jobs/${job.id}/approve`, { asset_id: a1.id });
  assert.equal(sendImage.mock.callCount(), 1);
  assert.equal(sendImage.mock.calls[0].arguments[0], '919811199999');

  // web customer approved while WhatsApp is enabled: still delivered in the web chat only
  config.whatsapp.enabled = false;
  const c = await demoClient('919811122299');
  const { job: webJob } = await runToReview(c);
  config.whatsapp.enabled = true;
  const [w1] = await db.listAssets(webJob.id);
  await adminPost(`/admin/jobs/${webJob.id}/approve`, { asset_id: w1.id });
  assert.equal(sendImage.mock.callCount(), 1, 'no extra WhatsApp call for the web customer');
  assert.equal((await c.lastReply()).media_url, w1.image_url);
});

test('in web demo mode a WhatsApp-channel customer cannot be messaged: clear error, job not lost', async () => {
  const waCustomer = await db.createCustomer({ phone: '919811188888', channel: 'whatsapp' });
  const job = await db.createJob({ customer_id: waCustomer.id, status: 'brief_confirmed', brief: { business_name: 'WA2', headline: 'Hi', key_details: 'x', date_time: 'N/A', contact_or_cta: 'y', size: 'square', style_preference: 'red', logo: 'none' }, deadline: new Date(Date.now() + 3e6).toISOString() });
  await jobs.startJob(job.id);
  const [a1] = await db.listAssets(job.id);
  const r = await adminPost(`/admin/jobs/${job.id}/approve`, { asset_id: a1.id });
  assert.match(flash(r), /WhatsApp not configured/);
  assert.equal((await db.getJob(job.id)).status, 'pending_review');
});

test('admin "Send test poster" in web demo mode delivers into that number\'s /demo chat', async () => {
  const owner = await demoClient('919811122311', 'Owner');
  const { job } = await runToReview(owner);
  const [a1] = await db.listAssets(job.id);
  await adminPost(`/admin/jobs/${job.id}/approve`, { asset_id: a1.id });

  let r = await adminPost('/admin/demo/send', { asset_id: a1.id, phone: '919811122322' });
  assert.match(flash(r), /sign in at \/demo/);
  const viewer = await demoClient('919811122322', 'Viewer');
  r = await adminPost('/admin/demo/send', { asset_id: a1.id, phone: '919811122322' });
  assert.match(flash(r), /sent/);
  assert.equal((await viewer.lastReply()).media_url, a1.image_url);
});
