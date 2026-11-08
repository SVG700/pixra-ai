'use strict';
// Builds the Express app (no listen) so tests can mount it on a random port.
const path = require('path');
const express = require('express');
const config = require('./config');
const log = require('./logger');
const telemetry = require('./lib/telemetry');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render / cloudflared sit in front of us
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');
  app.locals.devMode = config.devMode;

  // Live events for /network-visualizer (in-flight count + one event per routed request).
  app.use(telemetry.requestTracker({ skip: (req) => req.path.startsWith('/network-visualizer') || req.path.startsWith('/uploads') }));

  // Webhook first: it parses its own RAW body for signature verification.
  app.use(require('./routes/webhook'));

  app.use(express.json({ limit: '15mb' })); // base64 uploads from the dev simulator
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Local mock storage (only populated when Supabase is mocked).
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1h', fallthrough: true }));

  app.use(require('./routes/health'));
  app.use(require('./routes/network')); // /network-visualizer architecture explorer
  app.use('/admin', require('./routes/admin'));
  app.use('/demo', require('./routes/demo')); // customer web chat (web demo mode); needs DEMO_PASSWORD
  app.use(require('./routes/telegram')); // POST /telegram/webhook (503 unless TELEGRAM_ENABLED=true)
  // Always mounted; the router itself returns 404 for everything unless DEV_MODE=true.
  app.use('/dev', require('./routes/dev'));
  if (config.devMode && !config.isProduction) log.info('DEV_MODE: simulator enabled at /dev/chat');

  app.get('/', (_req, res) => res.redirect('/admin'));

  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error(`unhandled error on ${req.method} ${req.path}`, { err });
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal error' });
  });
  return app;
}

module.exports = { createApp };
