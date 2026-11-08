'use strict';
const { tmp, startApp, textWebhook, signedWebhook } = require('./helpers'); // sets env first
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/services/db');
const inbound = require('../src/pipeline/inbound');
const { parseWebhook } = require('../src/services/whatsapp/parse');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const post = (body) => signedWebhook(app.base, body);

test('GET /webhook verifies with the right token and rejects a wrong one', async () => {
  const ok = await fetch(`${app.base}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  const bad = await fetch(`${app.base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
  assert.equal(bad.status, 403);
});

test('POST /webhook processes a message once even if Meta delivers it twice', async () => {
  const payload = textWebhook({ id: 'wamid.DEDUP1', from: '919800000001', body: 'Hi there' });
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload)).status, 200); // retry of the same message
  await inbound.idle();

  const customer = await db.getCustomerByPhone('919800000001');
  assert.ok(customer, 'customer created');
  assert.equal(customer.name, 'Test User');
  const msgs = await db.listMessages(customer.id);
  assert.equal(msgs.filter((m) => m.direction === 'in').length, 1, 'one inbound message stored');
  assert.equal(msgs.filter((m) => m.direction === 'out').length, 1, 'one reply sent');
});

test('dedup also holds at the DB level (e.g. after a restart clears memory)', async () => {
  const customer = await db.getCustomerByPhone('919800000001');
  const row = { customer_id: customer.id, wa_message_id: 'wamid.DBDUP', direction: 'in', type: 'text', content: 'x' };
  assert.ok(await db.insertMessage(row));
  assert.equal(await db.insertMessage(row), null);
});

test('status callbacks are ignored', async () => {
  const statusOnly = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered', recipient_id: '919800000002' }] } }] }],
  };
  assert.deepEqual(parseWebhook(statusOnly), []);
  assert.equal((await post(statusOnly)).status, 200);
  await inbound.idle();
  assert.equal(await db.getCustomerByPhone('919800000002'), null);
});

test('parseWebhook normalizes text, voice note, image and unknown types', () => {
  const body = textWebhook({ id: 'a', from: '911' });
  const v = body.entry[0].changes[0].value;
  v.messages.push(
    { from: '911', id: 'b', timestamp: '1', type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
    { from: '911', id: 'c', timestamp: '1', type: 'image', image: { id: 'MEDIA2', mime_type: 'image/jpeg', caption: 'my logo' } },
    { from: '911', id: 'd', timestamp: '1', type: 'sticker', sticker: { id: 'S' } },
  );
  const out = parseWebhook(body);
  assert.deepEqual(out.map((m) => m.type), ['text', 'audio', 'image', 'unsupported']);
  assert.equal(out[1].mediaId, 'MEDIA1');
  assert.equal(out[2].text, 'my logo');
});

test('dev simulator runs the same pipeline and stores replies', async () => {
  const r = await fetch(`${app.base}/dev/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+91 99999 00077', text: 'RESTART' }),
  });
  assert.equal(r.status, 200);
  const data = await (await fetch(`${app.base}/dev/messages?phone=919999900077`)).json();
  assert.equal(data.customer.simulated, true);
  assert.equal(data.messages.length, 2);
  assert.equal(data.conversation.state, 'collecting');
});

test('dev simulator refuses to impersonate a real WhatsApp customer', async () => {
  const r = await fetch(`${app.base}/dev/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '919800000001', text: 'hi' }),
  });
  assert.equal(r.status, 400);
});

test('health endpoint reports mock services', async () => {
  const h = await (await fetch(`${app.base}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.services.db, 'mock');
  assert.ok(tmp);
});
