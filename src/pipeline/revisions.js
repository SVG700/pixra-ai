'use strict';
// Customer feedback after delivery. Gemini decides: happy / text change / visual change / new / unclear.
//  - text change   -> re-render the delivered poster's background with new text (fast, no AI image)
//  - visual change -> regenerate backgrounds with the customer's note added to the prompt
// Old versions are never overwritten; each revision adds new asset versions and goes back to review.
const config = require('../config');
const db = require('../services/db');
const gemini = require('../services/gemini');
const { createMockGemini } = require('../services/gemini/mock');
const outbound = require('./outbound');
const jobs = require('./jobs');
const { FIELDS, normalizeSize } = require('../lib/brief');
const { formatDue } = require('../lib/time');

const ruleBased = createMockGemini();
const LOGO_WORD_RE = /\blogo\b/i;

async function triage(brief, message, clog) {
  try {
    return await gemini.triageRevision({ brief, message });
  } catch (err) {
    clog.error('revision triage failed, using rule-based fallback', { err });
    return ruleBased.triageRevision({ brief, message });
  }
}

function applyTextChanges(brief, changes) {
  const next = { ...brief };
  const changed = [];
  for (const [f, raw] of Object.entries(changes || {})) {
    if (!FIELDS.includes(f) || f === 'logo') continue;
    let v = String(raw ?? '').trim();
    if (!v) continue;
    if (f === 'size') v = normalizeSize(v) || next.size;
    if (next[f] !== v) {
      next[f] = v;
      changed.push(f);
    }
  }
  return { brief: next, changed };
}

async function handleFeedback(customer, convo, message, clog) {
  const jobId = convo.collected_fields?.job_id;
  const job = jobId ? await db.getJob(jobId) : null;
  if (!job) return require('./conversation').startNew(customer, message, clog, '');
  const jlog = clog.child({ jobId: job.id });

  let text = message.content || '';
  let brief = { ...job.brief };
  let logoChanged = false;

  // A new logo image after delivery = "use this logo instead".
  if (message.type === 'image' && message.mediaUrl) {
    if (!text || LOGO_WORD_RE.test(text)) {
      await db.updateCustomer(customer.id, { logo_url: message.mediaUrl });
      brief = { ...brief, logo: 'provided', logo_url: message.mediaUrl };
      logoChanged = true;
      text = text || 'Use this new logo';
    }
  }

  const t = logoChanged && !text.replace(/use this new logo/i, '').trim()
    ? { kind: 'text', text_changes: {}, visual_note: null, reply: "Got your new logo - I'll put it on the poster." }
    : await triage(brief, text, jlog);
  jlog.info(`feedback triage: ${t.kind}`);

  if (t.kind === 'approve') {
    await db.saveConversation(customer.id, { state: 'idle', collected_fields: {} });
    return outbound.sendText(customer, 'Glad you like it! 🙌 Reply *NEW* anytime for another poster.', { jobId: job.id });
  }
  if (t.kind === 'new') {
    return require('./conversation').startNew(customer, { type: 'text', content: 'NEW' }, clog, '');
  }
  if (t.kind === 'unclear') {
    return outbound.sendText(customer, t.reply || 'What would you like to change - the text or the picture/colours?', { jobId: job.id });
  }

  // ---- create a revision
  const applied = applyTextChanges(brief, t.text_changes);
  brief = applied.brief;
  const deadline = new Date(Date.now() + config.business.deliveryHours * 3600 * 1000).toISOString();
  const visual = t.kind === 'visual';
  await db.updateJob(job.id, {
    status: 'revision_requested',
    brief,
    deadline,
    revision_request: visual ? (t.visual_note || text) : text,
    revision_count: (job.revision_count || 0) + 1,
    regen_note: null,
    error: null,
  });
  await db.saveConversation(customer.id, { state: 'in_production', collected_fields: { ...convo.collected_fields, job_id: job.id } });
  jlog.info(`revision #${(job.revision_count || 0) + 1} (${visual ? 'regenerate background' : 're-render text'}): ${applied.changed.join(', ') || t.visual_note || ''}`);

  const ack = `${t.reply || 'Got it ✏️'}\nYou'll get the updated poster by *${formatDue(deadline)}*.`;
  await outbound.sendText(customer, ack, { jobId: job.id });

  if (visual) {
    jobs.startJob(job.id);
  } else {
    const delivered = job.delivered_asset_id ? await db.getAsset(job.delivered_asset_id) : null;
    const from = delivered?.background_url ? [delivered] : await require('./review').latestBackgrounds(job.id);
    if (from.length) jobs.startRerender(job.id, { fromAssets: from, brief, source: 'edit' });
    else jobs.startJob(job.id); // manual upload had no background -> make new ones
  }
}

module.exports = { handleFeedback, applyTextChanges };
