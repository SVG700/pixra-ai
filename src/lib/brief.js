'use strict';
// The poster brief checklist: field list, fallback questions, normalisation and the summary text.

const FIELDS = ['business_name', 'poster_purpose', 'headline', 'key_details', 'date_time', 'contact_or_cta', 'size', 'style_preference', 'logo'];

const LABELS = {
  business_name: 'Business',
  poster_purpose: 'Purpose',
  headline: 'Headline',
  key_details: 'Details',
  date_time: 'Date/time',
  contact_or_cta: 'Contact / CTA',
  size: 'Size',
  style_preference: 'Style',
  logo: 'Logo',
};

const QUESTIONS = {
  business_name: "What's the name of your business?",
  poster_purpose: 'What is this poster for? (e.g. a sale, an event, a new product, hiring)',
  headline: 'What should the big headline say? (max ~8 words; or say "suggest one")',
  key_details: 'What key details should be on it? (offers, prices, features, venue)',
  date_time: 'Is there a date or time to show? Reply with it, or "no" if not needed.',
  contact_or_cta: 'What contact info or call to action should we add? (phone, address, website, "Order on WhatsApp")',
  size: 'Which size? Reply *square* (for posts) or *portrait* (for status/stories and flyers).',
  style_preference: 'Any style or colours you like? (e.g. "festive red & gold", "minimal modern", or "you decide")',
  logo: 'Please send your logo as an image, or reply SKIP if you don\'t have one.',
};

const clean = (v) => (v == null ? null : String(v).trim() || null);

function normalizeSize(v) {
  const s = String(v || '').toLowerCase();
  if (!s) return null;
  if (/portrait|story|stories|status|vertical|tall|flyer|4\s*[:x]\s*5|1350/.test(s)) return 'portrait';
  if (/square|post|1\s*[:x]\s*1|1080\s*x\s*1080|feed|insta/.test(s)) return 'square';
  return null;
}

function normalizeLogo(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return null;
  if (s === 'provided') return 'provided';
  if (/^(none|no|skip|n\/?a|nope|don'?t have|no logo)/.test(s)) return 'none';
  return null;
}

// Merges model/rule output into the collected fields, normalising known enums.
function mergeFields(collected, incoming = {}) {
  const out = { ...collected };
  for (const f of FIELDS) {
    if (!(f in incoming)) continue;
    let v = clean(incoming[f]);
    if (v == null) continue; // never erase a value with null
    if (f === 'size') v = normalizeSize(v);
    if (f === 'logo') v = normalizeLogo(v);
    if (v != null) out[f] = v;
  }
  return out;
}

const missingFields = (c) => FIELDS.filter((f) => !clean(c[f]));

function toBrief(collected, customer) {
  const brief = {};
  for (const f of FIELDS) brief[f] = clean(collected[f]);
  brief.logo_url = brief.logo === 'provided' ? (collected.logo_url || customer?.logo_url || null) : null;
  brief.brand_colors = customer?.brand_colors || null;
  return brief;
}

function summaryText(collected) {
  const lines = FIELDS.filter((f) => f !== 'logo').map((f) => `• *${LABELS[f]}:* ${clean(collected[f]) || '-'}`);
  lines.push(`• *${LABELS.logo}:* ${collected.logo === 'provided' ? 'yes ✅' : 'none'}`);
  return `Here's your poster brief:\n\n${lines.join('\n')}\n\nReply *YES* to confirm, or tell me what to change.`;
}

const isNA = (v) => !v || /^(n\/?a|none|no|not applicable|-)$/i.test(String(v).trim());

// Text items that must appear on the poster (used by QA).
function requiredText(brief) {
  return ['business_name', 'headline', 'key_details', 'date_time', 'contact_or_cta']
    .filter((f) => !isNA(brief[f]))
    .map((f) => ({ field: f, text: String(brief[f]) }));
}

module.exports = { isNA, requiredText, FIELDS, LABELS, QUESTIONS, mergeFields, missingFields, normalizeSize, normalizeLogo, toBrief, summaryText };
