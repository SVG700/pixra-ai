'use strict';
// Static checks of the deploy setup (render.yaml, package.json, lockfile, git). Used by
// `npm run doctor -- --prod` and tests/deploy.test.js.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../config');
const { FONT_FILES } = require('./self-test');

const ROOT = config.root;

const RENDER_REQUIRED = [
  'NODE_VERSION', 'NODE_ENV', 'MOCK_MODE', 'DEV_MODE', 'WHATSAPP_ENABLED', 'DEMO_PASSWORD', 'DEMO_RATE_LIMIT_PER_10MIN',
  'TELEGRAM_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
  'IMAGE_PROVIDER', 'IMAGE_FALLBACK_ENABLED', 'HF_TOKEN', 'HF_BILL_TO', 'HF_IMAGE_MODEL', 'HF_INFERENCE_PROVIDER',
  'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'GRAPH_API_VERSION',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL', 'GEMINI_API_VERSION',
  'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_IMAGE_MODEL', 'CF_WHISPER_MODEL',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET',
  'ADMIN_PASSWORD', 'SESSION_SECRET',
];
// Must never have a literal value in render.yaml.
const RENDER_SECRETS = [
  'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'GEMINI_API_KEY',
  'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'DEMO_PASSWORD',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'HF_TOKEN', 'HF_BILL_TO',
];

// Minimal parser for our render.yaml shape (no YAML dependency needed).
function parseRenderYaml(text) {
  const field = (name) => (text.match(new RegExp(`^\\s+${name}:\\s*(.+?)\\s*(#.*)?$`, 'm')) || [])[1] || null;
  const env = {};
  const re = /-\s+key:\s*(\S+)\s*\n\s+(value|sync|generateValue):\s*("[^"]*"|\S+)/g;
  let m;
  while ((m = re.exec(text))) env[m[1]] = { kind: m[2], value: m[3].replace(/^"|"$/g, '') };
  return {
    runtime: field('runtime'), plan: field('plan'), buildCommand: field('buildCommand'),
    startCommand: field('startCommand'), healthCheckPath: field('healthCheckPath'), env,
  };
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Returns [{ ok, label, hint? }] */
function checkDeployFiles() {
  const results = [];
  const add = (ok, label, hint) => results.push({ ok: !!ok, label, hint });

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const engines = pkg.engines?.node || '';
  add(/^\d+\.x$/.test(engines), `package.json engines.node pinned to a major version ("${engines}")`, 'Use e.g. "22.x"');

  const yamlPath = path.join(ROOT, 'render.yaml');
  if (!fs.existsSync(yamlPath)) {
    add(false, 'render.yaml exists');
    return results;
  }
  const r = parseRenderYaml(fs.readFileSync(yamlPath, 'utf8'));
  add(r.runtime === 'node' && r.plan === 'free', `render.yaml: runtime node, plan free (${r.runtime}/${r.plan})`);
  add(/^npm ci\b/.test(r.buildCommand || ''), `render.yaml buildCommand uses npm ci ("${r.buildCommand}")`, 'npm ci installs the exact lockfile');
  add(r.startCommand === 'npm start' && pkg.scripts?.start === 'node src/server.js', `render.yaml startCommand "${r.startCommand}" -> "${pkg.scripts?.start}"`);
  add(r.healthCheckPath === '/health', `render.yaml healthCheckPath "${r.healthCheckPath}"`);
  const nodeVer = r.env.NODE_VERSION?.value || '';
  add(nodeVer && engines.startsWith(`${nodeVer.split('.')[0]}.`), `NODE_VERSION (${nodeVer}) matches engines (${engines})`);
  add(r.env.NODE_ENV?.value === 'production', 'render.yaml sets NODE_ENV=production');
  add(r.env.MOCK_MODE?.value === 'false' && r.env.DEV_MODE?.value === 'false', 'render.yaml sets MOCK_MODE=false and DEV_MODE=false');
  const missing = RENDER_REQUIRED.filter((k) => !r.env[k]);
  add(!missing.length, `render.yaml lists all required env vars${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  const literal = RENDER_SECRETS.filter((k) => r.env[k] && r.env[k].kind === 'value');
  add(!literal.length, `secrets use sync: false / generateValue${literal.length ? ` (literal values: ${literal.join(', ')})` : ''}`);

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  add(lock.packages?.['node_modules/@napi-rs/canvas-linux-x64-gnu'], 'package-lock.json includes the Linux (glibc x64) canvas binary for Render');
  add(lock.packages?.['node_modules/ffmpeg-static'], 'package-lock.json includes ffmpeg-static');
  add(pkg.allowScripts && Object.keys(pkg.allowScripts).some((k) => k.startsWith('ffmpeg-static')), 'ffmpeg-static install script is allowed (package.json allowScripts)');

  const tracked = git(['ls-files']);
  if (tracked == null) {
    add(false, 'git repository readable', 'Run doctor from the project folder');
  } else {
    const files = tracked.split('\n');
    const missingFonts = FONT_FILES.filter((f) => !files.includes(`fonts/${f}`));
    add(!missingFonts.length, `fonts committed to git${missingFonts.length ? ` (missing: ${missingFonts.join(', ')})` : ''}`);
    add(['src/templates/bold-top.js', 'src/templates/centered-card.js'].every((f) => files.includes(f)), 'poster templates committed to git');
    const secretFiles = files.filter((f) => /(^|\/)\.env($|\.(?!example$))|^data\/|^uploads\//.test(f));
    add(!secretFiles.length, `no .env / local data files tracked${secretFiles.length ? ` (tracked: ${secretFiles.join(', ')})` : ''}`);
    add(git(['check-ignore', '-q', '.env']) !== null, '.env is git-ignored');
  }
  return results;
}

module.exports = { checkDeployFiles, parseRenderYaml, RENDER_REQUIRED, RENDER_SECRETS };
