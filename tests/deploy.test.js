'use strict';
const { startApp } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkDeployFiles, parseRenderYaml, RENDER_SECRETS } = require('../src/lib/deploy-checks');
const { runSelfTest } = require('../src/lib/self-test');

const ROOT = path.join(__dirname, '..');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('every deploy-file check passes (render.yaml, engines, lockfile, fonts in git)', () => {
  const failed = checkDeployFiles().filter((r) => !r.ok);
  assert.deepEqual(failed, []);
});

test('render.yaml: build/start/health and all secrets are sync:false', () => {
  const r = parseRenderYaml(fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8'));
  assert.equal(r.buildCommand, 'npm ci --omit=dev');
  assert.equal(r.startCommand, 'npm start');
  assert.equal(r.healthCheckPath, '/health');
  for (const k of RENDER_SECRETS) {
    assert.ok(r.env[k], `${k} listed`);
    assert.ok(['sync', 'generateValue'].includes(r.env[k].kind), `${k} must not have a literal value`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, `${r.env.NODE_VERSION.value}.x`);
});

test('every variable the app reads is documented in .env.example', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  const used = [...src.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]).filter((k) => !['RENDER_EXTERNAL_URL'].includes(k));
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const missing = [...new Set(used)].filter((k) => !new RegExp(`^${k}=`, 'm').test(example));
  assert.deepEqual(missing, []);
});

test('self-test: canvas renders with bundled fonts and ffmpeg runs', async () => {
  const r = await runSelfTest();
  assert.equal(r.canvas.ok, true, r.canvas.error);
  assert.equal(r.ffmpeg.ok, true, r.ffmpeg.error);
  assert.equal(r.status, 'ok');
  const h = await (await fetch(`${app.base}/health`)).json();
  assert.equal(h.selfTest.status, 'ok');
});

test('doctor --prod --offline fails (exit 1) on a non-production config and names the problems', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.js'), '--prod', '--offline'], {
    env: { ...process.env, MOCK_MODE: 'true', SUPABASE_URL: '', WHATSAPP_APP_SECRET: '', ADMIN_PASSWORD: 'admin' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /MOCK_MODE=true is not allowed in production/);
  assert.match(r.stdout, /SUPABASE_URL is not set/);
  assert.match(r.stdout, /WHATSAPP_APP_SECRET is not set/);
  assert.match(r.stdout, /ADMIN_PASSWORD is too short/);
  assert.match(r.stdout, /render\.yaml lists all required env vars/);
});

test('doctor --prod --offline passes in web demo mode with NO WhatsApp variables', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.js'), '--prod', '--offline'], {
    env: {
      ...process.env, NODE_ENV: 'production', MOCK_MODE: 'false', DEV_MODE: 'false', WHATSAPP_ENABLED: 'false',
      WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_VERIFY_TOKEN: '', WHATSAPP_APP_SECRET: '',
      SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_PASSWORD: 'tulip-Marble-42-river',
      DEMO_PASSWORD: 'demo-Lantern-77-orbit', SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'g', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 'c',
    },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /web demo mode/);
  assert.match(r.stdout, /DEMO_PASSWORD set/);
  assert.match(r.stdout, /server would start in production/);
});

test('doctor --prod --offline passes with a complete production config', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.js'), '--prod', '--offline'], {
    env: {
      ...process.env, NODE_ENV: 'production', MOCK_MODE: 'false', DEV_MODE: 'false',
      SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_PASSWORD: 'tulip-Marble-42-river',
      SESSION_SECRET: 'x'.repeat(40), WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_VERIFY_TOKEN: 'v',
      WHATSAPP_APP_SECRET: 's', GEMINI_API_KEY: 'g', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 'c', PUBLIC_BASE_URL: 'https://pixra.onrender.com',
    },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /server would start in production/);
});
