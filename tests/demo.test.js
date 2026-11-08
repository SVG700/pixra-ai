'use strict';
const { startApp } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const config = require('../src/config');
const db = require('../src/services/db');
const jobs = require('../src/pipeline/jobs');
const cloudflare = require('../src/services/cloudflare');
const { fetchWithRetry, ensureOk } = require('../src/lib/http');

let app;
let cookie;
before(async () => {
  app = await startApp();
  const r = await fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-admin&name=Demo' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { await jobs.idle(); await app.close(); });

const post = (p, body) => fetch(`${app.base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const page = async (p) => (await fetch(`${app.base}${p}`, { headers: { cookie } })).text();
const flash = (res) => decodeURIComponent((res.headers.get('location') || '').split(/[?&](ok|err)=/)[2]?.split('&')[0] || '');

const BRIEF = { business_name: 'Demo Cafe', poster_purpose: 'Offer', headline: 'Coffee Week', key_details: 'All lattes 20% off', date_time: 'N/A', contact_or_cta: 'Order on WhatsApp', size: 'square', style_preference: 'brown', logo: 'none' };
async function newJob(phone) {
  const c = await db.createCustomer({ phone, simulated: true });
  return db.createJob({ customer_id: c.id, status: 'brief_confirmed', brief: BRIEF, deadline: new Date(Date.now() + 3 * 3600e3).toISOString() });
}

// ------------------------------------------------------------------ send test poster
test('send test poster: an approved poster goes to the chosen number, the job is untouched', async () => {
  const job = await newJob('919900000801');
  await jobs.startJob(job.id);
  const [a1] = await db.listAssets(job.id);
  await post(`/admin/jobs/${job.id}/approve`, { asset_id: a1.id });
  assert.equal((await db.getJob(job.id)).status, 'delivered');

  const html = await page('/admin/demo');
  assert.match(html, /Send test poster/);
  assert.match(html, /Demo Cafe/);

  const r = await post('/admin/demo/send', { asset_id: a1.id, phone: '+91 98000 00999' });
  assert.match(flash(r), /Test poster v1 sent/);
  const target = await db.getCustomerByPhone('919800000999');
  const sent = (await db.listMessages(target.id)).filter((m) => m.direction === 'out');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'image');
  assert.equal(sent[0].media_url, a1.image_url);
  assert.equal((await db.getJob(job.id)).status, 'delivered');
  const rev = (await db.listReviews(job.id)).at(-1);
  assert.equal(rev.action, 'demo_send');
  assert.equal(rev.notes, 'to 91XXXXXX0999');
});

test('send test poster refuses unapproved posters, bad numbers, and numbers outside DEMO_TEST_NUMBERS', async () => {
  const job = await newJob('919900000802');
  await jobs.startJob(job.id);
  const [a1] = await db.listAssets(job.id); // pending review, not approved
  assert.match(flash(await post('/admin/demo/send', { asset_id: a1.id, phone: '919800000998' })), /Only approved/);

  await post(`/admin/jobs/${job.id}/approve`, { asset_id: a1.id });
  assert.match(flash(await post('/admin/demo/send', { asset_id: a1.id, phone: '12' })), /country code/);

  config.demo.testNumbers = ['919800000111'];
  try {
    assert.match(flash(await post('/admin/demo/send', { asset_id: a1.id, phone: '919800000998' })), /not in DEMO_TEST_NUMBERS/);
    assert.match(flash(await post('/admin/demo/send', { asset_id: a1.id, phone: '919800000111' })), /sent/);
  } finally {
    config.demo.testNumbers = [];
  }
});

// ------------------------------------------------------------------ rate-limit visibility
test('portal shows "waiting for free-tier rate limit" while a call is retrying after HTTP 429', async (t) => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(429, { 'retry-after': '2' }); return res.end('rate limited'); }
    res.writeHead(200); res.end('ok');
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const real = cloudflare.generateImage;
  t.mock.method(cloudflare, 'generateImage', async (prompt) => {
    await ensureOk(await fetchWithRetry(`http://127.0.0.1:${srv.address().port}/`, {}, { label: 'flux', retries: 2 }), 'flux');
    return real(prompt);
  });

  const job = await newJob('919900000803');
  const done = jobs.startJob(job.id);
  let a;
  for (let i = 0; i < 50 && !(a = jobs.jobActivity(job.id))?.wait; i++) await new Promise((r) => setTimeout(r, 40));
  assert.equal(a.state, 'running');
  assert.equal(a.wait.status, 429);
  assert.equal(a.wait.service, 'Cloudflare FLUX');

  const html = await page(`/admin/jobs/${job.id}`);
  assert.match(html, /Waiting for Cloudflare FLUX free-tier rate limit \(HTTP 429\)/);
  assert.match(html, /not stuck/);
  assert.match(await page('/admin'), /waiting: rate limit/);

  await done;
  assert.equal((await db.getJob(job.id)).status, 'pending_review');
  assert.equal(jobs.jobActivity(job.id), null);
});

test('queued jobs show their position; the running one shows its step', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const real = cloudflare.generateImage;
  t.mock.method(cloudflare, 'generateImage', async (p) => { await gate; return real(p); });
  const j1 = await newJob('919900000804');
  const j2 = await newJob('919900000805');
  jobs.startJob(j1.id);
  jobs.startJob(j2.id);
  for (let i = 0; i < 50 && !/background/.test(jobs.jobActivity(j1.id)?.step || ''); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(jobs.jobActivity(j1.id).step, /Generating background 1 of 2/);
  assert.deepEqual(jobs.jobActivity(j2.id), { state: 'queued', ahead: 1 });
  assert.match(await page(`/admin/jobs/${j2.id}`), /In queue: 1 job ahead/);
  release();
  await jobs.idle();
});

test('a final 429 failure is explained as a free-tier limit in the portal', async (t) => {
  t.mock.method(cloudflare, 'generateImage', async () => { throw new Error('flux: HTTP 429 {"errors":[{"message":"daily free allocation exceeded"}]}'); });
  const job = await newJob('919900000806');
  await jobs.startJob(job.id);
  const j = await db.getJob(job.id);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /^Free-tier rate limit \/ daily quota reached/);
  assert.match(await page(`/admin/jobs/${job.id}`), /Free-tier rate limit/);
});
