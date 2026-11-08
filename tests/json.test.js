'use strict';
require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonLoose } = require('../src/lib/json');
const { createGemini } = require('../src/services/gemini/gemini');

test('parses plain JSON', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
});

test('parses JSON inside ```json fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('Sure! Here it is:\n```json\n{"ready": true, "x": [1,2]}\n```\nHope that helps'), { ready: true, x: [1, 2] });
  assert.deepEqual(parseJsonLoose('Result: {"q": "a } inside a string", "n": {"m": 2}} trailing'), { q: 'a } inside a string', n: { m: 2 } });
});

test('tolerates trailing commas', () => {
  assert.deepEqual(parseJsonLoose('{"a": [1, 2,], "b": 3,}'), { a: [1, 2], b: 3 });
});

test('throws on garbage', () => {
  assert.throws(() => parseJsonLoose('no json here'), /no JSON/);
  assert.throws(() => parseJsonLoose('{"a": '), /unterminated|invalid/);
  assert.throws(() => parseJsonLoose(''), /no JSON|empty/);
});

test('Gemini client retries once with a "fix your JSON" prompt', async (t) => {
  const replies = ['Sorry, here: {"fields": {"headline": "Big Sale"', '{"fields": {"headline": "Big Sale"}, "ready": false, "next_question": "Q?", "asking_for": "size"}'];
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const text = replies.shift();
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  });
  const g = createGemini({ apiKey: 'k', model: 'm' });
  const out = await g.intake({ known: {}, collected: {}, history: [], message: 'hi' });
  assert.equal(out.fields.headline, 'Big Sale');
  assert.equal(bodies.length, 2);
  const fixTurn = bodies[1].contents.at(-1).parts[0].text;
  assert.match(fixTurn, /not valid JSON/);
  assert.equal(bodies[0].generationConfig.responseMimeType, 'application/json');
});

test('Gemini client retries on HTTP 429 then succeeds', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return new Response('quota', { status: 429, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"fields": {}}' }] } }] }), { status: 200 });
  });
  const g = createGemini({ apiKey: 'k', model: 'm' });
  const start = Date.now();
  await g.intake({ known: {}, collected: {}, history: [], message: 'hi' });
  assert.equal(calls, 2);
  assert.ok(Date.now() - start < 10000);
});
