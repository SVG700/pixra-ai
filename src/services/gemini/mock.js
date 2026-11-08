'use strict';
// Rule-based stand-in for Gemini. Deterministic, returns the same JSON shapes as the real one.
const { FIELDS, LABELS, QUESTIONS, mergeFields, missingFields, normalizeSize, normalizeLogo } = require('../../lib/brief');

const ALIASES = {
  'business name': 'business_name', business: 'business_name', name: 'business_name',
  purpose: 'poster_purpose', headline: 'headline', title: 'headline',
  details: 'key_details', 'key details': 'key_details', detail: 'key_details',
  date: 'date_time', time: 'date_time', 'date/time': 'date_time', 'date and time': 'date_time',
  contact: 'contact_or_cta', cta: 'contact_or_cta', phone: 'contact_or_cta',
  size: 'size', style: 'style_preference', colours: 'style_preference', colors: 'style_preference', logo: 'logo',
};
const ALIAS_RE = Object.keys(ALIASES).sort((a, b) => b.length - a.length).map((k) => k.replace('/', '\\/')).join('|');
const CHANGE_RE = new RegExp(`^(?:please\\s+)?(?:change|set|make|update)\\s+(?:the\\s+)?(${ALIAS_RE})\\s+(?:to|as|=|:)\\s*(.+)$`, 'i');
const KV_RE = new RegExp(`^(${ALIAS_RE})\\s*[:=]\\s*(.+)$`, 'i');
// Message made only of "happy" words, e.g. "Perfect, thanks!" / "looks great 👍"
const APPROVE_RE = /^(?:(?:done|thanks?|thank you|thx|ty|perfect|great|love it|loved it|awesome|amazing|excellent|good|ok(?:ay)?|nice|super|looks|all|no changes?|very|so|much|it|is|this|wow|beautiful|👍|🙏|❤️)[\s,!.]*)+$/iu;
const VISUAL_RE = /\b(background|colou?rs?|image|picture|photo|style|darker|brighter|lighter|design|look|vibe|mood|theme)\b/i;
const GREETING_RE =/^(hi+|hello+|hey+|hii+|namaste|good (morning|afternoon|evening))(\s+(there|team|all|pixra((\.|\s)?ai)?|sir|madam|ji))?[\s!.,👋]*$/i;

function interpret(field, text) {
  const t = text.trim();
  switch (field) {
    case 'size': return normalizeSize(t) || (/^(1|one|first)$/i.test(t) ? 'square' : /^(2|two|second)$/i.test(t) ? 'portrait' : null);
    case 'logo': return normalizeLogo(t);
    case 'date_time': return /^(no|nope|n\/?a|none|not needed|not applicable|skip)\b/i.test(t) ? 'N/A' : t;
    case 'style_preference': return /^(any|anything|you decide|your choice|whatever|surprise me)/i.test(t) ? 'modern and vibrant' : t;
    default: return t;
  }
}

function createMockGemini() {
  return {
    kind: 'mock',

    async intake({ collected = {}, message = '' }) {
      const text = String(message || '').trim();
      const fields = {};
      for (const f of FIELDS) fields[f] = collected[f] ?? null;
      const asking = collected._asking;
      const change = text.match(CHANGE_RE) || text.match(KV_RE);

      if (change) {
        const f = ALIASES[change[1].toLowerCase()];
        fields[f] = interpret(f, change[2]);
      } else if (asking && text) {
        let v = interpret(asking, text);
        if (asking === 'headline' && /suggest|you decide|your choice/i.test(text)) {
          v = `${fields.poster_purpose || 'Big News'} - Don't Miss It!`;
        }
        if (v != null) fields[asking] = v;
      } else if (text && !GREETING_RE.test(text) && !fields.poster_purpose) {
        fields.poster_purpose = text;
      }

      const merged = mergeFields(collected, fields);
      const missing = missingFields(merged);
      return {
        fields: Object.fromEntries(FIELDS.map((f) => [f, merged[f] ?? null])),
        ready: missing.length === 0,
        next_question: missing.length ? QUESTIONS[missing[0]] : null,
        asking_for: missing[0] || null,
      };
    },

    async writeImagePrompt({ brief, feedback }) {
      return [
        `Abstract ${brief.style_preference || 'modern'} background for a ${brief.poster_purpose || 'promotional'} poster`,
        `for ${brief.business_name || 'a small business'}, soft bokeh light, smooth gradients, calm empty areas,`,
        'high quality, professional',
        feedback ? `. Adjust: ${feedback}` : '',
      ].join(' ');
    },

    async triageRevision({ message }) {
      const text = String(message || '').trim();
      if (APPROVE_RE.test(text)) return { kind: 'approve', text_changes: {}, visual_note: null, reply: '' };
      if (/\b(new|another|different) poster\b/i.test(text)) return { kind: 'new', text_changes: {}, visual_note: null, reply: '' };
      const change = text.match(CHANGE_RE) || text.match(KV_RE);
      if (change) {
        const f = ALIASES[change[1].toLowerCase()];
        const value = interpret(f, change[2]);
        if (f === 'style_preference') return { kind: 'visual', text_changes: { style_preference: value }, visual_note: `style: ${value}`, reply: `Sure! I'll change the style to "${value}".` };
        if (f !== 'logo') return { kind: 'text', text_changes: { [f]: value }, visual_note: null, reply: `Sure! I'll change the ${LABELS[f].toLowerCase()} to "${value}".` };
      }
      if (VISUAL_RE.test(text)) return { kind: 'visual', text_changes: {}, visual_note: text, reply: "Sure! I'll update the design." };
      return { kind: 'unclear', text_changes: {}, visual_note: null, reply: 'Happy to change it! What exactly should we change - the text (e.g. "change headline to ...") or the picture/colours?' };
    },

    // Rule-based QA: our code draws all text, so the only real risk is text shortened to fit.
    async qaPoster({ truncated = [] }) {
      return {
        score: Math.max(3, 8.5 - 2 * truncated.length),
        all_required_text_present: truncated.length === 0,
        readability_issues: truncated.map((f) => `${f} was shortened with "…" to fit the layout`),
        notes: 'Mock QA (rule-based, no vision model): text drawn by code with automatic scrim.',
        model: 'mock',
      };
    },
  };
}

module.exports = { createMockGemini };
