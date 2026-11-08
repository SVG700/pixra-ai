'use strict';
const config = require('../../config');
const { select } = require('../select');

module.exports = select('gemini', {
  required: { GEMINI_API_KEY: config.gemini.apiKey },
  real: () => require('./gemini').createGemini(config.gemini),
  mock: () => require('./mock').createMockGemini(),
});
