'use strict';
const { startApp } = require('./helpers');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../src/config');
const db = require('../src/services/db');
const jobs = require('../src/pipeline/jobs');
const cloudflare = require('../src/services/cloudflare');
const images = require('../src/services/images');
const log = require('../src/logger');
const { createHuggingFaceImages, classifyHfError } = require('../src/services/images/huggingface');

const TOKEN = `hf_${'Q'.repeat(34)}`;
const MODEL = 'black-forest-labs/FLUX.1-schnell';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDqdzTqAAAAABJRU5ErkJggg==';
const bigImage = Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.alloc(4000)]); // >1KB like a real image

let app;
let adminCookie;
before(async () => {
  app = await startApp();
  const r = await fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-admin&name=Reviewer' });
  adminCookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { await jobs.idle(); await app.close(); });
afterEach(() => {
  config.images.provider = 'cloudflare';
  config.images.fallbackEnabled = true;
  images._pause.until = 0;
  images._pause.reason = '';
});

// Stub of the Hub + router as the official client calls them (verified: mapping lookup, then router).
function stubHub(t, routerResponse) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/api/models/')) {
      return new Response(JSON.stringify({ id: MODEL, inferenceProviderMapping: [{ provider: 'nscale', providerId: MODEL, status: 'live', task: 'text-to-image' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return routerResponse(url, init);
  });
  return calls;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ------------------------------------------------------------------ real adapter (official client, stubbed network)
test('Hugging Face adapter: success returns an image buffer, records model and serving provider, sends prompt + bill-to', async (t) => {
  const calls = stubHub(t, () => json(200, { data: [{ b64_json: bigImage.toString('base64') }] }));
  const hf = createHuggingFaceImages({ token: TOKEN, imageModel: MODEL, billTo: 'vaibhav-org' });
  const img = await hf.generateImage('warm bakery background, no text');
  assert.ok(img.buffer.length > 1000);
  assert.equal(img.provider, 'huggingface');
  assert.equal(img.model, MODEL);
  assert.equal(img.servedBy, 'nscale');
  const routed = calls.find((c) => c.url.includes('router.huggingface.co'));
  assert.ok(routed, 'request is routed through Hugging Face (credits apply)');
  assert.match(String(routed.init.body), /warm bakery background/);
  const headers = new Headers(routed.init.headers);
  assert.equal(headers.get('x-hf-bill-to'), 'vaibhav-org');
  assert.match(headers.get('authorization'), /^Bearer hf_/);
});

test('Hugging Face adapter: 402 / 410 / 401 / 403 / 429 are classified in plain words, token never in the message', async (t) => {
  for (const [status, body, kind] of [
    [402, { error: 'You have exceeded your monthly included credits for Inference Providers.' }, 'credits'],
    [410, { error: 'Model is no longer available' }, 'model'],
    [404, { error: 'Not Found' }, 'model'],
    [401, { error: 'Invalid credentials in Authorization header' }, 'auth'],
    [403, { error: 'This authentication method does not have sufficient permissions' }, 'auth'],
    [429, { error: 'Rate limit reached' }, 'quota'],
  ]) {
    t.mock.restoreAll();
    stubHub(t, () => json(status, body));
    const hf = createHuggingFaceImages({ token: TOKEN, imageModel: MODEL });
    await assert.rejects(hf.generateImage('x'), (err) => {
      assert.equal(err.hfKind, kind, `HTTP ${status}`);
      assert.ok(!err.message.includes(TOKEN), 'token must not appear');
      return true;
    });
  }
});

test('Hugging Face adapter: a timeout is reported as "Hugging Face timed out"', async (t) => {
  stubHub(t, (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })))));
  const hf = createHuggingFaceImages({ token: TOKEN, imageModel: MODEL, timeoutMs: 50 });
  await assert.rejects(hf.generateImage('x'), (err) => err.hfKind === 'timeout' && /timed out/.test(err.reason));
});

test('classifyHfError covers out-of-credits text even without a status code', () => {
  assert.equal(classifyHfError({ message: 'You have exceeded your monthly included credits' }).kind, 'credits');
  assert.equal(classifyHfError({ httpResponse: { status: 503, body: '' }, message: '' }).kind, 'server');
});

// ------------------------------------------------------------------ provider router + fallback
const hfError = (hfKind, status, reason) => Object.assign(new Error(reason), { hfKind, status, reason });

test('IMAGE_PROVIDER=huggingface: success is recorded as Hugging Face', async () => {
  config.images.provider = 'huggingface';
  const bg = await images.generateBackground('a prompt', { index: 0 });
  assert.equal(bg.provider, 'huggingface');
  assert.equal(bg.model, MODEL);
  assert.equal(bg.fallbackReason, null);
});

test('402 out of credits -> Cloudflare fallback, then Hugging Face is paused until tomorrow (no more HF calls)', async (t) => {
  config.images.provider = 'huggingface';
  const hfCall = t.mock.method(images._hf, 'generateImage', async () => { throw hfError('credits', 402, 'HF out of credits'); });
  const cf = t.mock.method(cloudflare, 'generateImage');
  const bg = await images.generateBackground('a prompt', { index: 0 });
  assert.equal(bg.provider, 'cloudflare');
  assert.equal(bg.fallbackReason, 'HF out of credits');
  assert.equal(cf.mock.callCount(), 1);
  assert.equal(images.hfStatus().state, 'paused');
  assert.ok(images._pause.until > Date.now() && images._pause.until <= images.startOfNextDay() + 1);

  const again = await images.generateBackground('a prompt', { index: 0 });
  assert.equal(again.provider, 'cloudflare');
  assert.match(again.fallbackReason, /HF out of credits - HF paused until/);
  assert.equal(hfCall.mock.callCount(), 1, 'paused: Hugging Face was not called again');
});

test('410 model gone and timeouts also fall back to Cloudflare with a plain reason', async (t) => {
  config.images.provider = 'huggingface';
  t.mock.method(images._hf, 'generateImage', async () => { throw hfError('model', 410, 'HF model not available'); });
  let bg = await images.generateBackground('p', { index: 0 });
  assert.deepEqual([bg.provider, bg.fallbackReason], ['cloudflare', 'HF model not available']);

  images._pause.until = 0;
  t.mock.restoreAll();
  const hfCall = t.mock.method(images._hf, 'generateImage', async () => { throw hfError('timeout', null, 'Hugging Face timed out'); });
  bg = await images.generateBackground('p', { index: 0 });
  assert.deepEqual([bg.provider, bg.fallbackReason], ['cloudflare', 'Hugging Face timed out']);
  await images.generateBackground('p', { index: 0 });
  assert.equal(hfCall.mock.callCount(), 2, 'a timeout does not pause Hugging Face');
});

test('IMAGE_FALLBACK_ENABLED=false surfaces the Hugging Face error instead of falling back', async (t) => {
  config.images.provider = 'huggingface';
  config.images.fallbackEnabled = false;
  t.mock.method(images._hf, 'generateImage', async () => { throw hfError('quota', 429, 'HF rate limit / quota reached'); });
  await assert.rejects(images.generateBackground('p', { index: 0 }), /quota/);
});

test('startOfNextDay is the next midnight in IST', () => {
  // 2026-10-24 20:00 UTC = 25 Oct 01:30 IST -> next IST midnight = 26 Oct 00:00 IST = 25 Oct 18:30 UTC
  assert.equal(new Date(images.startOfNextDay(new Date('2026-10-24T20:00:00Z'))).toISOString(), '2026-10-25T18:30:00.000Z');
});

// ------------------------------------------------------------------ jobs: compare mode, recorded provider, admin page
async function newJob(phone) {
  const c = await db.createCustomer({ phone, simulated: true, channel: 'dev' });
  return db.createJob({
    customer_id: c.id, status: 'brief_confirmed', deadline: new Date(Date.now() + 3e6).toISOString(),
    brief: { business_name: 'Compare Co', headline: 'Side By Side', key_details: 'x', date_time: 'N/A', contact_or_cta: 'y', size: 'square', style_preference: 'blue', logo: 'none' },
  });
}
const page = async (p) => (await fetch(`${app.base}${p}`, { headers: { cookie: adminCookie } })).text();

test('compare mode: version 1 background from Hugging Face, version 2 from Cloudflare, recorded on the assets and shown in the portal', async () => {
  config.images.provider = 'compare';
  const job = await newJob('919900001001');
  await jobs.startJob(job.id);
  const [v1, v2] = await db.listAssets(job.id);
  assert.equal(v1.background_provider, 'huggingface');
  assert.equal(v1.background_model, MODEL);
  assert.equal(v2.background_provider, 'cloudflare');
  assert.equal(v2.background_model, config.cloudflare.imageModel);
  assert.equal(v1.background_note, null);
  const html = await page(`/admin/jobs/${job.id}`);
  assert.match(html, /Background: <span class="">Hugging Face \/ black-forest-labs\/FLUX\.1-schnell/);
  assert.match(html, /Background: <span class="">Cloudflare \/ @cf\/black-forest-labs\/flux-1-schnell/);
});

test('compare mode with Hugging Face out of credits: both versions still made, v1 labelled "Cloudflare (fallback: HF out of credits)"', async (t) => {
  config.images.provider = 'compare';
  t.mock.method(images._hf, 'generateImage', async () => { throw hfError('credits', 402, 'HF out of credits'); });
  const job = await newJob('919900001002');
  await jobs.startJob(job.id);
  const assets = await db.listAssets(job.id);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].background_provider, 'cloudflare');
  assert.equal(assets[0].background_note, 'HF out of credits');
  assert.match(await page(`/admin/jobs/${job.id}`), /Cloudflare \(fallback: HF out of credits\)/);
});

test('Reject & Regenerate with a provider choice uses it for that round only', async () => {
  const job = await newJob('919900001003');
  await jobs.startJob(job.id);
  assert.match(await page(`/admin/jobs/${job.id}`), /Generate the new backgrounds with/);
  const r = await fetch(`${app.base}/admin/jobs/${job.id}/regenerate`, {
    method: 'POST', redirect: 'manual', headers: { cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'note=brighter&provider=huggingface',
  });
  assert.equal(r.status, 302);
  await jobs.idle();
  const assets = await db.listAssets(job.id);
  assert.deepEqual(assets.slice(2).map((a) => a.background_provider), ['huggingface', 'huggingface']);
  const j = await db.getJob(job.id);
  assert.equal(j.regen_provider, null, 'choice is cleared after the round');
  assert.match((await db.listReviews(job.id)).at(-1).notes, /\[Hugging Face\] brighter/);
});

test('text re-render keeps the original background provider info', async () => {
  config.images.provider = 'compare';
  const job = await newJob('919900001004');
  await jobs.startJob(job.id);
  const before1 = await db.listAssets(job.id);
  await jobs.startRerender(job.id, { fromAssets: [before1[0]], brief: { ...job.brief, headline: 'New Words' } });
  const v3 = (await db.listAssets(job.id)).at(-1);
  assert.equal(v3.background_provider, 'huggingface');
  assert.equal(v3.background_url, before1[0].background_url);
});

// ------------------------------------------------------------------ empty token, health, logs
test('empty HF_TOKEN: app config works, IMAGE_PROVIDER=huggingface quietly uses Cloudflare ("Hugging Face not configured")', () => {
  const script = `
    const images = require('./src/services/images');
    images.generateBackground('p', { index: 0 }).then((bg) => {
      console.log(JSON.stringify({ provider: bg.provider, reason: bg.fallbackReason, hf: images.hfStatus() }));
    }).catch((e) => { console.log('ERR ' + e.message); process.exit(1); });`;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, MOCK_MODE: 'false', DEV_MODE: 'true', IMAGE_PROVIDER: 'huggingface', HF_TOKEN: '', CF_ACCOUNT_ID: '', CF_API_TOKEN: '', LOG_LEVEL: 'error' },
  });
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.provider, 'cloudflare');
  assert.equal(out.reason, 'Hugging Face not configured');
  assert.equal(out.hf.note, 'Hugging Face not configured (optional)');
});

test('/health shows the image provider and Hugging Face status', async () => {
  const h = await (await fetch(`${app.base}/health`)).json();
  assert.equal(h.images.provider, 'cloudflare');
  assert.equal(h.images.fallback, true);
  assert.ok(h.images.huggingface.state);
});

test('logs never contain a Hugging Face token', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (l) => lines.push(l));
  log.error(`request failed with Authorization: Bearer ${TOKEN}`);
  assert.doesNotMatch(lines.join('\n'), /Q{20}/);
  assert.match(lines.join('\n'), /hf_\[redacted\]/);
});
