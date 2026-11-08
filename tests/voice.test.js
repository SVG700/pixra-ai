'use strict';
const { startApp } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const db = require('../src/services/db');
const cloudflare = require('../src/services/cloudflare');
const { convertToWav, ffmpegPath } = require('../src/lib/audio');

const OGG = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-voice.ogg')); // real OGG/Opus, like WhatsApp

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

async function sendVoice(phone, audio, mime = 'audio/ogg; codecs=opus') {
  await fetch(`${app.base}/dev/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, audio_base64: audio.toString('base64'), mime }),
  });
  const c = await db.getCustomerByPhone(phone);
  const msgs = await db.listMessages(c.id);
  return { inbound: msgs.find((m) => m.direction === 'in'), reply: msgs.filter((m) => m.direction === 'out').at(-1) };
}

test('bundled ffmpeg is available', () => {
  assert.ok(ffmpegPath(), 'ffmpeg-static binary missing');
});

test('OGG/Opus voice note converts to 16 kHz mono WAV', async () => {
  assert.equal(OGG.subarray(0, 4).toString(), 'OggS');
  const wav = await convertToWav(OGG);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 16000, '16 kHz');
  assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF size header is correct');
  assert.ok(wav.length > 60000, `2s of 16-bit 16kHz audio ~64KB, got ${wav.length}`);
});

test('if Whisper rejects the OGG, the WAV conversion is retried once and succeeds', async (t) => {
  const calls = [];
  t.mock.method(cloudflare, 'transcribe', async (buf, mime) => {
    calls.push(mime);
    if (buf.subarray(0, 4).toString() === 'OggS') throw new Error('whisper: HTTP 400 could not decode audio');
    assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
    return 'I need a poster for my bakery';
  });
  const { inbound, reply } = await sendVoice('919900000701', OGG);
  assert.deepEqual(calls, ['audio/ogg; codecs=opus', 'audio/wav']);
  assert.equal(inbound.type, 'audio');
  assert.equal(inbound.content, 'I need a poster for my bakery');
  assert.doesNotMatch(reply.content, /couldn't understand/);
});

test('an empty transcript also triggers the WAV retry', async (t) => {
  let n = 0;
  t.mock.method(cloudflare, 'transcribe', async () => (++n === 1 ? '' : 'hello there'));
  const { inbound } = await sendVoice('919900000702', OGG);
  assert.equal(n, 2);
  assert.equal(inbound.content, 'hello there');
});

test('if transcription still fails, the customer is politely asked to type', async (t) => {
  let n = 0;
  t.mock.method(cloudflare, 'transcribe', async () => { n++; throw new Error('Workers AI unavailable'); });
  const { reply } = await sendVoice('919900000703', OGG);
  assert.equal(n, 2, 'original + one retry, no more');
  assert.match(reply.content, /couldn't understand that voice note.*type your message/s);
});

test('undecodable audio: conversion fails cleanly and the customer gets the polite reply', async (t) => {
  t.mock.method(cloudflare, 'transcribe', async () => { throw new Error('bad audio'); });
  const { reply } = await sendVoice('919900000704', Buffer.from('definitely not audio data'));
  assert.match(reply.content, /type your message/);
});
