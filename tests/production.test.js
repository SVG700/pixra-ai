'use strict';
const { startApp, tmp, textWebhook, signedWebhook } = require('./helpers');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../src/config');
const log = require('../src/logger');
const { checkConfig, adminPasswordProblem } = require('../src/lib/startup-checks');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const snapshot = structuredClone({ ...config });
afterEach(() => {
  for (const k of ['mockMode', 'devMode', 'isProduction']) config[k] = snapshot[k];
  for (const k of ['whatsapp', 'gemini', 'cloudflare', 'supabase', 'admin', 'limits']) Object.assign(config[k], snapshot[k]);
});

// ------------------------------------------------------------------ /dev routes
test('all /dev routes return 404 when DEV_MODE=false', async () => {
  config.devMode = false;
  assert.equal((await fetch(`${app.base}/dev/chat`)).status, 404);
  assert.equal((await fetch(`${app.base}/dev/messages?phone=1`)).status, 404);
  const sim = await fetch(`${app.base}/dev/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"phone":"1","text":"hi"}' });
  assert.equal(sim.status, 404);
  assert.equal((await fetch(`${app.base}/dev/anything-else`)).status, 404);
});

test('/dev routes are 404 in production even if DEV_MODE=true', async () => {
  Object.assign(config, { devMode: true, isProduction: true });
  assert.equal((await fetch(`${app.base}/dev/chat`)).status, 404);
});

test('/dev/chat works when DEV_MODE=true (outside production)', async () => {
  assert.equal((await fetch(`${app.base}/dev/chat`)).status, 200);
});

// ------------------------------------------------------------------ config checks
test('admin password rules: missing, short, default/common, good', () => {
  assert.match(adminPasswordProblem(''), /not set/);
  assert.match(adminPasswordProblem('short1'), /too short/);
  assert.match(adminPasswordProblem('Password123'), /too short/);
  assert.match(adminPasswordProblem('ChangeMe123'), /too short/);
  assert.match(adminPasswordProblem('administrator'), /default\/common/);
  assert.match(adminPasswordProblem('123456789012'), /default\/common/);
  assert.equal(adminPasswordProblem('tulip-Marble-42-river'), null);
});

test('production config check lists every missing requirement', () => {
  Object.assign(config, { mockMode: false, devMode: false, isProduction: true });
  Object.assign(config.supabase, { url: '', serviceRoleKey: '' });
  Object.assign(config.admin, { password: 'admin', sessionSecret: 'short' });
  Object.assign(config.whatsapp, { appSecret: '', token: '' });
  const { errors } = checkConfig();
  const all = errors.join('\n');
  for (const s of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'WHATSAPP_APP_SECRET', 'WHATSAPP_TOKEN']) {
    assert.match(all, new RegExp(s));
  }
});

test('a complete production config passes', () => {
  Object.assign(config, { mockMode: false, devMode: false, isProduction: true });
  Object.assign(config.supabase, { url: 'https://x.supabase.co', serviceRoleKey: 'k' });
  Object.assign(config.admin, { password: 'tulip-Marble-42-river', sessionSecret: 'x'.repeat(40) });
  Object.assign(config.whatsapp, { token: 't', phoneNumberId: '1', verifyToken: 'v', appSecret: 's' });
  Object.assign(config.gemini, { apiKey: 'g' });
  Object.assign(config.cloudflare, { accountId: 'a', apiToken: 'c' });
  assert.deepEqual(checkConfig().errors, []);
});

test('MOCK_MODE=false without production still requires Supabase (no JSON fallback)', () => {
  Object.assign(config, { mockMode: false, devMode: true, isProduction: false });
  Object.assign(config.supabase, { url: '', serviceRoleKey: '' });
  assert.match(checkConfig().errors.join(), /SUPABASE_URL/);
});

// ------------------------------------------------------------------ real process exits
function runServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env, PORT: '0', DATA_DIR: path.join(tmp, 'p-data'), UPLOADS_DIR: path.join(tmp, 'p-up'), LOG_LEVEL: 'info',
        SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('server exits with a clear error when MOCK_MODE=false and Supabase is missing', async () => {
  const { code, out } = await runServer({ MOCK_MODE: 'false', DEV_MODE: 'true', NODE_ENV: 'development' });
  assert.equal(code, 1);
  assert.match(out, /REFUSING TO START/);
  assert.match(out, /SUPABASE_URL is not set/);
});

test('server exits when Supabase is configured but unreachable', async () => {
  const { code, out } = await runServer({
    MOCK_MODE: 'false', DEV_MODE: 'true', NODE_ENV: 'development',
    SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'dummy-key-for-test',
  });
  assert.equal(code, 1);
  assert.match(out, /cannot connect to Supabase/);
});

test('server refuses to start in production with a weak admin password', async () => {
  const { code, out } = await runServer({ NODE_ENV: 'production', MOCK_MODE: 'false', DEV_MODE: 'false', ADMIN_PASSWORD: 'admin' });
  assert.equal(code, 1);
  assert.match(out, /ADMIN_PASSWORD is too short/);
});

test('server refuses NODE_ENV=production with MOCK_MODE=true (never the JSON store)', async () => {
  const { code, out } = await runServer({ NODE_ENV: 'production', MOCK_MODE: 'true', DEV_MODE: 'false' });
  assert.equal(code, 1);
  assert.match(out, /MOCK_MODE=true is not allowed in production/);
  assert.match(out, /SUPABASE_URL is not set/);
});

// ------------------------------------------------------------------ cookies + rate limits
test('admin session cookie is HttpOnly, SameSite=Strict, scoped to /admin, and Secure in production', async () => {
  let r = await fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-admin' });
  let c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/i);
  assert.match(c, /SameSite=Strict/i);
  assert.match(c, /Path=\/admin/i);
  config.isProduction = true;
  r = await fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-admin' });
  c = r.headers.get('set-cookie');
  assert.match(c, /Secure/i);
});

test('admin login: 5 failed attempts per IP, then blocked (even with the right password)', async () => {
  const tryLogin = (pw) => fetch(`${app.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${pw}` });
  for (let i = 0; i < 5; i++) assert.match((await tryLogin('wrong')).headers.get('location'), /Wrong/);
  const blocked = await tryLogin('test-admin');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('set-cookie'), null);
  assert.match(await blocked.text(), /Too many attempts/);
});

test('webhook is rate limited per IP', async () => {
  config.limits.webhookPerMinute = 3;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await signedWebhook(app.base, textWebhook({ id: `wamid.RL${i}`, from: '919811000099' }))).status);
  assert.deepEqual(codes.slice(-2), [429, 429]);
  assert.ok(codes.slice(0, 3).every((c) => c === 200 || c === 429)); // window may include earlier calls
});

// ------------------------------------------------------------------ log privacy
test('logs mask phone numbers and redact secrets', (t) => {
  assert.equal(log.maskPhone('919876543210'), '91XXXXXX3210');
  const lines = [];
  t.mock.method(console, 'log', (l) => lines.push(l));
  t.mock.method(console, 'error', (l) => lines.push(l));
  log.error('customer said: Call +91 98765 43210 now', { phone: '919876543210' }); // tests log at error level
  log.error('request failed', { err: new Error('auth header Bearer test-session-secret-123456 rejected for password test-admin') });
  const all = lines.join('\n');
  assert.doesNotMatch(all, /98765\s?43210|9876543210/);
  assert.match(all, /91XXXXXX3210/);
  assert.doesNotMatch(all, /test-session-secret-123456|test-admin/);
  assert.match(all, /\[redacted\]/);
});
