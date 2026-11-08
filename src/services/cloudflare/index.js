'use strict';
const config = require('../../config');
const { select } = require('../select');

module.exports = select('cloudflare', {
  required: { CF_ACCOUNT_ID: config.cloudflare.accountId, CF_API_TOKEN: config.cloudflare.apiToken },
  real: () => require('./workers-ai').createWorkersAi(config.cloudflare),
  mock: () => require('./mock').createMockWorkersAi(),
});
