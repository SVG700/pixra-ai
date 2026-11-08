'use strict';
// Checks your configuration against the real services with tiny, (nearly) free calls.
//   npm run doctor                 -> check every service that has keys in .env
//   npm run doctor -- --image      -> also generate one test background with FLUX (uses a little quota)
//   npm run doctor -- --prod       -> treat this as a PRODUCTION config: every requirement must pass,
//                                     plus canvas/ffmpeg self-test and deploy files (render.yaml, git)
//   npm run doctor -- --offline    -> skip all network calls
// Never prints secret values. Exit code 1 if anything failed.
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const args = new Set(process.argv.slice(2));
const PROD = args.has('--prod');
const OFFLINE = args.has('--offline');
const IMAGE = args.has('--image');

let failures = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m, hint) => { failures++; console.log(`  ✖ ${m}${hint ? `\n      -> ${hint}` : ''}`); };
// In --prod mode a missing value is a failure, otherwise just a note.
const skip = (m, hint) => (PROD ? bad(m, hint) : console.log(`  - ${m}`));
const fail = (msg, hint) => Object.assign(new Error(msg), { hint });

async function check(title, fn, { network = false } = {}) {
  console.log(`\n${title}`);
  if (network && OFFLINE) return console.log('  - skipped (--offline)');
  try {
    await fn();
  } catch (err) {
    bad(String(err.message).slice(0, 300), err.hint);
  }
}

async function main() {
  console.log(`PIXRA AI doctor${PROD ? ' --prod' : ''}  (MOCK_MODE=${config.mockMode}, DEV_MODE=${config.devMode}, NODE_ENV=${process.env.NODE_ENV || '-'}, node ${process.version})`);
  if (config.mockMode && !PROD) console.log('Note: MOCK_MODE=true, so the app itself will NOT use these services until you set MOCK_MODE=false.');

  await check('Supabase (MANUAL_STEPS A)', async () => {
    const { url, serviceRoleKey, bucket } = config.supabase;
    if (!url || !serviceRoleKey) return skip('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set', 'Steps 4-5');
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    const { error } = await sb.from('customers').select('id, channel').limit(1);
    if (error) {
      throw fail(`database: ${error.message}`, /relation|does not exist|schema cache|column/i.test(error.message)
        ? 'Run (or re-run) schema.sql in the SQL editor (step 2)' : 'Check SUPABASE_URL and the service_role key (steps 4-5)');
    }
    ok('database reachable, tables and columns exist');
    const { data, error: bErr } = await sb.storage.getBucket(bucket);
    if (bErr) throw fail(`storage bucket "${bucket}": ${bErr.message}`, 'Create the public "posters" bucket (step 3)');
    if (!data.public) throw fail(`bucket "${bucket}" is not public`, 'Storage -> posters -> Edit bucket -> make it Public (step 3)');
    ok(`bucket "${bucket}" exists and is public`);
  }, { network: true });

  await check('Gemini (MANUAL_STEPS B)', async () => {
    const { apiKey, model, fallbackModel, apiVersion } = config.gemini;
    if (!apiKey) return skip('GEMINI_API_KEY not set', 'Step 7');
    const { listModels, suggestFlashModels } = require('../src/services/gemini/models');
    const models = await listModels({ apiKey, apiVersion })
      .catch((e) => { throw fail(e.message, e.status === 400 || e.status === 403 ? 'Check GEMINI_API_KEY (step 7)' : null); });
    const names = models.map((m) => m.name);
    const s = suggestFlashModels(names);
    ok(`key works - ${names.length} models available; Flash models: ${s.flash.slice(0, 8).join(', ') || 'none'}`);
    // Being listed is not enough: retired models stay listed but answer 404 "no longer available to
    // new users", and paid-only models answer 429 with a zero quota. So each one gets a real tiny call.
    const { probeModel } = require('../src/services/gemini/models');
    const problems = [];
    for (const [envName, name] of [['GEMINI_MODEL', model], ['GEMINI_FALLBACK_MODEL', fallbackModel]]) {
      if (!name) { console.log(`  - ${envName} not set (optional, recommended)`); continue; }
      if (!names.includes(name)) { problems.push(`${envName} "${name}" is not offered to this key`); continue; }
      let p = await probeModel({ apiKey, apiVersion, model: name });
      if (p.status === 503) { // overloaded right now - try once more before judging
        await new Promise((r) => setTimeout(r, 5000));
        p = await probeModel({ apiKey, apiVersion, model: name });
      }
      if (p.ok) ok(`${envName} "${name}" answers (${p.ms} ms)`);
      else if (p.status === 503) console.log(`  ! ${envName} "${name}" is temporarily overloaded (HTTP 503 "high demand") - not a config problem; the app retries and then uses the fallback model`);
      else problems.push(`${envName} "${name}" does not answer: HTTP ${p.status} ${p.message}`);
    }
    if (problems.length || !fallbackModel) {
      // Suggest only models that really answer, fast enough for chat.
      const working = [];
      for (const n of s.flash) {
        if (working.length >= 4) break;
        const p = await probeModel({ apiKey, apiVersion, model: n, timeoutMs: 20000 });
        if (p.ok) working.push(n);
      }
      const primary = working.find((n) => !/lite|preview/i.test(n)) || working[0];
      const fallback = working.find((n) => n !== primary && /lite/i.test(n)) || working.find((n) => n !== primary);
      console.log(`      working Flash models: ${working.join(', ') || 'none found'}`);
      console.log(`      suggestion: GEMINI_MODEL=${primary || '?'}${fallback ? `  GEMINI_FALLBACK_MODEL=${fallback}` : ''}`);
    }
    if (problems.length) throw fail(problems.join('; '), 'Update .env (and Render env vars) with the suggestion above');
  }, { network: true });

  await check('Cloudflare Workers AI (MANUAL_STEPS C)', async () => {
    const { accountId, apiToken } = config.cloudflare;
    if (!accountId || !apiToken) return skip('CF_ACCOUNT_ID / CF_API_TOKEN not set', 'Steps 9-10');
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (!res.ok) throw fail(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, 'Check CF_ACCOUNT_ID and that the token uses the "Workers AI" template (steps 9-10)');
    ok('token and account accepted');
    if (IMAGE) {
      const { createWorkersAi } = require('../src/services/cloudflare/workers-ai');
      const img = await createWorkersAi(config.cloudflare).generateImage('soft abstract teal gradient background, bokeh, no text');
      const out = path.join(config.root, 'samples', 'doctor-flux-test.jpg');
      fs.writeFileSync(out, img.buffer);
      ok(`FLUX image generated -> samples/${path.basename(out)}`);
    } else console.log('  - image generation not tested (run: npm run doctor -- --image)');
  }, { network: true });

  await check(`Hugging Face images (MANUAL_STEPS H) - IMAGE_PROVIDER=${config.images.provider}`, async () => {
    const { token, imageModel, inferenceProvider, billTo } = config.huggingface;
    if (!token) {
      console.log('  - Hugging Face not configured (optional) - all backgrounds use Cloudflare');
      if (config.images.provider !== 'cloudflare') console.log(`  ! IMAGE_PROVIDER=${config.images.provider} needs HF_TOKEN; until then Cloudflare is used`);
      return;
    }
    const auth = { Authorization: `Bearer ${token}` };
    const who = await fetch('https://huggingface.co/api/whoami-v2', { headers: auth });
    if (who.status === 401) throw fail('HF_TOKEN rejected (401)', 'Create a new token: https://huggingface.co/settings/tokens (step H1)');
    const me = await who.json();
    const at = me.auth?.accessToken || {};
    const perms = [...(at.fineGrained?.global || []), ...((at.fineGrained?.scoped || []).flatMap((s) => s.permissions || []))];
    ok(`token works - account "${me.name}"${me.isPro ? ' (PRO)' : ' (free)'}, token type ${at.role || '?'}`);
    if (at.role === 'fineGrained' && !perms.includes('inference.serverless.write')) {
      throw fail('token lacks the "Make calls to Inference Providers" permission', 'Edit the token at https://huggingface.co/settings/tokens and tick it (step H1)');
    }
    ok(at.role === 'fineGrained' ? 'permission "Make calls to Inference Providers" present' : `classic "${at.role}" token (can call Inference Providers)`);
    if (billTo) {
      const orgs = (me.orgs || []).map((o) => o.name);
      if (!orgs.includes(billTo)) throw fail(`HF_BILL_TO "${billTo}" is not one of your organizations (${orgs.join(', ') || 'none'})`, 'Check the org name (step H3)');
      ok(`billing organization "${billTo}" (X-HF-Bill-To) - you are a member`);
    }
    console.log(`  - credits: monthly included credits are ${me.isPro ? '$2.00 (PRO)' : '$0 on free accounts (purchase needed)'}; remaining balance is not exposed by the API -> https://huggingface.co/settings/billing`);

    const mres = await fetch(`https://huggingface.co/api/models/${imageModel}?expand[]=inferenceProviderMapping`, { headers: auth });
    if (!mres.ok) throw fail(`model "${imageModel}" not found on the Hub (HTTP ${mres.status})`, 'Check HF_IMAGE_MODEL');
    const map = (await mres.json()).inferenceProviderMapping || [];
    const entries = Array.isArray(map) ? map : Object.entries(map).map(([provider, v]) => ({ provider, ...v }));
    const live = entries.filter((e) => e.status === 'live' && /text-to-image/.test(e.task || 'text-to-image')).map((e) => e.provider);
    if (!live.length) throw fail(`model "${imageModel}" is not served by any Inference Provider right now`, 'Pick another model, e.g. one listed at https://huggingface.co/models?inference_provider=all&pipeline_tag=text-to-image');
    ok(`model ${imageModel} is live on: ${live.join(', ')}`);
    if (inferenceProvider !== 'auto' && !live.includes(inferenceProvider)) throw fail(`HF_INFERENCE_PROVIDER "${inferenceProvider}" does not serve this model`, `Use one of: auto, ${live.join(', ')}`);

    if (IMAGE) {
      const { createHuggingFaceImages } = require('../src/services/images/huggingface');
      const t0 = Date.now();
      try {
        const img = await createHuggingFaceImages(config.huggingface).generateImage('soft abstract teal and gold gradient background, bokeh lights, no text');
        const out = path.join(config.root, 'samples', 'doctor-hf-test.jpg');
        fs.writeFileSync(out, img.buffer);
        ok(`Hugging Face image generated in ${Date.now() - t0} ms via ${img.servedBy} -> samples/${path.basename(out)}`);
      } catch (err) {
        // Optional provider: report clearly, but the app keeps working on Cloudflare.
        console.log(`  ! Hugging Face image FAILED: ${err.reason || err.message}${err.status ? ` (HTTP ${err.status})` : ''}${err.servedBy && err.servedBy !== 'auto' ? ` via ${err.servedBy}` : ''}`);
        if (err.hfKind === 'credits') console.log('      -> no credits on this account: free accounts need purchased credits, or use a PRO token (MANUAL_STEPS H). Cloudflare fallback stays active.');
      }
    } else console.log('  - image generation not tested (run: npm run doctor -- --image; uses a little HF credit)');
  }, { network: true });

  await check('WhatsApp Cloud API (MANUAL_STEPS D)', async () => {
    if (!config.whatsapp.enabled) {
      console.log('  - skipped: WHATSAPP_ENABLED=false (web demo mode - customers use /demo, /webhook answers 503)');
      return;
    }
    const { token, phoneNumberId, verifyToken, appSecret, graphApiVersion } = config.whatsapp;
    if (!token || !phoneNumberId) return skip('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set', 'Step 12');
    const res = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(body.error?.message || `HTTP ${res.status}`, body.error?.code === 190 ? 'Token expired/invalid - generate a new one (step 12 or 17)' : 'Check WHATSAPP_PHONE_NUMBER_ID (step 12)');
    ok(`phone number ${body.display_phone_number} (${body.verified_name})`);
    if (!verifyToken) throw fail('WHATSAPP_VERIFY_TOKEN not set', 'Steps 14, 16');
    ok('verify token set');
    if (!appSecret) throw fail('WHATSAPP_APP_SECRET not set - webhook POSTs will be rejected with 401', 'Step 18');
    ok('app secret set (webhook signatures will be verified)');
  }, { network: true });

  await check('Telegram bot (MANUAL_STEPS T)', async () => {
    const { enabled, botToken, webhookSecret } = config.telegram;
    if (!enabled) return console.log('  - skipped: TELEGRAM_ENABLED=false');
    if (!botToken) return skip('TELEGRAM_BOT_TOKEN not set', 'Step T1 (@BotFather /newbot)');
    const { createTelegramApi } = require('../src/services/telegram/api');
    const api = createTelegramApi(config.telegram);
    const me = await api.getMe().catch((e) => { throw fail(e.message, 'Token rejected - copy it again from @BotFather (step T1)'); });
    ok(`token works - bot @${me.username}`);
    if (!webhookSecret || webhookSecret.length < 32) throw fail('TELEGRAM_WEBHOOK_SECRET missing or shorter than 32 chars', 'Step T2');
    ok('webhook secret set');
    const info = await api.getWebhookInfo();
    if (info.url) {
      ok(`webhook registered: ${info.url}${info.pending_update_count ? ` (${info.pending_update_count} pending)` : ''}`);
      if (info.last_error_message) console.log(`  ! last webhook error: ${info.last_error_message}`);
      if (config.devMode && config.telegram.polling && !PROD) console.log('  ! local long polling will REMOVE this webhook when you start the app locally (re-run telegram:set-webhook afterwards)');
    } else if (PROD) {
      console.log('  ! no webhook registered yet - after deploying run: npm run telegram:set-webhook -- https://<service>.onrender.com');
    } else {
      ok('no webhook set - local long polling will be used');
    }
  }, { network: true });

  await check('App settings', async () => {
    if (!config.publicBaseUrl) console.log('  - PUBLIC_BASE_URL not set (fine on Render: RENDER_EXTERNAL_URL is used; needed locally with a tunnel)');
    else if (!/^https:\/\//.test(config.publicBaseUrl)) throw fail('PUBLIC_BASE_URL must start with https://');
    else ok(`PUBLIC_BASE_URL = ${config.publicBaseUrl}`);
    const { adminPasswordProblem } = require('../src/lib/startup-checks');
    const pw = adminPasswordProblem();
    if (pw) throw fail(pw, 'Step 19 - at least 12 characters, not a common password');
    ok('ADMIN_PASSWORD is strong enough');
    if (!config.admin.sessionSecret || config.admin.sessionSecret.length < 32) throw fail('SESSION_SECRET missing or shorter than 32 chars');
    ok('SESSION_SECRET set');
    const { demoPasswordProblem } = require('../src/lib/startup-checks');
    if (!config.whatsapp.enabled || config.demo.password) {
      const dp = demoPasswordProblem();
      if (dp) throw fail(dp, 'Needed for the /demo customer chat (web demo mode) - MANUAL_STEPS step 19c');
      ok('DEMO_PASSWORD set (strong, different from ADMIN_PASSWORD)');
    }
    console.log(`  - mode: ${config.whatsapp.enabled ? 'WhatsApp' : 'web demo (WHATSAPP_ENABLED=false)'}`);
  });

  if (PROD) {
    await check('Production requirements (same checks the server runs at startup)', async () => {
      Object.assign(config, { isProduction: true });
      const { checkConfig } = require('../src/lib/startup-checks');
      const { errors, warnings } = checkConfig();
      for (const e of errors) bad(e);
      for (const w of warnings) console.log(`  ! ${w}`);
      if (!errors.length) ok('server would start in production with this configuration');
    });

    await check('Native components on this machine (canvas + fonts, ffmpeg)', async () => {
      const r = await require('../src/lib/self-test').runSelfTest();
      if (r.canvas.ok) ok(`canvas renders posters (${r.canvas.platform}, ${r.canvas.ms} ms)`); else bad(`canvas: ${r.canvas.error}`);
      if (r.ffmpeg.ok) ok(`ffmpeg ${r.ffmpeg.version}`); else bad(`ffmpeg: ${r.ffmpeg.error}`, 'npm install (ffmpeg-static downloads its binary) or set FFMPEG_PATH');
      console.log('  - on Render, the same self-test result is shown at /health ("selfTest")');
    });

    await check('Deploy files (render.yaml, package.json, lockfile, git)', async () => {
      for (const r of require('../src/lib/deploy-checks').checkDeployFiles()) (r.ok ? ok(r.label) : bad(r.label, r.hint));
    });
  }

  console.log(failures ? `\n${failures} problem(s) found.` : `\nAll ${PROD ? 'production ' : ''}checks passed.`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
