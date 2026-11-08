'use strict';
// Mock Cloudflare Workers AI: fixed transcript for voice notes, gradient PNG/JPEG for images.
const MOCK_TRANSCRIPT = process.env.MOCK_TRANSCRIPT
  || 'Hi, I need a poster for the weekend offer at my cafe, buy one get one free on all coffees.';

function createMockWorkersAi() {
  let n = 0;
  return {
    kind: 'mock',
    async transcribe() {
      return MOCK_TRANSCRIPT;
    },
    async generateImage(prompt) {
      const { mockBackground } = require('../poster/mock-background');
      return mockBackground(prompt, { seed: n++ });
    },
  };
}

module.exports = { createMockWorkersAi, MOCK_TRANSCRIPT };
