'use strict';
// Job runner: brief -> image prompt -> 2 backgrounds -> 2 composed posters -> AI QA -> pending_review.
// Jobs run one at a time (free-tier quotas). Every step is logged with the job id.
// Old assets are never overwritten: every render creates a new asset row with the next version.
const crypto = require('crypto');
const db = require('../services/db');
const gemini = require('../services/gemini');
const images = require('../services/images');
const { createMockGemini } = require('../services/gemini/mock');
const { composePoster, TEMPLATE_IDS } = require('../services/poster');
const log = require('../logger');
const outbound = require('./outbound');
const { formatDue } = require('../lib/time');
const { runWithJob, events: jobEvents } = require('../lib/job-context');

const LAYOUT_HINT = {
  bold_top: 'Composition: the main subject sits in the lower-middle of the frame; the upper part is calm, dark and uncluttered.',
  centered_card: 'Composition: interesting details around the edges and corners; the centre is soft, simple and slightly blurred.',
};
const NO_TEXT = 'Absolutely no text, no letters, no words, no numbers, no logos, no signage, no watermark.';
const ruleBased = createMockGemini();

// ------------------------------------------------------------------ live activity (shown in the portal)
// jobId -> { step, wait?: { service, status, attempt, retries, until } }. In memory: the portal is
// served by the same process, and after a restart the job is resumed from scratch anyway.
const activity = new Map();

const SERVICE_NAMES = [[/gemini/i, 'Gemini'], [/hugging ?face|huggingface/i, 'Hugging Face'], [/flux/i, 'Cloudflare FLUX'], [/whisper/i, 'Cloudflare Whisper'], [/whatsapp/i, 'WhatsApp'], [/storage|supabase/i, 'Supabase']];
const serviceOf = (label) => (SERVICE_NAMES.find(([re]) => re.test(label)) || [null, label])[1];

function setStep(jobId, step) {
  const a = activity.get(jobId) || {};
  activity.set(jobId, { ...a, step, wait: null });
}

jobEvents.on('wait', ({ jobId, label, status, attempt, retries, delayMs }) => {
  if (!jobId) return;
  const a = activity.get(jobId) || {};
  activity.set(jobId, { ...a, wait: { service: serviceOf(label), status, attempt, retries, until: Date.now() + delayMs } });
});
jobEvents.on('recovered', ({ jobId }) => {
  const a = jobId && activity.get(jobId);
  if (a) activity.set(jobId, { ...a, wait: null });
});

// ------------------------------------------------------------------ serial queue
let chain = Promise.resolve();
const queued = new Set();
const order = []; // job ids in queue order (first = running)

function enqueue(jobId, label, fn) {
  if (queued.has(jobId)) {
    log.info(`${label}: already queued, skipping duplicate`, { jobId });
    return chain;
  }
  queued.add(jobId);
  order.push(jobId);
  setStep(jobId, 'Queued');
  const p = chain.then(async () => {
    try {
      await runWithJob(jobId, fn);
    } catch (err) {
      log.error(`${label} crashed`, { jobId, err });
    } finally {
      queued.delete(jobId);
      order.splice(order.indexOf(jobId), 1);
      activity.delete(jobId);
    }
  });
  chain = p;
  return p;
}

/**
 * What a job is doing right now, for the portal:
 * { state: 'queued', ahead } | { state: 'running', step, wait } | null (not in the runner)
 */
function jobActivity(jobId) {
  const idx = order.indexOf(jobId);
  if (idx === -1) return null;
  if (idx > 0) return { state: 'queued', ahead: idx };
  const a = activity.get(jobId) || {};
  const wait = a.wait && a.wait.until > Date.now() - 2000 ? a.wait : null;
  return { state: 'running', step: a.step || 'Working', wait };
}

// Turns a final 429/quota failure into an explanation the portal can show.
function explainFailure(err) {
  const msg = String(err.message || err);
  if (/HTTP 429|quota|rate.?limit|exhausted/i.test(msg)) {
    const svc = serviceOf(msg);
    return `Free-tier rate limit / daily quota reached${svc && svc !== msg ? ` (${svc})` : ''}. Wait a few minutes (or until tomorrow for daily quotas) and click Retry. Details: ${msg}`;
  }
  return msg;
}

async function idle() {
  let last;
  do {
    last = chain;
    await last;
  } while (last !== chain);
}

// ------------------------------------------------------------------ building blocks
async function loadLogo(brief, jlog) {
  if (!brief.logo_url) return null;
  try {
    return await db.readFile(brief.logo_url);
  } catch (err) {
    jlog.warn('could not load logo, rendering without it', { err });
    return null;
  }
}

async function imagePrompt(brief, feedback, jlog) {
  try {
    const p = await gemini.writeImagePrompt({ brief, feedback });
    jlog.info(`image prompt: ${p.slice(0, 120)}...`);
    return p;
  } catch (err) {
    jlog.warn('image prompt via Gemini failed, using template prompt', { err });
    return ruleBased.writeImagePrompt({ brief, feedback });
  }
}

// Composes one poster on a background, uploads it, and stores a new asset version.
// bgMeta: { background_provider, background_model, background_served_by, background_note } (where the image came from)
async function composeAndSave(job, { background, backgroundUrl, template, brief, logo, source = 'ai', bgMeta = {} }) {
  const size = brief.size === 'portrait' ? 'portrait' : 'square';
  const poster = await composePoster({ background, brief, template, size, logo });
  const key = `jobs/${job.id}/poster-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`;
  const imageUrl = await db.uploadFile(key, poster.buffer, poster.mimeType);
  const asset = await db.createAsset({
    job_id: job.id, image_url: imageUrl, background_url: backgroundUrl, template, size, source,
    qa_report: null,
    ...bgMeta,
  });
  return { asset, poster };
}

async function runQa(job, brief, items, jlog) {
  for (const { asset, poster } of items) {
    setStep(job.id, `AI quality check of v${asset.version} (Gemini vision)`);
    let report;
    try {
      report = await gemini.qaPoster({ image: poster.buffer, mimeType: poster.mimeType, brief, truncated: poster.truncated });
    } catch (err) {
      jlog.warn(`QA failed for v${asset.version}`, { err });
      report = { score: null, all_required_text_present: null, readability_issues: [], notes: `QA unavailable: ${err.message.slice(0, 200)}`, error: true };
    }
    if (poster.truncated.length) report.layout_truncated = poster.truncated;
    report.checked_at = new Date().toISOString();
    await db.updateAsset(asset.id, { qa_report: report });
    jlog.info(`QA v${asset.version} (${asset.template}): score ${report.score ?? 'n/a'}, text ok: ${report.all_required_text_present}`);
  }
}

// Moves the job to review and tells the customer (once per round).
async function finishRound(job, jlog) {
  setStep(job.id, 'Sending "final review" message to the customer');
  await db.updateJob(job.id, { status: 'qa_done' });
  const done = await db.updateJob(job.id, { status: 'pending_review', error: null, regen_note: null, regen_provider: null });
  jlog.info('status -> pending_review');
  const customer = await db.getCustomer(job.customer_id);
  const msg = job.revision_count > 0
    ? `Your updated poster is ready and with our designer for a final check 👀 You'll get it by *${formatDue(job.deadline)}*.`
    : `Good news - your poster is ready and with our designer for a final check 👀 You'll get it by *${formatDue(job.deadline)}*.`;
  try {
    await outbound.sendText(customer, msg, { jobId: job.id });
  } catch (err) {
    jlog.warn('could not send review notice to customer', { err });
  }
  return done;
}

async function fail(job, err, jlog) {
  jlog.error('job failed', { err });
  await db.updateJob(job.id, { status: 'failed', error: explainFailure(err).slice(0, 1000) });
}

// ------------------------------------------------------------------ main generation
const RUNNABLE = ['brief_confirmed', 'generating', 'revision_requested'];

async function generate(jobId) {
  let job = await db.getJob(jobId);
  const jlog = log.child({ jobId });
  if (!job) return jlog.warn('generate: job not found');
  if (!RUNNABLE.includes(job.status)) return jlog.info(`generate: status is ${job.status}, nothing to do`);

  job = await db.updateJob(job.id, { status: 'generating', attempts: (job.attempts || 0) + 1, error: null });
  jlog.info(`generation started (attempt ${job.attempts})`);
  const brief = job.brief || {};
  const feedback = [job.regen_note, job.revision_request].filter(Boolean).join('. ') || null;
  const override = job.regen_provider || null; // reviewer's "Reject & Regenerate" provider choice (one round)

  try {
    setStep(job.id, 'Writing the image prompt (Gemini)');
    const [prompt, logo] = await Promise.all([imagePrompt(brief, feedback, jlog), loadLogo(brief, jlog)]);
    const items = [];
    const errors = [];
    for (const [i, template] of TEMPLATE_IDS.entries()) {
      try {
        const want = images.providerFor(i, override);
        setStep(job.id, `Generating background ${i + 1} of ${TEMPLATE_IDS.length} (${images.LABEL[want]})`);
        const fullPrompt = `${prompt} ${LAYOUT_HINT[template] || ''} ${NO_TEXT}`;
        const t0 = Date.now();
        const bg = await images.generateBackground(fullPrompt, { index: i, override, logger: jlog });
        jlog.info(`background for ${template} generated in ${Date.now() - t0}ms by ${images.LABEL[bg.provider]} ${bg.model}${bg.servedBy && bg.servedBy !== 'auto' ? ` via ${bg.servedBy}` : ''}${bg.fallbackReason ? ` (fallback: ${bg.fallbackReason})` : ''}`);
        const bgMeta = { background_provider: bg.provider, background_model: bg.model, background_served_by: bg.servedBy || null, background_note: bg.fallbackReason || null };
        const backgroundUrl = await db.uploadFile(`jobs/${job.id}/bg-${Date.now()}-${template}.jpg`, bg.buffer, bg.mimeType || 'image/jpeg');
        setStep(job.id, `Composing poster ${i + 1} of ${TEMPLATE_IDS.length}`);
        const item = await composeAndSave(job, { background: bg.buffer, backgroundUrl, template, brief, logo, bgMeta });
        jlog.info(`poster v${item.asset.version} (${template}) saved`);
        items.push(item);
      } catch (err) {
        jlog.warn(`option ${template} failed`, { err });
        errors.push(`${template}: ${err.message}`);
      }
    }
    if (!items.length) throw new Error(`all poster options failed - ${errors.join(' | ')}`);
    await runQa(job, brief, items, jlog);
    await finishRound(job, jlog);
  } catch (err) {
    await fail(job, err, jlog);
  }
}

// Re-renders text changes on existing backgrounds (no new AI image). Used for text edits/revisions.
async function rerender(jobId, { fromAssets, brief, source = 'edit' }) {
  const jlog = log.child({ jobId });
  let job = await db.getJob(jobId);
  if (!job) return jlog.warn('rerender: job not found');
  job = await db.updateJob(job.id, { status: 'generating', brief, error: null });
  jlog.info(`re-rendering ${fromAssets.length} version(s) with updated text`);
  setStep(job.id, 'Re-rendering text on the existing background');
  try {
    const logo = await loadLogo(brief, jlog);
    const items = [];
    for (const a of fromAssets) {
      if (!a.background_url) continue;
      const background = await db.readFile(a.background_url);
      const template = TEMPLATE_IDS.includes(a.template) ? a.template : TEMPLATE_IDS[0];
      const bgMeta = { background_provider: a.background_provider || null, background_model: a.background_model || null, background_served_by: a.background_served_by || null, background_note: a.background_note || null };
      items.push(await composeAndSave(job, { background, backgroundUrl: a.background_url, template, brief, logo, source, bgMeta }));
    }
    if (!items.length) throw new Error('no background available to re-render on');
    await runQa(job, brief, items, jlog);
    await finishRound(job, jlog);
  } catch (err) {
    await fail(job, err, jlog);
  }
}

// ------------------------------------------------------------------ public API
function startJob(jobId) {
  return enqueue(jobId, 'generate', () => generate(jobId));
}

function startRerender(jobId, opts) {
  return enqueue(jobId, 'rerender', () => rerender(jobId, opts));
}

// On boot (Render free tier sleeps/restarts): resume anything that was mid-flight.
async function resumeStuckJobs() {
  // revision_requested is resumed as a full regenerate (the pending re-render was lost with the process).
  const stuck = await db.listJobs({ statuses: ['brief_confirmed', 'generating', 'revision_requested'] });
  for (const job of stuck.reverse()) {
    log.info(`resuming job left in "${job.status}" after restart`, { jobId: job.id });
    startJob(job.id);
  }
  return stuck.length;
}

module.exports = { startJob, startRerender, resumeStuckJobs, idle, composeAndSave, jobActivity, explainFailure, RUNNABLE };
