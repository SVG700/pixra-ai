'use strict';
const express = require('express');
const config = require('../config');
const { modes } = require('../services/select');
const { getSelfTest } = require('../lib/self-test');

const router = express.Router();
const startedAt = new Date().toISOString();

router.get('/health', (_req, res) => {
  res.json({
    ok: true, // process is up (Render health check)
    ready: !Object.values(modes).includes('missing'), // false = some service has no keys and no mock
    startedAt,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    mockMode: config.mockMode,
    devMode: config.devMode,
    production: config.isProduction,
    services: modes,
    images: { provider: config.images.provider, fallback: config.images.fallbackEnabled, huggingface: require('../services/images').hfStatus() },
    selfTest: getSelfTest(), // canvas + fonts and ffmpeg on this machine
  });
});

module.exports = router;
