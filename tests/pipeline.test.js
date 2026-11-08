'use strict';
const { startApp } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/services/db');
const cloudflare = require('../src/services/cloudflare');
const jobs = require('../src/pipeline/jobs');

let app;
before(async () => { app = await startApp(); });
after(async () => { await jobs.idle(); await app.close(); });

const BRIEF = {
  business_name: 'Chai Point Cafe', poster_purpose: 'Weekend offer', headline: 'Buy 1 Get 1 Free',
  key_details: 'On all coffees', date_time: 'N/A', contact_or_cta: 'Order on WhatsApp', size: 'portrait',
  style_preference: 'warm brown', logo: 'none', logo_url: null,
};

async function newJob(phone, status = 'brief_confirmed') {
  const customer = await db.createCustomer({ phone, simulated: true });
  const deadline = new Date(Date.now() + 3 * 3600e3).toISOString();
  return db.createJob({ customer_id: customer.id, status, brief: BRIEF, deadline });
}

test('confirmed brief -> 2 posters (one per template) -> QA -> pending_review + customer notified', async () => {
  const phone = '919900000401';
  const answers = ['hi', 'Chai Point Cafe', 'Weekend offer', 'Buy 1 Get 1 Free', 'On all coffees', 'no', 'Order on WhatsApp', 'portrait', 'warm brown', 'skip', 'YES'];
  for (const text of answers) {
    await fetch(`${app.base}/dev/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, text }) });
  }
  await jobs.idle();

  const customer = await db.getCustomerByPhone(phone);
  const job = await db.getLatestJobForCustomer(customer.id);
  assert.equal(job.status, 'pending_review', job.error || '');
  assert.equal(job.attempts, 1);
  const assets = await db.listAssets(job.id);
  assert.equal(assets.length, 2);
  assert.deepEqual(assets.map((a) => a.version), [1, 2]);
  assert.deepEqual(assets.map((a) => a.template).sort(), ['bold_top', 'centered_card']);
  for (const a of assets) {
    assert.equal(a.size, 'portrait');
    assert.ok(a.background_url && a.image_url);
    assert.equal(typeof a.qa_report.score, 'number');
    assert.equal(a.qa_report.all_required_text_present, true);
    const img = await fetch(`${app.base}${a.image_url}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
  }
  const msgs = await db.listMessages(customer.id);
  assert.match(msgs.at(-1).content, /final check/);
});

test('generation failure marks the job failed with the error', async (t) => {
  t.mock.method(cloudflare, 'generateImage', async () => { throw new Error('Cloudflare quota exceeded'); });
  const job = await newJob('919900000402');
  await jobs.startJob(job.id);
  const after1 = await db.getJob(job.id);
  assert.equal(after1.status, 'failed');
  assert.match(after1.error, /quota exceeded/);
  assert.equal((await db.listAssets(job.id)).length, 0);
});

test('one failed option still produces a reviewable job', async (t) => {
  let n = 0;
  const real = cloudflare.generateImage;
  t.mock.method(cloudflare, 'generateImage', async (...args) => {
    n++;
    if (n === 1) throw new Error('HTTP 500');
    return real(...args);
  });
  const job = await newJob('919900000403');
  await jobs.startJob(job.id);
  assert.equal((await db.getJob(job.id)).status, 'pending_review');
  assert.equal((await db.listAssets(job.id)).length, 1);
});

test('jobs stuck in brief_confirmed/generating/revision_requested are resumed on startup', async () => {
  const a = await newJob('919900000404', 'brief_confirmed');
  const b = await newJob('919900000405', 'generating');
  const c = await newJob('919900000406', 'pending_review');
  const n = await jobs.resumeStuckJobs();
  assert.equal(n, 2);
  await jobs.idle();
  assert.equal((await db.getJob(a.id)).status, 'pending_review');
  assert.equal((await db.getJob(b.id)).status, 'pending_review');
  assert.equal((await db.getJob(c.id)).status, 'pending_review');
  assert.equal((await db.listAssets(c.id)).length, 0, 'untouched');
});

test('re-render keeps old versions and adds new ones on the same background', async () => {
  const job = await newJob('919900000407');
  await jobs.startJob(job.id);
  const before1 = await db.listAssets(job.id);
  await jobs.startRerender(job.id, { fromAssets: before1, brief: { ...BRIEF, headline: 'Two For One Coffee' } });
  const all = await db.listAssets(job.id);
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((a) => a.version), [1, 2, 3, 4]);
  assert.equal(all[2].background_url, before1[0].background_url);
  assert.notEqual(all[2].image_url, before1[0].image_url);
  assert.equal((await db.getJob(job.id)).brief.headline, 'Two For One Coffee');
});
