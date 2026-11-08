'use strict';
const { startApp, tmp, textWebhook, signedWebhook } = require('./helpers');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../src/config');
const db = require('../src/services/db');
const jobs = require('../src/pipeline/jobs');
const inbound = require('../src/pipeline/inbound');
const { checkConfig } = require('../src/lib/startup-checks');

const DEMO_PW = 'demo-Lantern-77-orbit';
let app;
let adminCookie;
before(async () => {
  app = await startApp();
  config.demo.password = DEMO_PW;
  config.whatsapp.enabled = false; // web demo mode for this whole file unless a test says otherwise
  const r = await fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-admin&name=Reviewer' });
  adminCookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { await jobs.idle(); await app.close(); });

const snap = structuredClone({ mockMode: config.mockMode, devMode: config.devMode, isProduction: config.isProduction, supabase: config.supabase, admin: config.admin, whatsapp: config.whatsapp, gemini: config.gemini, cloudflare: config.cloudflare, demo: config.demo });
afterEach(() => {
  Object.assign(config, { mockMode: snap.mockMode, devMode: snap.devMode, isProduction: snap.isProduction });
  for (const k of ['supabase', 'admin', 'whatsapp', 'gemini', 'cloudflare', 'demo']) Object.assign(config[k], snap[k]);
  config.demo.password = DEMO_PW;
  config.whatsapp.enabled = false;
});

const form = (o) => new URLSearchParams(o).toString();
async function demoLogin({ name = 'Asha', phone = '919811122233', password = DEMO_PW } = {}) {
  return fetch(`${app.base}/demo/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ name, phone, password }) });
}
const adminPage = async (p) => (await fetch(`${app.base}${p}`, { headers: { cookie: adminCookie } })).text();

function prodConfig() {
  Object.assign(config, { mockMode: false, devMode: false, isProduction: true });
  Object.assign(config.supabase, { url: 'https://x.supabase.co', serviceRoleKey: 'k' });
  Object.assign(config.admin, { password: 'tulip-Marble-42-river', sessionSecret: 'x'.repeat(40) });
  Object.assign(config.whatsapp, { token: '', phoneNumberId: '', verifyToken: '', appSecret: '' });
  Object.assign(config.gemini, { apiKey: 'g' });
  Object.assign(config.cloudflare, { accountId: 'a', apiToken: 'c' });
}

// ------------------------------------------------------------------ startup checks
test('web demo mode: production checks skip ONLY the WhatsApp variables', () => {
  prodConfig();
  assert.deepEqual(checkConfig().errors, []);
  config.whatsapp.enabled = true;
  assert.match(checkConfig().errors.join('\n'), /WHATSAPP_TOKEN[\s\S]*WHATSAPP_APP_SECRET/, 'still required when WhatsApp is enabled');
});

test('web demo mode: everything else stays enforced (Supabase, admin password, session secret, DEMO_PASSWORD)', () => {
  prodConfig();
  Object.assign(config.supabase, { url: '', serviceRoleKey: '' });
  Object.assign(config.admin, { password: 'admin', sessionSecret: '' });
  config.demo.password = '';
  const all = checkConfig().errors.join('\n');
  for (const s of ['SUPABASE_URL', 'ADMIN_PASSWORD is too short', 'SESSION_SECRET', 'DEMO_PASSWORD is not set']) assert.match(all, new RegExp(s));
  assert.doesNotMatch(all, /WHATSAPP_(TOKEN|PHONE_NUMBER_ID|VERIFY_TOKEN|APP_SECRET)/);
});

test('DEMO_PASSWORD must be strong and different from ADMIN_PASSWORD', () => {
  prodConfig();
  config.demo.password = 'short';
  assert.match(checkConfig().errors.join(), /DEMO_PASSWORD is too short/);
  config.demo.password = 'administrator';
  assert.match(checkConfig().errors.join(), /DEMO_PASSWORD is a default\/common password/);
  config.demo.password = config.admin.password;
  assert.match(checkConfig().errors.join(), /must be different from ADMIN_PASSWORD/);
});

test('server refuses to start in production web demo mode without DEMO_PASSWORD (no WhatsApp errors)', async () => {
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env, PORT: '0', NODE_ENV: 'production', MOCK_MODE: 'false', DEV_MODE: 'false', WHATSAPP_ENABLED: 'false',
        DEMO_PASSWORD: '', WHATSAPP_TOKEN: '', WHATSAPP_APP_SECRET: '', SUPABASE_URL: '', DATA_DIR: path.join(tmp, 'wd'), UPLOADS_DIR: path.join(tmp, 'wu'), LOG_LEVEL: 'info',
      },
    });
    let s = '';
    child.stdout.on('data', (d) => { s += d; });
    child.stderr.on('data', (d) => { s += d; });
    const t = setTimeout(() => child.kill(), 20000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, s }); });
  });
  assert.equal(out.code, 1);
  assert.match(out.s, /DEMO_PASSWORD is not set \(required when WHATSAPP_ENABLED=false\)/);
  assert.match(out.s, /SUPABASE_URL is not set/);
  assert.doesNotMatch(out.s, /WHATSAPP_TOKEN is not set/);
});

// ------------------------------------------------------------------ webhook, dev routes, banner
test('/webhook answers 503 "WhatsApp not configured" (GET and POST)', async () => {
  const g = await fetch(`${app.base}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=1`);
  assert.equal(g.status, 503);
  assert.equal(await g.text(), 'WhatsApp not configured');
  const p = await signedWebhook(app.base, textWebhook({ id: 'wamid.WD1', from: '919811000555' }));
  assert.equal(p.status, 503);
  await inbound.idle();
  assert.equal(await db.getCustomerByPhone('919811000555'), null);
});

test('/dev routes are still 404 in production web demo mode', async () => {
  Object.assign(config, { devMode: true, isProduction: true });
  assert.equal((await fetch(`${app.base}/dev/chat`)).status, 404);
  assert.equal((await fetch(`${app.base}/dev/simulate`, { method: 'POST' })).status, 404);
});

test('admin portal shows "WhatsApp not connected - web demo mode" banner only when WhatsApp is disabled', async () => {
  assert.match(await adminPage('/admin'), /WhatsApp not connected - web demo mode/);
  config.whatsapp.enabled = true;
  assert.doesNotMatch(await adminPage('/admin'), /WhatsApp not connected/);
});

// ------------------------------------------------------------------ /demo access control
test('/demo shows the sign-in page; wrong password, bad phone and missing name are rejected', async () => {
  const page = await (await fetch(`${app.base}/demo`)).text();
  assert.match(page, /Demo password/);
  assert.match(page, /Phone number/);
  let r = await demoLogin({ password: 'wrong-password-123', phone: '919800000001' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
  r = await demoLogin({ phone: '12' });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /country code/);
  r = await demoLogin({ name: '', phone: '919800000001' });
  assert.equal(r.status, 400);
});

test('/demo is disabled when DEMO_PASSWORD is not set', async () => {
  config.demo.password = '';
  const r = await demoLogin({ password: '' });
  assert.equal(r.status, 503);
  assert.match(await r.text(), /not enabled/);
});

test('/demo session cookie is HttpOnly, SameSite=Strict, Path=/demo, Secure in production; never valid for /admin', async () => {
  let r = await demoLogin({ phone: '919800000010' });
  const c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/i);
  assert.match(c, /SameSite=Strict/i);
  assert.match(c, /Path=\/demo/i);
  const demoCookie = c.split(';')[0];
  const value = demoCookie.split('=')[1];
  const asAdmin = await fetch(`${app.base}/admin`, { redirect: 'manual', headers: { cookie: `pixra_admin=${value}` } });
  assert.equal(asAdmin.status, 302, 'demo cookie must not open the admin portal');
  const adminValue = adminCookie.split('=')[1];
  const asDemo = await fetch(`${app.base}/demo/messages`, { headers: { cookie: `pixra_demo=${adminValue}` } });
  assert.equal(asDemo.status, 401, 'admin cookie must not open a demo chat');
  config.isProduction = true;
  r = await demoLogin({ phone: '919800000010' });
  assert.match(r.headers.get('set-cookie'), /Secure/i);
});

test('/demo/messages and /demo/send require a demo session', async () => {
  assert.equal((await fetch(`${app.base}/demo/messages`)).status, 401);
  assert.equal((await fetch(`${app.base}/demo/send`, { method: 'POST', body: new FormData() })).status, 401);
});

test('/demo login is rate limited (5 failures per 15 min)', async () => {
  // separate IP bucket is not possible from one test client, so this runs after the other login tests
  let last;
  for (let i = 0; i < 6; i++) last = await demoLogin({ password: `nope-${i}-xxxxxxxx` });
  assert.equal(last.status, 429);
  assert.match(await last.text(), /Too many attempts/);
  const ok = await demoLogin();
  assert.equal(ok.status, 429, 'even the right password is blocked while limited');
});
