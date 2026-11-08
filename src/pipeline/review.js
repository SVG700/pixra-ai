'use strict';
// Human review actions from the admin portal. Each action is recorded in the reviews table.
const db = require('../services/db');
const log = require('../logger');
const outbound = require('./outbound');
const jobs = require('./jobs');
const { FIELDS, normalizeSize } = require('../lib/brief');
const { TEMPLATE_IDS } = require('../services/poster');

const BUSY = ['brief_confirmed', 'generating'];

class ReviewError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
    this.expose = true;
  }
}

async function loadJob(jobId) {
  const job = await db.getJob(jobId);
  if (!job) throw new ReviewError('Job not found');
  return job;
}

function deliveryCaption(job) {
  const biz = job.brief?.business_name ? ` for *${job.brief.business_name}*` : '';
  return `Here's your poster${biz} 🎉\n\nWant any changes? Just reply with what to change (e.g. "change the date to 5 Nov" or "make the background darker"). Reply *DONE* if you're happy, or *NEW* for another poster.`;
}

// Approve an asset and send it to the customer on WhatsApp.
async function approveAndSend(jobId, assetId, reviewer) {
  const job = await loadJob(jobId);
  const jlog = log.child({ jobId });
  if (BUSY.includes(job.status)) throw new ReviewError('This job is still generating - wait for it to finish.');
  const asset = await db.getAsset(assetId);
  if (!asset || asset.job_id !== job.id) throw new ReviewError('Choose a poster version of this job');
  const customer = await db.getCustomer(job.customer_id);

  const prevStatus = job.status;
  await db.updateJob(job.id, { status: 'approved', error: null });
  await db.createReview({ job_id: job.id, asset_id: asset.id, reviewer, action: 'approve', notes: `v${asset.version}` });
  try {
    await outbound.sendImage(customer, asset.image_url, deliveryCaption(job), { jobId: job.id });
  } catch (err) {
    jlog.error('delivery failed', { err });
    await db.updateJob(job.id, { status: prevStatus === 'approved' ? 'pending_review' : prevStatus, error: `Delivery failed: ${err.message}` });
    throw new ReviewError(`WhatsApp delivery failed: ${err.message}`);
  }
  await db.updateJob(job.id, { status: 'delivered', delivered_asset_id: asset.id, error: null });
  const convo = await db.getConversation(customer.id);
  // Only move the chat to "delivered" if the customer hasn't started a different poster meanwhile.
  if (!convo || convo.collected_fields?.job_id === job.id || convo.state === 'idle') {
    await db.saveConversation(customer.id, { state: 'delivered', collected_fields: { ...(convo?.collected_fields || {}), job_id: job.id } });
  }
  jlog.info(`v${asset.version} approved by ${reviewer} and delivered`);
  return { asset, customer };
}

// Generate fresh backgrounds, adding the reviewer's note to the image prompt.
// provider: 'huggingface' | 'cloudflare' | '' (= IMAGE_PROVIDER setting) - applies to this one regenerate.
async function rejectAndRegenerate(jobId, note, reviewer, provider = '') {
  const job = await loadJob(jobId);
  if (BUSY.includes(job.status)) throw new ReviewError('Already generating.');
  const regenProvider = ['huggingface', 'cloudflare'].includes(provider) ? provider : null;
  await db.updateJob(job.id, { status: 'brief_confirmed', regen_note: String(note || '').trim() || null, regen_provider: regenProvider, error: null });
  const via = regenProvider ? `[${regenProvider === 'huggingface' ? 'Hugging Face' : 'Cloudflare'}] ` : '';
  await db.createReview({ job_id: job.id, reviewer, action: 'reject_regenerate', notes: `${via}${note || ''}`.trim() || null });
  jobs.startJob(job.id);
}

// Latest version of each template that has a background (for re-rendering text).
async function latestBackgrounds(jobId) {
  const assets = (await db.listAssets(jobId)).filter((a) => a.background_url);
  const latest = new Map();
  for (const a of assets) latest.set(a.template, a); // listAssets is ascending by version
  return TEMPLATE_IDS.map((t) => latest.get(t)).filter(Boolean);
}

// Edit brief text fields and re-render on the same backgrounds.
async function editText(jobId, fields, reviewer, { fromAssetId } = {}) {
  const job = await loadJob(jobId);
  if (BUSY.includes(job.status)) throw new ReviewError('Already generating.');
  const brief = { ...job.brief };
  const changed = [];
  for (const f of FIELDS) {
    if (f === 'logo' || !(f in fields)) continue;
    let v = String(fields[f] ?? '').trim();
    if (f === 'size') v = normalizeSize(v) || brief.size;
    if ((brief[f] ?? '') !== v) {
      brief[f] = v;
      changed.push(f);
    }
  }
  let from = await latestBackgrounds(job.id);
  if (fromAssetId) {
    const a = await db.getAsset(fromAssetId);
    if (a?.job_id === job.id && a.background_url) from = [a];
  }
  if (!from.length) throw new ReviewError('No AI background to re-render on. Use Regenerate instead.');
  await db.createReview({ job_id: job.id, reviewer, action: 'edit_text', notes: changed.length ? `changed: ${changed.join(', ')}` : 're-render' });
  jobs.startRerender(job.id, { fromAssets: from, brief, source: 'edit' });
  return changed;
}

async function assign(jobId, name, reviewer) {
  const job = await loadJob(jobId);
  const assignedTo = String(name || '').trim().slice(0, 80) || null;
  await db.updateJob(job.id, { assigned_to: assignedTo });
  await db.createReview({ job_id: job.id, reviewer, action: 'assign', notes: assignedTo || 'unassigned' });
}

// Designer uploads a finished poster manually; optionally send it straight away.
async function uploadManual(jobId, file, { send, reviewer }) {
  const job = await loadJob(jobId);
  if (!file?.buffer?.length) throw new ReviewError('Choose an image file to upload');
  if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) throw new ReviewError('Upload a PNG, JPG or WebP image');
  const ext = file.mimetype.includes('png') ? 'png' : file.mimetype.includes('webp') ? 'webp' : 'jpg';
  const url = await db.uploadFile(`jobs/${job.id}/manual-${Date.now()}.${ext}`, file.buffer, file.mimetype);
  const asset = await db.createAsset({
    job_id: job.id, image_url: url, background_url: null, template: 'manual', size: job.brief?.size || null, source: 'manual',
    qa_report: { score: null, notes: `Uploaded manually by ${reviewer}`, manual: true },
  });
  await db.createReview({ job_id: job.id, asset_id: asset.id, reviewer, action: 'upload', notes: file.originalname || null });
  if (!BUSY.includes(job.status) && job.status !== 'delivered') {
    await db.updateJob(job.id, { status: 'pending_review', error: null });
  }
  if (send) await approveAndSend(job.id, asset.id, reviewer);
  return asset;
}

async function retry(jobId, reviewer) {
  const job = await loadJob(jobId);
  if (BUSY.includes(job.status)) throw new ReviewError('Already generating.');
  await db.updateJob(job.id, { status: 'brief_confirmed', error: null });
  await db.createReview({ job_id: job.id, reviewer, action: 'retry', notes: job.error ? job.error.slice(0, 300) : null });
  jobs.startJob(job.id);
}

// Demo safety: send an already-approved poster to a chosen test number (does not touch the job).
// target: a phone number (WhatsApp / web demo) or { telegramCustomerId } for a Telegram chat.
async function sendTestPoster(assetId, target, reviewer) {
  const config = require('../config');
  let telegramCustomer = null;
  let phone = '';
  if (target && typeof target === 'object' && target.telegramCustomerId) {
    if (!config.telegram.enabled) throw new ReviewError('Telegram is not enabled (TELEGRAM_ENABLED=false)');
    telegramCustomer = await db.getCustomer(target.telegramCustomerId);
    if (!telegramCustomer || telegramCustomer.channel !== 'telegram') throw new ReviewError('Choose a Telegram customer');
  } else {
    phone = String(target || '').replace(/\D/g, '');
    if (phone.length < 8 || phone.length > 15) throw new ReviewError('Enter the test number with country code, digits only (e.g. 919876543210)');
    if (config.demo.testNumbers.length && !config.demo.testNumbers.includes(phone)) {
      throw new ReviewError('That number is not in DEMO_TEST_NUMBERS');
    }
  }
  const asset = await db.getAsset(assetId);
  if (!asset) throw new ReviewError('Choose a poster');
  const job = await loadJob(asset.job_id);
  const approved = job.delivered_asset_id === asset.id
    || (await db.listReviews(job.id)).some((r) => r.asset_id === asset.id && ['approve', 'upload', 'demo_send'].includes(r.action));
  if (!approved) throw new ReviewError('Only approved/delivered posters can be sent as a test');

  let customer;
  if (telegramCustomer) {
    customer = telegramCustomer; // delivered with sendPhoto + sendDocument
  } else if (!config.whatsapp.enabled) {
    // Web demo mode: deliver into the /demo chat of the customer who signed in with this number.
    customer = await db.getCustomerByPhone(`web:${phone}`);
    if (!customer) throw new ReviewError('No web demo customer with that number yet - sign in at /demo with it first');
  } else {
    customer = await db.getCustomerByPhone(phone);
    if (!customer) customer = await db.createCustomer({ phone, name: 'Demo test number', simulated: false, channel: 'whatsapp' });
  }
  try {
    await outbound.sendImage(customer, asset.image_url, `Sample poster from PIXRA AI 🎨\n(${job.brief?.business_name || 'demo'} - v${asset.version})`, { jobId: job.id });
  } catch (err) {
    throw new ReviewError(`Test send failed: ${err.message}`);
  }
  await db.createReview({ job_id: job.id, asset_id: asset.id, reviewer, action: 'demo_send', notes: telegramCustomer ? `to Telegram chat ..${String(customer.phone).slice(-4)}` : `to ${phone.slice(0, 2)}XXXXXX${phone.slice(-4)}` });
  log.info(`demo: v${asset.version} sent as test poster by ${reviewer}`, { jobId: job.id, phone: customer.phone });
  return { asset, customer };
}

// Approved posters available for "Send test poster" (newest first).
async function approvedPosters(limit = 24) {
  const jobs = await db.listJobs({ limit: 300 });
  const out = [];
  for (const j of jobs) {
    if (!j.delivered_asset_id) continue;
    const a = await db.getAsset(j.delivered_asset_id);
    if (a) out.push({ asset: a, job: j });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { sendTestPoster, approvedPosters, approveAndSend, rejectAndRegenerate, editText, assign, uploadManual, retry, latestBackgrounds, ReviewError };
