'use strict';
const config = require('./config');
const log = require('./logger');

process.on('unhandledRejection', (err) => log.error('unhandled promise rejection', { err }));
process.on('uncaughtException', (err) => log.error('uncaught exception', { err }));

function fatal(errors) {
  log.error('REFUSING TO START - fix these settings (see MANUAL_STEPS.md, or run `npm run doctor -- --prod`):');
  for (const e of errors) log.error(`  - ${e}`);
  process.exit(1);
}

async function main() {
  const { checkConfig, checkConnections } = require('./lib/startup-checks');
  const cfg = checkConfig();
  for (const w of cfg.warnings) log.warn(`config: ${w}`);
  if (cfg.errors.length) return fatal(cfg.errors);

  const db = require('./services/db');
  const conn = await checkConnections(db);
  if (conn.errors.length) return fatal(conn.errors);

  const { createApp } = require('./app');
  createApp().listen(config.port, () => {
    log.info(`PIXRA AI listening on http://localhost:${config.port} (MOCK_MODE=${config.mockMode}, DEV_MODE=${config.devMode}, production=${config.isProduction})`);
    require('./lib/self-test').runSelfTest().then((r) => {
      const line = `self-test: canvas ${r.canvas.ok ? `ok (${r.canvas.platform})` : `FAILED - ${r.canvas.error}`}, ffmpeg ${r.ffmpeg.ok ? `ok (${r.ffmpeg.version})` : `FAILED - ${r.ffmpeg.error}`}`;
      if (r.status === 'ok') log.info(line);
      else log.error(line);
    });
    const poller = require('./services/telegram/poller');
    if (poller.shouldPoll()) poller.startPolling();
    else if (config.telegram.enabled) log.info('telegram: webhook mode (POST /telegram/webhook) - register it with npm run telegram:set-webhook');
    require('./pipeline/jobs').resumeStuckJobs()
      .then((n) => n && log.info(`resumed ${n} stuck job(s)`))
      .catch((err) => log.error('could not resume stuck jobs', { err }));
  });
}

main().catch((err) => fatal([err.message]));
