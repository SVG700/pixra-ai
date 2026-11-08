'use strict';
const { startApp } = require('./helpers');

// Enable the Telegram channel (mock Bot API, because MOCK_MODE=true) before any src/ module loads.
const SECRET = 'tg-webhook-secret-Quartz-7781-amber-lake';
Object.assign(process.env, { TELEGRAM_ENABLED: 'true', TELEGRAM_WEBHOOK_SECRET: SECRET });

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/services/db');
const telegram = require('../src/services/telegram');
const jobs = require('../src/pipeline/jobs');
const inbound = require('../src/pipeline/inbound');
const log = require('../src/logger');
const { parseUpdate } = require('../src/services/telegram/parse');
const { createTelegramApi, toTelegramHtml } = require('../src/services/telegram/api');
const { startPolling, stopPolling } = require('../src/services/telegram/poller');
const { checkConfig } = require('../src/lib/startup-checks');
const { MOCK_TRANSCRIPT } = require('../src/services/cloudflare/mock');

const OGG = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-voice.ogg'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDqdzTqAAAAABJRU5ErkJggg==', 'base64');

let app;
let adminCookie;
let nextUpdateId = 1000;
before(async () => {
  app = await startApp();
  const r = await fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-admin&name=Reviewer' });
  adminCookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { stopPolling(); await jobs.idle(); await app.close(); });
afterEach(() => {
  config.telegram.enabled = true;
  config.limits.webhookPerMinute = 600;
});

// ------------------------------------------------------------------ helpers
const chatMsg = (chatId, fields) => ({
  update_id: nextUpdateId++,
  message: { message_id: nextUpdateId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private', first_name: 'Ravi' }, from: { id: chatId, first_name: 'Ravi' }, ...fields },
});
const post = (update, secret = SECRET) => fetch(`${app.base}/telegram/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
  body: JSON.stringify(update),
});
async function send(chatId, fields) {
  const r = await post(chatMsg(chatId, fields));
  assert.equal(r.status, 200);
  await inbound.idle();
  await jobs.idle();
}
const sentTo = (chatId) => telegram.sent.filter((s) => String(s.chatId) === String(chatId));
const lastText = (chatId) => sentTo(chatId).filter((s) => s.type === 'message').at(-1)?.text || '';
const customerOf = (chatId) => db.getCustomerByPhone(`tg:${chatId}`);
const adminPost = (p, body) => fetch(`${app.base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const flash = (res) => decodeURIComponent((res.headers.get('location') || '').split(/[?&](ok|err)=/)[2]?.split('&')[0] || '');

// ------------------------------------------------------------------ webhook security
test('webhook: correct secret token -> 200 and processed', async () => {
  const r = await post(chatMsg(5550001, { text: '/start' }));
  assert.equal(r.status, 200);
  await inbound.idle();
  assert.ok(await customerOf(5550001));
});

test('webhook: wrong or missing secret token -> 401 and nothing processed', async () => {
  assert.equal((await post(chatMsg(5550002, { text: 'hi' }), 'wrong-secret')).status, 401);
  assert.equal((await post(chatMsg(5550002, { text: 'hi' }), null)).status, 401);
  await inbound.idle();
  assert.equal(await customerOf(5550002), null);
});

test('webhook: 503 when TELEGRAM_ENABLED=false', async () => {
  config.telegram.enabled = false;
  const r = await post(chatMsg(5550003, { text: 'hi' }));
  assert.equal(r.status, 503);
  assert.equal(await r.text(), 'Telegram not configured');
});

test('webhook: the same update_id delivered twice is processed once', async () => {
  const u = chatMsg(5550004, { text: '/start' });
  assert.equal((await post(u)).status, 200);
  assert.equal((await post(u)).status, 200);
  await inbound.idle();
  const c = await customerOf(5550004);
  const msgs = await db.listMessages(c.id);
  assert.equal(msgs.filter((m) => m.direction === 'in').length, 1);
  assert.equal(sentTo(5550004).length, 1);
});

test('webhook: group chats and non-message updates are ignored', async () => {
  const group = { update_id: nextUpdateId++, message: { message_id: 1, date: 1, chat: { id: -100123, type: 'group' }, text: 'hi' } };
  const edit = { update_id: nextUpdateId++, edited_message: { message_id: 1, chat: { id: 5550005, type: 'private' }, text: 'x' } };
  assert.equal((await post(group)).status, 200);
  assert.equal((await post(edit)).status, 200);
  await inbound.idle();
  assert.equal(await db.getCustomerByPhone('tg:-100123'), null);
  assert.equal(await customerOf(5550005), null);
});

test('webhook is rate limited per IP', async () => {
  config.limits.webhookPerMinute = 1;
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await post(chatMsg(5550006, { text: 'x' }))).status);
  assert.deepEqual(codes.slice(-2), [429, 429]);
});

// ------------------------------------------------------------------ conversation + delivery
test('/start greets and asks for the name, then the business name; customer stored with channel=telegram', async () => {
  const chat = 7770001;
  await send(chat, { text: '/start' });
  assert.match(lastText(chat), /Welcome to \*PIXRA AI\*.*on Telegram/s);
  assert.match(lastText(chat), /what's your name/i);
  let c = await customerOf(chat);
  assert.equal(c.channel, 'telegram');
  assert.equal(c.name, null, 'profile name is not used - we ask');

  await send(chat, { text: "Hi, I'm ravi kumar" });
  c = await customerOf(chat);
  assert.equal(c.name, 'Ravi Kumar');
  assert.match(lastText(chat), /Nice to meet you, Ravi Kumar!/);
  assert.match(lastText(chat), /name of your business/i);
});

test('full Telegram flow: brief -> YES -> posters -> approve -> sendPhoto + sendDocument -> revision', async () => {
  const chat = 7770001; // continues from the previous test
  for (const t of ['Ravi Sweets', 'Diwali sale', 'Sweet Diwali Savings', '20% off all boxes', '28 Oct - 3 Nov', 'Call 98110 00001', 'square', 'red and gold', 'skip']) await send(chat, { text: t });
  assert.match(lastText(chat), /poster brief/i);
  await send(chat, { text: 'YES' });
  const c = await customerOf(chat);
  const job = await db.getLatestJobForCustomer(c.id);
  assert.equal(job.status, 'pending_review', job.error || '');
  assert.match(lastText(chat), /final check/);

  const [a1] = await db.listAssets(job.id);
  const before1 = sentTo(chat).length;
  const r = await adminPost(`/admin/jobs/${job.id}/approve`, { asset_id: a1.id });
  assert.match(flash(r), /sent to the customer via Telegram/);
  const delivered = sentTo(chat).slice(before1);
  assert.deepEqual(delivered.map((d) => d.type), ['photo', 'document']);
  assert.match(delivered[0].caption, /Want any changes\?/);
  assert.ok(delivered[0].bytes > 1000, 'real image bytes uploaded');
  assert.equal(delivered[1].filename, 'pixra-poster.jpg');
  assert.equal((await db.getJob(job.id)).status, 'delivered');

  // revision, exactly like the other channels
  await send(chat, { text: 'change headline to Mega Diwali Sale' });
  const j2 = await db.getJob(job.id);
  assert.equal(j2.brief.headline, 'Mega Diwali Sale');
  assert.equal(j2.status, 'pending_review');
  const v3 = (await db.listAssets(job.id)).at(-1);
  await adminPost(`/admin/jobs/${job.id}/approve`, { asset_id: v3.id });
  assert.equal(sentTo(chat).filter((s) => s.type === 'photo').length, 2);

  // admin shows the channel
  const list = await (await fetch(`${app.base}/admin?tab=all`, { headers: { cookie: adminCookie } })).text();
  assert.match(list, /Telegram chat \.\.0001 · Telegram/);
});

test('the customer\'s personal name is never taken as the business name (unless given for it)', async (t) => {
  const gemini = require('../src/services/gemini');
  // Simulate the model wrongly copying the person's name into business_name.
  t.mock.method(gemini, 'intake', async ({ collected }) => ({
    fields: { business_name: 'Sam', poster_purpose: collected.poster_purpose || 'Opening' },
    ready: false, next_question: 'What is the headline?', asking_for: 'headline',
  }));
  const chat = 7770099;
  await send(chat, { text: '/start' });
  await send(chat, { text: 'sam' });
  let convo = await db.getConversation((await customerOf(chat)).id);
  assert.equal(convo.collected_fields.business_name, undefined, 'person name dropped');
  assert.match(lastText(chat), /name of your business/i, 'asks for the business properly');

  // ...but when we explicitly ask for the business and they answer with their own name, it's accepted
  await send(chat, { text: 'Sam' });
  convo = await db.getConversation((await customerOf(chat)).id);
  assert.equal(convo.collected_fields.business_name, 'Sam');
});

test('voice note: downloaded with getFile, transcribed by Whisper (OGG/Opus)', async (t) => {
  const dl = t.mock.method(telegram, 'downloadMedia', async () => ({ buffer: OGG, mimeType: null }));
  const chat = 7770002;
  await send(chat, { text: '/start' });
  await send(chat, { text: 'Meera' });
  await send(chat, { voice: { file_id: 'VOICE_FILE_1', mime_type: 'audio/ogg', duration: 2 } });
  assert.equal(dl.mock.calls[0].arguments[0], 'VOICE_FILE_1');
  const c = await customerOf(chat);
  const inMsg = (await db.listMessages(c.id)).filter((m) => m.direction === 'in').at(-1);
  assert.equal(inMsg.type, 'audio');
  assert.equal(inMsg.content, MOCK_TRANSCRIPT);
  assert.match(inMsg.media_url, /\.ogg$/);
});

test('photo with caption "logo" (largest size) and an image document both become the logo', async (t) => {
  const dl = t.mock.method(telegram, 'downloadMedia', async () => ({ buffer: PNG, mimeType: null }));
  const chat = 7770003;
  await send(chat, { text: '/start' });
  await send(chat, { text: 'Asha' });
  await send(chat, { photo: [{ file_id: 'SMALL', width: 90, height: 90, file_size: 1000 }, { file_id: 'BIG', width: 800, height: 800, file_size: 50000 }], caption: 'this is my logo' });
  assert.equal(dl.mock.calls.at(-1).arguments[0], 'BIG');
  let c = await customerOf(chat);
  assert.ok(c.logo_url, 'logo saved');
  const first = c.logo_url;
  await send(chat, { document: { file_id: 'DOC1', mime_type: 'image/png', file_name: 'logo.png' }, caption: 'new logo' });
  assert.equal(dl.mock.calls.at(-1).arguments[0], 'DOC1');
  c = await customerOf(chat);
  assert.notEqual(c.logo_url, first);
});

test('stickers and non-image documents get the "unsupported" reply', async () => {
  const chat = 7770004;
  await send(chat, { text: '/start' });
  await send(chat, { sticker: { file_id: 'S1' } });
  assert.match(lastText(chat), /only read text messages, voice notes and images/);
  await send(chat, { document: { file_id: 'D1', mime_type: 'application/pdf' } });
  assert.match(lastText(chat), /only read text messages, voice notes and images/);
});

test('returning Telegram customer: /start skips the name question', async () => {
  const chat = 7770001;
  await send(chat, { text: '/start' });
  assert.match(lastText(chat), /Welcome back, Ravi Kumar!/);
  assert.match(lastText(chat), /new poster for \*Ravi Sweets\*/);
});

test('admin "Send test poster" can target a Telegram customer', async () => {
  const c = await customerOf(7770001);
  const job = await db.getLatestJobForCustomer(c.id);
  const page = await (await fetch(`${app.base}/admin/demo`, { headers: { cookie: adminCookie } })).text();
  assert.match(page, /Send to a Telegram customer/);
  assert.match(page, /Ravi Kumar · chat \.\.0001/);
  const before1 = sentTo(7770001).length;
  const r = await adminPost('/admin/demo/send', { asset_id: job.delivered_asset_id, telegram_customer: c.id });
  assert.match(flash(r), /sent/);
  assert.deepEqual(sentTo(7770001).slice(before1).map((s) => s.type), ['photo', 'document']);
});

// ------------------------------------------------------------------ units
test('parseUpdate normalizes text, voice, audio, photo, image document, unsupported', () => {
  const p = (m) => parseUpdate({ update_id: 1, message: { chat: { id: 42, type: 'private' }, date: 1, ...m } });
  assert.deepEqual([p({ text: 'hi' }).type, p({ voice: { file_id: 'v' } }).type, p({ audio: { file_id: 'a' } }).type], ['text', 'audio', 'audio']);
  assert.equal(p({ voice: { file_id: 'v' } }).mimeType, 'audio/ogg');
  assert.equal(p({ photo: [{ file_id: 's', width: 1, height: 1 }, { file_id: 'l', width: 9, height: 9 }] }).mediaId, 'l');
  assert.equal(p({ document: { file_id: 'd', mime_type: 'image/jpeg' } }).type, 'image');
  assert.equal(p({ document: { file_id: 'd', mime_type: 'application/zip' } }).type, 'unsupported');
  const t = p({ text: 'x' });
  assert.equal(t.from, 'tg:42');
  assert.equal(t.channel, 'telegram');
  assert.equal(t.waMessageId, 'tg-1');
  assert.equal(parseUpdate({ update_id: 2, message: { chat: { id: 1, type: 'supergroup' }, text: 'x' } }), null);
});

test('toTelegramHtml turns *bold* into <b> and escapes user text', () => {
  assert.equal(toTelegramHtml('*Size:* 2 < 3 & <script>'), '<b>Size:</b> 2 &lt; 3 &amp; &lt;script&gt;');
});

test('Bot API client: sendMessage (HTML), sendPhoto multipart, getFile download; token never in errors', async (t) => {
  const TOKEN = '123456:ABCdefGhIJKlmNoPQRsTUVwxyZ0123456789';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (url.endsWith('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga' } }));
    if (url.includes('/file/bot')) return new Response(OGG);
    if (url.endsWith('/sendDocument')) return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
  });
  const api = createTelegramApi({ botToken: TOKEN });
  assert.deepEqual(await api.sendMessage(42, '*Hi* there'), { id: 'tg-out-9' });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.parse_mode, 'HTML');
  assert.equal(body.text, '<b>Hi</b> there');

  await api.sendPhoto(42, PNG, { caption: 'Your *poster*', filename: 'p.png', mimeType: 'image/png' });
  const fd = calls[1].opts.body;
  assert.ok(fd instanceof FormData);
  assert.equal(fd.get('chat_id'), '42');
  assert.equal(fd.get('caption'), 'Your <b>poster</b>');
  assert.equal((await fd.get('photo').arrayBuffer()).byteLength, PNG.length);

  const media = await api.downloadMedia('FILE');
  assert.equal(media.buffer.length, OGG.length);
  assert.equal(calls[3].url, `https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`);

  await assert.rejects(api.sendDocument(42, PNG, {}), (err) => {
    assert.match(err.message, /chat not found/);
    assert.ok(!err.message.includes(TOKEN), 'token must not appear in errors');
    return true;
  });
});

test('long polling: removes the webhook, feeds updates into the pipeline, advances the offset', async () => {
  const offsets = [];
  let deleted = false;
  let round = 0;
  const fakeApi = {
    deleteWebhook: async () => { deleted = true; },
    getMe: async () => ({ username: 'test_bot' }),
    getUpdates: async ({ offset }) => {
      offsets.push(offset);
      round++;
      if (round === 1) return [chatMsg(8880001, { text: '/start' })];
      stopPolling();
      return [];
    },
  };
  await startPolling({ api: fakeApi, timeout: 0, errorDelayMs: 10 });
  await inbound.idle();
  assert.equal(deleted, true);
  assert.equal(offsets[0], undefined);
  assert.equal(offsets[1], nextUpdateId); // last update_id + 1
  assert.ok(await customerOf(8880001));
});

test('startup checks: Telegram vars required only when TELEGRAM_ENABLED=true', () => {
  const snap = structuredClone({ telegram: config.telegram, isProduction: config.isProduction });
  try {
    config.isProduction = true;
    Object.assign(config.telegram, { enabled: true, botToken: '', webhookSecret: '' });
    let errs = checkConfig().errors.join('\n');
    assert.match(errs, /TELEGRAM_BOT_TOKEN is not set/);
    assert.match(errs, /TELEGRAM_WEBHOOK_SECRET is not set/);
    Object.assign(config.telegram, { botToken: 'not-a-token', webhookSecret: 'short' });
    errs = checkConfig().errors.join('\n');
    assert.match(errs, /does not look like a BotFather token/);
    assert.match(errs, /32-256 characters/);
    Object.assign(config.telegram, { botToken: '123456:ABCdefGhIJKlmNoPQRsTUVwxyZ0123456789', webhookSecret: SECRET });
    assert.doesNotMatch(checkConfig().errors.join('\n'), /TELEGRAM_/);
    config.telegram.enabled = false;
    config.telegram.botToken = '';
    assert.doesNotMatch(checkConfig().errors.join('\n'), /TELEGRAM_/);
  } finally {
    Object.assign(config.telegram, snap.telegram);
    config.isProduction = snap.isProduction;
  }
});

test('logs mask Telegram chat ids and bot tokens', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (l) => lines.push(l));
  log.error('send to tg:987654321 failed: https://api.telegram.org/bot123456:ABCdefGhIJKlmNoPQRsTUVwxyZ0123456789/sendMessage chat_id":987654321', { phone: 'tg:987654321' });
  const out = lines.join('\n');
  assert.doesNotMatch(out, /987654321/);
  assert.doesNotMatch(out, /ABCdefGhIJ/);
  assert.match(out, /tg:XXXXX4321/);
  assert.match(out, /bot\[redacted\]/);
});
