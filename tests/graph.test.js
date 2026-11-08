'use strict';
const { startApp } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createGraphWhatsApp } = require('../src/services/whatsapp/graph');
const db = require('../src/services/db');
const gemini = require('../src/services/gemini');

const wa = createGraphWhatsApp({ token: 't', phoneNumberId: '123', graphApiVersion: 'v21.0' });

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('sendText posts the right Graph payload and returns the message id', async (t) => {
  let seen;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT1' }] }), { status: 200 });
  });
  const r = await wa.sendText('919800000001', 'Hello');
  assert.equal(r.id, 'wamid.OUT1');
  assert.equal(seen.url, 'https://graph.facebook.com/v21.0/123/messages');
  assert.equal(seen.auth, 'Bearer t');
  assert.deepEqual(seen.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919800000001', type: 'text', text: { body: 'Hello', preview_url: false } });
});

test('24-hour-window error is explained in plain words', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400 }));
  await assert.rejects(wa.sendImage('919800000001', 'https://x/y.jpg', 'hi'), /More than 24 hours.*131047/);
});

test('not-allowed recipient error points to the Meta setting', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Recipient phone number not in allowed list', code: 131030 } }), { status: 400 }));
  await assert.rejects(wa.sendText('919800000001', 'x'), /Manage phone number list/);
});

test('if the conversation crashes, the customer gets an apology instead of silence', async (t) => {
  t.mock.method(gemini, 'intake', async () => { throw new Error('boom'); });
  // the rule-based fallback would rescue intake, so break the fallback path too
  t.mock.method(db, 'saveConversation', async () => { throw new Error('db write failed'); });
  await fetch(`${app.base}/dev/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '919900000601', text: 'hi' }) });
  const c = await db.getCustomerByPhone('919900000601');
  const out = (await db.listMessages(c.id)).filter((m) => m.direction === 'out');
  assert.equal(out.length, 1);
  assert.match(out[0].content, /something went wrong/);
});
