'use strict';
// db service: Supabase (real) or local JSON file + /uploads folder (mock). Same interface.
// The local JSON store is used ONLY when MOCK_MODE=true outside production - never as a silent
// fallback (Render's free disk is wiped on every restart). server.js exits if Supabase is missing.
const config = require('../../config');
const log = require('../../logger');
const { select, modes, unconfigured } = require('../select');
const { requiresRealDb } = require('../../lib/startup-checks');
const { instrument } = require('../../lib/telemetry');

const required = { SUPABASE_URL: config.supabase.url, SUPABASE_SERVICE_ROLE_KEY: config.supabase.serviceRoleKey };
const real = () => require('./supabase').createSupabaseDb(config.supabase);

if (requiresRealDb()) {
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    modes.db = 'missing';
    log.error(`db: missing ${missing.join(', ')} - Supabase is required (MOCK_MODE=false or production); no local fallback`);
    module.exports = unconfigured('db', missing);
  } else {
    modes.db = 'real';
    module.exports = instrument('db', real());
  }
} else {
  module.exports = select('db', {
    required,
    real,
    mock: () => require('./local-json').createLocalDb({ dataDir: config.dataDir, uploadsDir: config.uploadsDir }),
  });
}
