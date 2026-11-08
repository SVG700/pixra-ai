'use strict';
const { startApp } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/services/db');
const jobs = require('../src/pipeline/jobs');
const cloudflare = require('../src/services/cloudflare');

let app;
let cookie;
before(async () => { app = await startApp(); });
after(async () => { await jobs.idle(); await app.close(); });

const form = (obj) => new URLSearchParams(obj).toString();
async function post(path, body, { auth = true } = {}) {
  return fetch(`${app.base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(auth && cookie ? { cookie } : {}) },
    body: form(body || {}),
  });
}
const get = (path) => fetch(`${app.base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const flash = (res) => decodeURIComponent((res.headers.get('location') || '').split(/[?&](ok|err)=/)[2] || '');

async function say(phone, text) {
  await fetch(`${app.base}/dev/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, text }) });
  await jobs.idle();
}
async function lastOut(customerId) {
  return (await db.listMessages(customerId)).filter((m) => m.direction === 'out').at(-1);
}

// Runs a whole intake and returns { customer, job } with the job in pending_review.
async function readyJob(phone, business = 'Test Biz') {
  for (const t of ['hi', business, 'Launch', 'Grand Opening', 'Free samples all day', '1 Nov, 10 AM', 'Call 90000 00000', 'square', 'blue', 'skip', 'YES']) await say(phone, t);
  const customer = await db.getCustomerByPhone(phone);
  const job = await db.getLatestJobForCustomer(customer.id);
  assert.equal(job.status, 'pending_review', job.error || '');
  return { customer, job };
}

test('admin pages require login; wrong password is rejected', async () => {
  const r = await get('/admin');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/admin\/login/);
  const bad = await post('/admin/login', { password: 'nope' }, { auth: false });
  assert.match(bad.headers.get('location'), /err=Wrong/);
  assert.equal(bad.headers.get('set-cookie'), null);
});

test('login sets a signed session cookie; a tampered cookie is refused', async () => {
  const r = await post('/admin/login', { password: 'test-admin', name: 'Priya' }, { auth: false });
  assert.equal(r.headers.get('location'), '/admin');
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  cookie = setCookie.split(';')[0];
  const page = await get('/admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Poster jobs/);

  const [name, value] = cookie.split('=');
  const [body, sig] = decodeURIComponent(value).split('.');
  const forged = Buffer.from(JSON.stringify({ name: 'evil', exp: Date.now() + 1e9 })).toString('base64url');
  const r2 = await fetch(`${app.base}/admin`, { redirect: 'manual', headers: { cookie: `${name}=${forged}.${sig}` } });
  assert.equal(r2.status, 302);
  assert.ok(body);
});

test('a stale cookie with the same name (older Path=/ version) does not break login', async () => {
  const value = cookie.split('=').slice(1).join('=');
  // browsers send the most specific path (/admin) first, then the stale root-path cookie
  const r = await fetch(`${app.base}/admin`, { redirect: 'manual', headers: { cookie: `pixra_admin=${value}; pixra_admin=stale.value` } });
  assert.equal(r.status, 200);
});

test('approve & send delivers the image on WhatsApp and records the review', async () => {
  const { customer, job } = await readyJob('919900000501', 'Bloom Florist');
  const list = await (await get('/admin')).text();
  assert.match(list, /Bloom Florist/);
  const detail = await (await get(`/admin/jobs/${job.id}`)).text();
  assert.match(detail, /Approve &amp; Send v1/);
  assert.match(detail, /Chat history/);

  const assets = await db.listAssets(job.id);
  const r = await post(`/admin/jobs/${job.id}/approve`, { asset_id: assets[1].id });
  assert.match(flash(r), /sent/);
  const after1 = await db.getJob(job.id);
  assert.equal(after1.status, 'delivered');
  assert.equal(after1.delivered_asset_id, assets[1].id);
  const out = await lastOut(customer.id);
  assert.equal(out.type, 'image');
  assert.equal(out.media_url, assets[1].image_url);
  assert.match(out.content, /Want any changes/);
  assert.equal((await db.getConversation(customer.id)).state, 'delivered');
  const reviews = await db.listReviews(job.id);
  assert.equal(reviews.at(-1).action, 'approve');
  assert.equal(reviews.at(-1).reviewer, 'Priya');
});

test('customer text change after delivery -> revision re-rendered on the same background, old versions kept', async () => {
  const phone = '919900000501';
  const customer = await db.getCustomerByPhone(phone);
  const job = await db.getLatestJobForCustomer(customer.id);
  const before1 = await db.listAssets(job.id);

  await say(phone, 'change headline to Grand Opening Sale');
  const j = await db.getJob(job.id);
  assert.equal(j.status, 'pending_review');
  assert.equal(j.revision_count, 1);
  assert.equal(j.brief.headline, 'Grand Opening Sale');
  const all = await db.listAssets(job.id);
  assert.equal(all.length, before1.length + 1, 'one new version from the delivered background');
  assert.equal(all.at(-1).version, before1.length + 1);
  assert.equal(all.at(-1).background_url, before1[1].background_url);
  for (const a of before1) assert.ok(all.find((x) => x.id === a.id && x.image_url === a.image_url), 'old version untouched');
  const msgs = (await db.listMessages(customer.id)).filter((m) => m.direction === 'out').map((m) => m.content);
  assert.ok(msgs.some((m) => /updated poster by/.test(m)));
  assert.match(msgs.at(-1), /updated poster is ready/);
});

test('customer visual change -> new backgrounds generated', async () => {
  const phone = '919900000501';
  const customer = await db.getCustomerByPhone(phone);
  const job = await db.getLatestJobForCustomer(customer.id);
  const assets = await db.listAssets(job.id);
  await post(`/admin/jobs/${job.id}/approve`, { asset_id: assets.at(-1).id });
  const n = assets.length;
  await say(phone, 'make the background darker please');
  const j = await db.getJob(job.id);
  assert.equal(j.status, 'pending_review');
  assert.equal(j.revision_count, 2);
  assert.match(j.revision_request, /darker/);
  const all = await db.listAssets(job.id);
  assert.equal(all.length, n + 2);
  assert.notEqual(all.at(-1).background_url, assets.at(-1).background_url);
});

test('DONE after delivery thanks the customer and closes the conversation', async () => {
  const phone = '919900000501';
  const customer = await db.getCustomerByPhone(phone);
  const job = await db.getLatestJobForCustomer(customer.id);
  await post(`/admin/jobs/${job.id}/approve`, { asset_id: (await db.listAssets(job.id)).at(-1).id });
  await say(phone, 'Perfect, thanks!');
  assert.match((await lastOut(customer.id)).content, /Glad you like it/);
  assert.equal((await db.getConversation(customer.id)).state, 'idle');
});

test('portal: assign, edit text, regenerate with note', async () => {
  const { job } = await readyJob('919900000502', 'Edit Co');
  let r = await post(`/admin/jobs/${job.id}/assign`, { assigned_to: 'Ravi' });
  assert.match(flash(r), /saved/);
  assert.equal((await db.getJob(job.id)).assigned_to, 'Ravi');

  r = await post(`/admin/jobs/${job.id}/edit-text`, { ...job.brief, headline: 'Opening Day!', key_details: 'Free samples' });
  assert.match(flash(r), /headline/);
  await jobs.idle();
  let j = await db.getJob(job.id);
  assert.equal(j.status, 'pending_review');
  assert.equal(j.brief.headline, 'Opening Day!');
  assert.equal((await db.listAssets(job.id)).length, 4);

  r = await post(`/admin/jobs/${job.id}/regenerate`, { note: 'more sky blue' });
  assert.match(flash(r), /Regenerating/);
  await jobs.idle();
  j = await db.getJob(job.id);
  assert.equal(j.status, 'pending_review');
  assert.equal(j.regen_note, null, 'note is consumed after use');
  assert.equal((await db.listAssets(job.id)).length, 6);
  const actions = (await db.listReviews(job.id)).map((x) => x.action);
  assert.deepEqual(actions, ['assign', 'edit_text', 'reject_regenerate']);
});

test('portal: upload replacement and send immediately', async () => {
  const { customer, job } = await readyJob('919900000503', 'Upload Co');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDqdzTqAAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('poster', new Blob([png], { type: 'image/png' }), 'final.png');
  fd.append('send', 'on');
  const r = await fetch(`${app.base}/admin/jobs/${job.id}/upload`, { method: 'POST', redirect: 'manual', headers: { cookie }, body: fd });
  assert.match(flash(r), /Uploaded v3 and sent/);
  const asset = (await db.listAssets(job.id)).at(-1);
  assert.equal(asset.source, 'manual');
  assert.equal((await db.getJob(job.id)).status, 'delivered');
  assert.equal((await lastOut(customer.id)).media_url, asset.image_url);
});

test('portal: failed job shows the error and Retry recovers it', async (t) => {
  const mock = t.mock.method(cloudflare, 'generateImage', async () => { throw new Error('Workers AI daily quota used up'); });
  const phone = '919900000504';
  for (const x of ['hi', 'Fail Co', 'Launch', 'Hello', 'Details', 'no', 'Call 1', 'square', 'red', 'skip', 'YES']) await say(phone, x);
  const customer = await db.getCustomerByPhone(phone);
  const job = await db.getLatestJobForCustomer(customer.id);
  assert.equal(job.status, 'failed');
  const page = await (await get(`/admin/jobs/${job.id}`)).text();
  assert.match(page, /daily quota used up/);
  assert.match(page, /Retry generation/);

  mock.mock.restore();
  const r = await post(`/admin/jobs/${job.id}/retry`, {});
  assert.match(flash(r), /Retrying/);
  await jobs.idle();
  const j = await db.getJob(job.id);
  assert.equal(j.status, 'pending_review');
  assert.equal(j.error, null);
  assert.equal(j.attempts, 2);
});

test('approving an asset from another job is refused', async () => {
  const a = await readyJob('919900000505', 'A Co');
  const b = await readyJob('919900000506', 'B Co');
  const foreign = (await db.listAssets(b.job.id))[0];
  const r = await post(`/admin/jobs/${a.job.id}/approve`, { asset_id: foreign.id });
  assert.match(flash(r), /Choose a poster version/);
  assert.equal((await db.getJob(a.job.id)).status, 'pending_review');
});
