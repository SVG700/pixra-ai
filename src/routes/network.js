'use strict';
// /network-visualizer: the live architecture explorer (force-directed graph of this codebase).
//   GET /network-visualizer                page (EJS shell + static JS in public/network-visualizer)
//   GET /network-visualizer/api/topology   graph built from the code (lib/topology.js) + live status
//   GET /network-visualizer/api/status     what is actually verified right now (no fake metrics)
//   GET /network-visualizer/events         Server-Sent Events: recorded system events (lib/telemetry.js)
// Open in local development (DEV_MODE=true outside production); otherwise needs the admin login.
const path = require('path');
const express = require('express');
const config = require('../config');
const log = require('../logger');
const { modes } = require('../services/select');
const telemetry = require('../lib/telemetry');
const { getTopology, withStatus } = require('../lib/topology');
const { getSession } = require('../lib/session');

const router = express.Router();
const BASE = '/network-visualizer';
let sseClients = 0;

function requireAccess(req, res, next) {
  if (config.devMode && !config.isProduction) return next();
  if (getSession(req)) return next();
  if (req.path.startsWith(`${BASE}/api`) || req.path === `${BASE}/events`) return res.status(401).json({ error: 'Log in to the admin portal first' });
  return res.redirect('/admin/login');
}

// ------------------------------------------------------------------ database check (cached 30 s)
let dbCheck = { kind: null, reachable: null, checkedAt: null, error: null };
let dbChecking = null;
async function checkDb() {
  if (dbCheck.checkedAt && Date.now() - Date.parse(dbCheck.checkedAt) < 30000) return dbCheck;
  if (dbChecking) return dbChecking;
  const db = require('../services/db');
  dbChecking = (async () => {
    const kind = db.kind || 'unknown';
    let reachable = null;
    let error = null;
    if (kind === 'missing') {
      reachable = false;
      error = 'not configured';
    } else {
      try {
        await Promise.race([db.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 5s')), 5000))]);
        reachable = true;
      } catch (err) {
        reachable = false;
        error = String(err.message || err).slice(0, 120);
      }
    }
    dbCheck = { kind, reachable, checkedAt: new Date().toISOString(), error };
    dbChecking = null;
    return dbCheck;
  })();
  return dbChecking;
}

async function status() {
  const db = await checkDb();
  return {
    online: true, // this response came from the running server
    checkedAt: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    mode: { mock: config.mockMode, dev: config.devMode, production: config.isProduction },
    services: { ...modes },
    images: { provider: config.images.provider },
    db,
    external: telemetry.externalStatus(),
    activeRequests: telemetry.activeRequests(),
    liveViewers: sseClients,
    lastEventAt: telemetry.lastEventAt(),
    topologyVersion: getTopology().version,
  };
}

// ------------------------------------------------------------------ static assets
const vendor = (pkg, file) => path.join(config.root, 'node_modules', pkg, 'dist', file);
const VENDOR = {
  'd3-dispatch.js': vendor('d3-dispatch', 'd3-dispatch.min.js'),
  'd3-quadtree.js': vendor('d3-quadtree', 'd3-quadtree.min.js'),
  'd3-timer.js': vendor('d3-timer', 'd3-timer.min.js'),
  'd3-force.js': vendor('d3-force', 'd3-force.min.js'),
};
router.get(`${BASE}/vendor/:file`, requireAccess, (req, res) => {
  const f = VENDOR[req.params.file];
  if (!f) return res.status(404).type('text/plain').send('Not found');
  res.set('Cache-Control', 'public, max-age=86400').sendFile(f);
});
// no-cache = always revalidate (ETag), so a deploy or local edit never runs stale ES modules
router.use(`${BASE}/assets`, requireAccess, express.static(path.join(config.root, 'public', 'network-visualizer'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

// ------------------------------------------------------------------ page + API
router.get(BASE, requireAccess, (_req, res) => res.render('network-visualizer'));

router.get(`${BASE}/api/topology`, requireAccess, async (_req, res, next) => {
  try {
    const s = await status();
    res.set('Cache-Control', 'no-store').json(withStatus(getTopology(), { modes: s.services, db: s.db, external: s.external }));
  } catch (err) {
    next(err);
  }
});

router.get(`${BASE}/api/status`, requireAccess, async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await status());
  } catch (err) {
    next(err);
  }
});

router.get(`${BASE}/events`, requireAccess, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  sseClients++;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('hello', { events: telemetry.recent(100), topologyVersion: getTopology().version });

  const onEvent = (ev) => send('event', ev);
  telemetry.bus.on('event', onEvent);
  let lastVersion = getTopology().version;
  const tick = setInterval(async () => {
    try {
      const s = await status();
      send('status', s);
      const v = getTopology().version; // rebuilt from disk every 10 s
      if (v !== lastVersion) {
        lastVersion = v;
        send('topology', { version: v });
      }
    } catch (err) {
      log.warn('network-visualizer: status tick failed', { err });
    }
  }, 5000);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(tick);
    clearInterval(ping);
    telemetry.bus.off('event', onEvent);
    sseClients--;
  });
});

module.exports = router;
