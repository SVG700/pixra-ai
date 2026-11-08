'use strict';
// Admin portal (server-rendered EJS). Password login -> signed session cookie.
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../services/db');
const log = require('../logger');
const review = require('../pipeline/review');
const jobRunner = require('../pipeline/jobs');
const { getSession, setSession, clearSession, passwordMatches } = require('../lib/session');
const { createLimiter } = require('../lib/rate-limit');
const { timeLeft, formatDateTime, formatClock } = require('../lib/time');
const { FIELDS, LABELS } = require('../lib/brief');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

const STATUS_TABS = {
  active: { label: 'Active', statuses: ['brief_confirmed', 'generating', 'qa_done', 'pending_review', 'approved', 'revision_requested', 'failed'] },
  review: { label: 'Needs review', statuses: ['pending_review', 'qa_done'] },
  failed: { label: 'Failed', statuses: ['failed'] },
  delivered: { label: 'Delivered', statuses: ['delivered'] },
  all: { label: 'All', statuses: null },
};

// "+919876543210 · web demo" etc. (web demo customers are stored as web:<digits>)
function contact(c) {
  if (!c) return '-';
  if (!c.simulated && c.channel === 'telegram') return `Telegram chat ..${String(c.phone || '').slice(-4)} · Telegram`;
  const digits = String(c.phone || '').replace(/\D/g, '');
  const via = c.simulated ? 'simulated (dev)' : c.channel === 'web' ? 'web demo' : 'WhatsApp';
  return `+${digits} · ${via}`;
}
const CHANNEL_NAMES = { whatsapp: 'WhatsApp', web: 'the web demo chat', telegram: 'Telegram', dev: 'the dev chat' };
const deliveryChannel = (c) => CHANNEL_NAMES[c?.simulated ? 'dev' : c?.channel || 'whatsapp'] || 'WhatsApp';
// Short channel label for badges in lists.
const channelLabel = (c) => ({ whatsapp: 'WhatsApp', web: 'Web demo', telegram: 'Telegram', dev: 'Dev' })[c?.simulated ? 'dev' : c?.channel || 'whatsapp'];
const images = require('../services/images');

const helpers = {
  timeLeft, formatDateTime, formatClock, LABELS, FIELDS, contact, deliveryChannel, channelLabel,
  describeBackground: images.describeBackground,
};

// Every portal page (incl. login) knows whether WhatsApp is connected, for the banner.
router.use((req, res, next) => {
  res.locals.whatsappEnabled = config.whatsapp.enabled;
  res.locals.telegramEnabled = config.telegram.enabled;
  next();
});

// ------------------------------------------------------------------ login (rate limited per IP)
// ADMIN_LOGIN_MAX_ATTEMPTS failed attempts (default 5) per 15 minutes; a successful login resets the count.
const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: () => config.limits.loginAttempts });

router.get('/login', (req, res) => {
  if (getSession(req)) return res.redirect('/admin');
  res.render('admin/login', { error: req.query.err || null, configured: !!config.admin.password });
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (loginLimiter.peek(ip)) {
    log.warn('admin login blocked by rate limit', { ip });
    return res.status(429).render('admin/login', { error: 'Too many attempts. Try again in 15 minutes.', configured: true });
  }
  if (!passwordMatches(req.body?.password)) {
    loginLimiter.hit(ip);
    log.warn('admin login failed', { ip });
    return res.redirect('/admin/login?err=Wrong+password');
  }
  loginLimiter.reset(ip);
  const name = String(req.body?.name || '').trim().slice(0, 40) || 'admin';
  setSession(req, res, { name });
  log.info(`admin login: ${name}`);
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.redirect('/admin/login');
});

// ------------------------------------------------------------------ everything below requires login
router.use((req, res, next) => {
  const session = getSession(req);
  if (!session) return res.redirect('/admin/login');
  res.locals.admin = session;
  res.locals.h = helpers;
  next();
});

router.get('/', async (req, res) => {
  const tab = STATUS_TABS[req.query.tab] ? req.query.tab : 'active';
  const jobs = await db.listJobs({ statuses: STATUS_TABS[tab].statuses, limit: 200 });
  if (tab === 'active' || tab === 'review') jobs.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const customers = await db.getCustomers([...new Set(jobs.map((j) => j.customer_id))]);
  const byId = Object.fromEntries(customers.map((c) => [c.id, c]));
  const counts = {};
  for (const j of await db.listJobs({ limit: 1000 })) counts[j.status] = (counts[j.status] || 0) + 1;
  res.render('admin/jobs', {
    tab, tabs: STATUS_TABS, counts,
    jobs: jobs.map((j) => ({ ...j, customer: byId[j.customer_id], activity: jobRunner.jobActivity(j.id) })),
  });
});

// ------------------------------------------------------------------ demo: send an approved poster to a test number
router.get('/demo', async (req, res) => {
  res.render('admin/demo', {
    posters: await review.approvedPosters(),
    defaultPhone: config.demo.testNumbers[0] || '',
    allowList: config.demo.testNumbers,
    telegramEnabled: config.telegram.enabled,
    telegramCustomers: config.telegram.enabled ? await db.listCustomers({ channel: 'telegram', limit: 50 }) : [],
    ok: req.query.ok || null, err: req.query.err || null, selected: req.query.asset || null,
  });
});

router.post('/demo/send', async (req, res) => {
  try {
    const target = req.body.telegram_customer ? { telegramCustomerId: req.body.telegram_customer } : req.body.phone;
    const { asset } = await review.sendTestPoster(req.body.asset_id, target, res.locals.admin.name);
    res.redirect(`/admin/demo?ok=${encodeURIComponent(`Test poster v${asset.version} sent ✔`)}&asset=${asset.id}`);
  } catch (err) {
    if (!(err instanceof review.ReviewError)) log.error('demo send failed', { err });
    res.redirect(`/admin/demo?err=${encodeURIComponent(err.message)}&asset=${encodeURIComponent(req.body.asset_id || '')}`);
  }
});

router.get('/jobs/:id', async (req, res) => {
  const job = await db.getJob(req.params.id);
  if (!job) return res.status(404).render('admin/notfound');
  const [customer, assets, reviews] = await Promise.all([db.getCustomer(job.customer_id), db.listAssets(job.id), db.listReviews(job.id)]);
  const messages = await db.listMessages(job.customer_id, { limit: 300 });
  res.render('admin/job', {
    job, customer, assets: [...assets].reverse(), reviews, messages, activity: jobRunner.jobActivity(job.id),
    imageProvider: config.images.provider, hfState: images.hfStatus().state,
    ok: req.query.ok || null, err: req.query.err || null,
  });
});

// ------------------------------------------------------------------ actions
function action(fn) {
  return async (req, res) => {
    const back = `/admin/jobs/${encodeURIComponent(req.params.id)}`;
    try {
      const msg = await fn(req, res.locals.admin.name);
      res.redirect(`${back}?ok=${encodeURIComponent(msg)}`);
    } catch (err) {
      if (!(err instanceof review.ReviewError)) log.error('admin action failed', { jobId: req.params.id, err });
      res.redirect(`${back}?err=${encodeURIComponent(err.message)}`);
    }
  };
}

router.post('/jobs/:id/approve', action(async (req, who) => {
  const { customer } = await review.approveAndSend(req.params.id, req.body.asset_id, who);
  return `Poster sent to the customer via ${deliveryChannel(customer)} ✔`;
}));

router.post('/jobs/:id/regenerate', action(async (req, who) => {
  await review.rejectAndRegenerate(req.params.id, req.body.note, who, req.body.provider);
  return 'Regenerating new options with your note…';
}));

router.post('/jobs/:id/edit-text', action(async (req, who) => {
  const changed = await review.editText(req.params.id, req.body, who, { fromAssetId: req.body.from_asset_id || null });
  return changed.length ? `Re-rendering with new ${changed.join(', ')}…` : 'Re-rendering…';
}));

router.post('/jobs/:id/assign', action(async (req, who) => {
  await review.assign(req.params.id, req.body.assigned_to, who);
  return 'Assignment saved';
}));

router.post('/jobs/:id/upload', upload.single('poster'), action(async (req, who) => {
  const send = req.body.send === 'on' || req.body.send === '1';
  const asset = await review.uploadManual(req.params.id, req.file, { send, reviewer: who });
  return send ? `Uploaded v${asset.version} and sent to the customer ✔` : `Uploaded as v${asset.version}`;
}));

router.post('/jobs/:id/retry', action(async (req, who) => {
  await review.retry(req.params.id, who);
  return 'Retrying generation…';
}));

// Multer errors (file too large etc.) -> back to the job page with a message
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && req.params?.id) {
    return res.redirect(`/admin/jobs/${encodeURIComponent(req.params.id)}?err=${encodeURIComponent(`Upload failed: ${err.message}`)}`);
  }
  return next(err);
});

module.exports = router;
