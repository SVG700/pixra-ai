'use strict';
const { startApp, textWebhook, signedWebhook } = require('./helpers');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const config = require('../src/config');
const db = require('../src/services/db');
const inbound = require('../src/pipeline/inbound');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const saved = { ...config.whatsapp, mockMode: config.mockMode, devMode: config.devMode, isProduction: config.isProduction };
afterEach(() => {
  Object.assign(config.whatsapp, { appSecret: saved.appSecret, skipSignature: saved.skipSignature });
  Object.assign(config, { mockMode: saved.mockMode, devMode: saved.devMode, isProduction: saved.isProduction });
});

const processed = async (phone) => {
  await inbound.idle();
  return !!(await db.getCustomerByPhone(phone));
};

test('valid signature -> 200 and the message is processed', async () => {
  const r = await signedWebhook(app.base, textWebhook({ id: 'wamid.SIG1', from: '919811000001' }));
  assert.equal(r.status, 200);
  assert.equal(await processed('919811000001'), true);
});

test('signature is computed over the RAW body (whitespace/key order preserved)', async () => {
  const raw = `{ "object":"whatsapp_business_account" ,\n "entry": ${JSON.stringify(textWebhook({ id: 'wamid.SIG2', from: '919811000002' }).entry)} }`;
  const r = await signedWebhook(app.base, null, { raw });
  assert.equal(r.status, 200);
  assert.equal(await processed('919811000002'), true);
});

test('invalid signature -> 401 and nothing is processed', async () => {
  const r = await signedWebhook(app.base, textWebhook({ id: 'wamid.SIG3', from: '919811000003' }), { secret: 'wrong-secret' });
  assert.equal(r.status, 401);
  assert.equal(await processed('919811000003'), false);
});

test('tampered body with the original signature -> 401', async () => {
  const original = JSON.stringify(textWebhook({ id: 'wamid.SIG4', from: '919811000004', body: 'hi' }));
  const sig = `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(original).digest('hex')}`;
  const r = await signedWebhook(app.base, null, { raw: original.replace('"hi"', '"pay me"'), signature: sig });
  assert.equal(r.status, 401);
  assert.equal(await processed('919811000004'), false);
});

test('missing or malformed signature header -> 401', async () => {
  const p = textWebhook({ id: 'wamid.SIG5', from: '919811000005' });
  assert.equal((await signedWebhook(app.base, p, { signature: null })).status, 401);
  assert.equal((await signedWebhook(app.base, p, { signature: 'sha1=abc' })).status, 401);
  assert.equal(await processed('919811000005'), false);
});

test('no app secret configured and no skip flag -> 401 (fails closed)', async () => {
  config.whatsapp.appSecret = '';
  const r = await signedWebhook(app.base, textWebhook({ id: 'wamid.SIG6', from: '919811000006' }), { signature: null });
  assert.equal(r.status, 401);
});

test('WEBHOOK_SKIP_SIGNATURE=true skips the check in dev/mock mode only', async () => {
  config.whatsapp.skipSignature = true;
  const r = await signedWebhook(app.base, textWebhook({ id: 'wamid.SIG7', from: '919811000007' }), { signature: null });
  assert.equal(r.status, 200);
  assert.equal(await processed('919811000007'), true);

  Object.assign(config, { mockMode: false, devMode: false, isProduction: true });
  const r2 = await signedWebhook(app.base, textWebhook({ id: 'wamid.SIG8', from: '919811000008' }), { signature: null });
  assert.equal(r2.status, 401, 'flag is ignored in production');
});

test('invalid JSON with a valid signature -> 400', async () => {
  const r = await signedWebhook(app.base, null, { raw: '{not json' });
  assert.equal(r.status, 400);
});
