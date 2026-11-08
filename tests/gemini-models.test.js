'use strict';
require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGemini } = require('../src/services/gemini/gemini');
const { suggestFlashModels } = require('../src/services/gemini/models');

const ok = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const err = (status, message) => new Response(JSON.stringify({ error: { code: status, message } }), { status, headers: { 'retry-after': '0' } });
const modelOf = (url) => url.match(/models\/([^:]+):generateContent/)[1];

test('falls back when the primary model is not found, and keeps using the fallback', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(modelOf(url));
    return modelOf(url) === 'gemini-old-flash' ? err(404, 'models/gemini-old-flash is not found for API version v1beta') : ok('{"fields": {}}');
  });
  const g = createGemini({ apiKey: 'k', model: 'gemini-old-flash', fallbackModel: 'gemini-2.5-flash-lite' });
  await g.intake({ known: {}, collected: {}, history: [], message: 'hi' });
  assert.deepEqual(seen, ['gemini-old-flash', 'gemini-2.5-flash-lite']);
  assert.equal(g.activeModel(), 'gemini-2.5-flash-lite');
  await g.intake({ known: {}, collected: {}, history: [], message: 'hi again' });
  assert.deepEqual(seen.slice(2), ['gemini-2.5-flash-lite'], 'primary is skipped after a 404');
});

test('falls back on a 429 that persists after retries (primary stays primary)', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(modelOf(url));
    return modelOf(url) === 'gemini-2.5-flash' ? err(429, 'Resource has been exhausted (quota)') : ok('{"fields": {}}');
  });
  const g = createGemini({ apiKey: 'k', model: 'gemini-2.5-flash', fallbackModel: 'gemini-2.5-flash-lite' });
  await g.intake({ known: {}, collected: {}, history: [], message: 'hi' });
  assert.deepEqual(seen, ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], '1 try + 2 retries, then fallback');
  assert.equal(g.activeModel(), 'gemini-2.5-flash-lite', 'fallback preferred during the cooldown');
  await g.intake({ known: {}, collected: {}, history: [], message: 'again' });
  assert.equal(seen.at(-1), 'gemini-2.5-flash-lite');
  assert.equal(seen.length, 5, 'second call goes straight to the fallback, no primary retries');
});

test('after the cooldown expires the primary is tried first again', async (t) => {
  const seen = [];
  let primaryBusy = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(modelOf(url));
    return modelOf(url) === 'p-flash' && primaryBusy ? err(429, 'quota') : ok('{"fields": {}}');
  });
  const g = createGemini({ apiKey: 'k', model: 'p-flash', fallbackModel: 'f-flash-lite', cooldownMs: 50 });
  await g.intake({ known: {}, collected: {}, history: [], message: 'hi' });
  primaryBusy = false;
  await new Promise((r) => setTimeout(r, 80));
  seen.length = 0;
  await g.intake({ known: {}, collected: {}, history: [], message: 'hi' });
  assert.deepEqual(seen, ['p-flash']);
});

test('QA report names the model that actually answered (fallback after a 429)', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => (modelOf(url) === 'p-flash' ? err(429, 'quota') : ok('{"score": 8, "all_required_text_present": true, "readability_issues": [], "notes": "ok"}')));
  const g = createGemini({ apiKey: 'k', model: 'p-flash', fallbackModel: 'f-flash-lite' });
  const qa = await g.qaPoster({ image: Buffer.from('x'), brief: { headline: 'h' } });
  assert.equal(qa.model, 'f-flash-lite');
  assert.equal(qa.score, 8);
});

test('falls back when the primary stays overloaded (HTTP 503 "high demand") after retries', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(modelOf(url));
    return modelOf(url) === 'gemini-3.5-flash' ? err(503, 'This model is currently experiencing high demand.') : ok('{"fields": {}}');
  });
  const g = createGemini({ apiKey: 'k', model: 'gemini-3.5-flash', fallbackModel: 'gemini-3.5-flash-lite' });
  await g.intake({ known: {}, collected: {}, history: [], message: 'hi' });
  assert.equal(seen.at(-1), 'gemini-3.5-flash-lite');
  assert.equal(g.activeModel(), 'gemini-3.5-flash-lite', 'fallback preferred during the cooldown after 503');
});

test('without a fallback model, a missing model surfaces a clear error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => err(404, 'model not found'));
  const g = createGemini({ apiKey: 'k', model: 'gemini-nope' });
  await assert.rejects(g.intake({ known: {}, collected: {}, history: [], message: 'hi' }), /HTTP 404/);
});

test('other errors (e.g. 400 bad request) do not trigger the fallback', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => { seen.push(modelOf(url)); return err(400, 'Invalid JSON payload'); });
  const g = createGemini({ apiKey: 'k', model: 'a-flash', fallbackModel: 'b-flash' });
  await assert.rejects(g.intake({ known: {}, collected: {}, history: [], message: 'hi' }));
  assert.deepEqual(seen, ['a-flash']);
});

test('suggests the newest stable Flash model and a Lite fallback', () => {
  const names = [
    'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    'gemini-2.5-flash-preview-09-2025', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro',
    'gemini-3-flash-preview', 'gemini-embedding-001', 'gemini-2.0-flash-live-001',
  ];
  const s = suggestFlashModels(names);
  assert.equal(s.primary, 'gemini-2.5-flash');
  assert.equal(s.fallback, 'gemini-2.5-flash-lite');
  assert.ok(!s.flash.includes('gemini-2.5-flash-image'));
  assert.ok(!s.flash.includes('gemini-2.5-pro'));
  assert.ok(!s.flash.some((n) => /tts|live|embedding/.test(n)));
});
