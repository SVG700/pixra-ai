'use strict';
// Real Gemini (Google AI Studio, free tier) via the REST generateContent endpoint.
const { fetchWithRetry, ensureOk } = require('../../lib/http');
const { parseJsonLoose } = require('../../lib/json');
const log = require('../../logger');
const P = require('./prompts');
const { requiredText } = require('../../lib/brief');

// Coerces a QA reply into the stored shape; throws if it isn't usable at all.
function normalizeQa(o) {
  if (!o || typeof o !== 'object') throw new Error('QA reply is not an object');
  const score = Number(o.score);
  if (!Number.isFinite(score)) throw new Error('QA "score" is not a number');
  return {
    score: Math.max(0, Math.min(10, Math.round(score * 10) / 10)),
    all_required_text_present: o.all_required_text_present === true || o.all_required_text_present === 'true',
    readability_issues: (Array.isArray(o.readability_issues) ? o.readability_issues : [o.readability_issues])
      .filter(Boolean).map(String).slice(0, 10),
    notes: String(o.notes || '').slice(0, 600),
  };
}

// "Model not found / not supported" -> the model name is wrong or retired.
const isModelMissing = (err) => err.status === 404
  || (err.status === 400 && /not found|is not supported|unknown model|invalid model/i.test(err.message));

const COOLDOWN_MS = 60 * 1000;

function createGemini({ apiKey, model, fallbackModel = '', apiVersion = 'v1beta', cooldownMs = COOLDOWN_MS }) {
  const urlFor = (m) => `https://generativelanguage.googleapis.com/${apiVersion}/models/${m}:generateContent`;
  const fallback = fallbackModel && fallbackModel !== model ? fallbackModel : '';
  let primaryMissing = false; // set once the primary model 404s; we then go straight to the fallback
  // After the primary stays rate-limited/overloaded, prefer the fallback for a while instead of
  // paying the primary's retry delays on every call (free-tier per-minute limits reset quickly).
  let primaryCooldownUntil = 0;

  async function callModel(m, body, label) {
    const res = await fetchWithRetry(urlFor(m), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    }, { label: `${label} [${m}]`, retries: fallback ? 2 : 4, baseDelayMs: 2000, timeoutMs: 90000 });
    await ensureOk(res, `${label} [${m}]`);
    return res.json();
  }

  // Primary model first (fallback first while the primary is cooling down); on "model not found",
  // or a 429/503 that survived retries, try the other one. Returns { data, model } (who answered).
  async function callWithFallback(body, label) {
    let order;
    if (primaryMissing && fallback) order = [fallback];
    else if (fallback && Date.now() < primaryCooldownUntil) order = [fallback, model];
    else order = [model, fallback].filter(Boolean);
    for (let i = 0; i < order.length; i++) {
      try {
        return { data: await callModel(order[i], body, label), model: order[i] };
      } catch (err) {
        const missing = isModelMissing(err);
        if (missing && order[i] === model && fallback) {
          primaryMissing = true;
          log.error(`GEMINI_MODEL "${model}" not found - using GEMINI_FALLBACK_MODEL "${fallback}" from now on (run npm run doctor)`);
        }
        const busy = err.status === 429 || err.status === 503; // 503 = "model is experiencing high demand"
        if (busy && order[i] === model && fallback) {
          primaryCooldownUntil = Date.now() + cooldownMs;
        }
        const next = order[i + 1];
        if (next && (missing || busy)) {
          const why = missing ? 'model not found' : err.status === 429 ? 'still rate-limited (429)' : 'overloaded (503)';
          log.warn(`${label}: ${why} on ${order[i]}, trying ${next === fallback ? 'fallback' : 'primary'} ${next}${order[i] === model && busy ? ` (fallback preferred for ${Math.round(cooldownMs / 1000)}s)` : ''}`);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label}: no Gemini model configured`);
  }

  async function generate({ system, contents, json = true, temperature = 0.4, label = 'gemini', onModel }) {
    const body = {
      contents,
      generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const { data, model: answeredBy } = await callWithFallback(body, label);
    if (onModel) onModel(answeredBy);
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) {
      const reason = cand?.finishReason || data.promptFeedback?.blockReason || 'no content';
      throw new Error(`${label}: empty response (${reason})`);
    }
    return text;
  }

  // Asks for JSON; on parse/validation failure, retries once with a "fix your JSON" turn.
  async function generateJson({ system, parts, label, validate = (x) => x, temperature, onModel }) {
    const contents = [{ role: 'user', parts }];
    const first = await generate({ system, contents, label, temperature, onModel });
    try {
      return validate(parseJsonLoose(first));
    } catch (err) {
      log.warn(`${label}: bad JSON (${err.message}), asking Gemini to fix it`);
      const second = await generate({
        system,
        label: `${label} (fix)`,
        temperature: 0,
        onModel,
        contents: [...contents, { role: 'model', parts: [{ text: first }] }, { role: 'user', parts: [{ text: P.FIX_JSON(err.message) }] }],
      });
      return validate(parseJsonLoose(second));
    }
  }

  return {
    kind: 'gemini',
    generate,
    generateJson,
    activeModel: () => (fallback && (primaryMissing || Date.now() < primaryCooldownUntil) ? fallback : model),

    async writeImagePrompt({ brief, feedback }) {
      const out = await generateJson({
        system: P.IMAGE_PROMPT_SYSTEM,
        parts: [{ text: P.imagePromptUser({ brief, feedback }) }],
        label: 'gemini image prompt',
        temperature: 0.8,
        validate: (o) => {
          if (!o || typeof o.prompt !== 'string' || o.prompt.trim().length < 10) throw new Error('missing "prompt" string');
          return o;
        },
      });
      return out.prompt.trim();
    },

    triageRevision: ({ brief, message }) => generateJson({
      system: P.REVISION_SYSTEM,
      parts: [{ text: P.revisionUser({ brief, message }) }],
      label: 'gemini revision',
      temperature: 0.2,
      validate: (o) => {
        if (!o || !['approve', 'text', 'visual', 'new', 'unclear'].includes(o.kind)) throw new Error('invalid "kind"');
        return { kind: o.kind, text_changes: o.text_changes && typeof o.text_changes === 'object' ? o.text_changes : {}, visual_note: o.visual_note || null, reply: String(o.reply || '') };
      },
    }),

    async qaPoster({ image, mimeType = 'image/jpeg', brief, truncated = [] }) {
      let answeredBy = model;
      const out = await generateJson({
        onModel: (m) => { answeredBy = m; },
        system: P.QA_SYSTEM,
        parts: [
          { text: P.qaUser({ brief, required: requiredText(brief), truncated }) },
          { inlineData: { mimeType, data: image.toString('base64') } },
        ],
        label: 'gemini qa',
        temperature: 0.2,
        validate: normalizeQa,
      });
      return { ...out, model: answeredBy }; // the model that actually answered (primary or fallback)
    },

    intake: (input) => generateJson({
      system: P.INTAKE_SYSTEM,
      parts: [{ text: P.intakeUser(input) }],
      label: 'gemini intake',
      validate: (o) => {
        if (!o || typeof o !== 'object' || typeof o.fields !== 'object' || o.fields === null) throw new Error('missing "fields" object');
        return o;
      },
    }),
  };
}

module.exports = { createGemini, normalizeQa };
