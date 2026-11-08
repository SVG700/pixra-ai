'use strict';
// Live system events for the /network-visualizer page. In memory only (last 300 events).
// Events are recorded where work really happens: inbound HTTP requests (app.js), every call into a
// service (gemini, whatsapp, telegram, cloudflare, db, ...: see instrument()), outbound HTTP calls
// to external APIs (lib/http.js) and job status changes. Never records secrets, message text,
// URLs (Telegram URLs contain the bot token) or phone numbers - only node ids, names and status.
const path = require('path');
const { EventEmitter } = require('events');

const SRC = path.resolve(__dirname, '..');
const ROOT = path.resolve(SRC, '..');
const MAX_EVENTS = 300;

const bus = new EventEmitter();
bus.setMaxListeners(50);
const buffer = [];
let seq = 0;
let active = 0;
let lastEventAt = null;
// host -> { ok, status, at } for the last real call to each external API (proves connectivity)
const external = {};

// Known external API hosts -> topology node id (see lib/topology.js)
const HOSTS = [
  [/generativelanguage\.googleapis\.com$/, 'ext:google-gemini'],
  [/api\.cloudflare\.com$/, 'ext:cloudflare'],
  [/graph\.facebook\.com$|lookaside\.fbsbx\.com$|whatsapp\.net$/, 'ext:meta-whatsapp'],
  [/api\.telegram\.org$/, 'ext:telegram'],
  [/huggingface\.co$|hf\.co$/, 'ext:huggingface'],
  [/supabase\.co$|supabase\.in$/, 'ext:supabase'],
];
const hostNode = (host) => (HOSTS.find(([re]) => re.test(host)) || [null, null])[1];

/** Topology node id for a source file: file:src/pipeline/jobs.js */
const fileId = (abs) => `file:${path.relative(ROOT, abs).split(path.sep).join('/')}`;

// Files that only forward calls; the caller is the first frame outside them.
const PASS_THROUGH = ['lib/telemetry.js', 'lib/http.js', 'services/select.js', 'services/db/index.js', 'lib/job-context.js']
  .map((p) => path.join(SRC, p));

/** The src/ module that made the current call, from the stack (async frames included). */
function callerFile() {
  const stack = new Error().stack.split('\n').slice(2);
  for (const line of stack) {
    const m = line.match(/\(?((?:[A-Za-z]:)?[^():]+\.js):\d+:\d+\)?$/);
    if (!m) continue;
    const file = path.resolve(m[1]);
    if (!file.startsWith(SRC) || PASS_THROUGH.includes(file)) continue;
    return fileId(file);
  }
  return null;
}

/**
 * Records one event. source/target are topology node ids.
 * status: ok | error | pending | info. Returns the stored event.
 */
function record({ source, target, eventType, status = 'ok', detail = '', ms = null, jobId = null }) {
  if (!source || !target || source === target) return null;
  const ev = {
    id: `${Date.now().toString(36)}-${(++seq).toString(36)}`,
    source, target, eventType, status,
    detail: String(detail).slice(0, 160),
    ms: ms == null ? null : Math.round(ms),
    jobId: jobId ? String(jobId).slice(0, 8) : null,
    timestamp: new Date().toISOString(),
  };
  buffer.push(ev);
  if (buffer.length > MAX_EVENTS) buffer.shift();
  lastEventAt = ev.timestamp;
  bus.emit('event', ev);
  return ev;
}

const recent = (n = 100) => buffer.slice(-n);

// Job status written by db.createJob / db.updateJob -> workflow node "status:<name>"
function jobStatusOf(method, args) {
  if (method === 'createJob') return args[0]?.status || null;
  if (method === 'updateJob') return args[1]?.status || null;
  return null;
}

/**
 * Wraps a service object so every method call becomes an event caller -> service node.
 * Same object otherwise: properties, `kind`, assignment (tests) and `this` all pass through.
 */
function instrument(name, impl, { nodeId = `file:src/services/${name}/index.js` } = {}) {
  if (!impl || typeof impl !== 'object') return impl;
  const wrapped = new WeakMap();
  return new Proxy(impl, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || prop === 'then' || prop === 'constructor' || typeof prop === 'symbol') return value;
      if (wrapped.has(value)) return wrapped.get(value);
      const fn = function instrumented(...args) {
        const source = callerFile() || 'file:src/app.js';
        const started = Date.now();
        const mode = target.kind || 'real';
        const done = (status, err) => {
          const ev = record({
            source, target: nodeId, eventType: `${name}.${String(prop)}`, status, ms: Date.now() - started,
            detail: `${String(prop)}() via ${mode}${err ? ` - failed: ${String(err.message || err).slice(0, 80)}` : ''}`,
            jobId: require('./job-context').currentJobId(),
          });
          const jobStatus = status === 'ok' && name === 'db' && jobStatusOf(String(prop), args);
          if (ev && jobStatus) record({ source: 'table:jobs', target: `status:${jobStatus}`, eventType: 'job.status', detail: `job -> ${jobStatus}`, jobId: ev.jobId });
        };
        let out;
        try {
          out = value.apply(this === receiver || this === undefined ? target : this, args);
        } catch (err) {
          done('error', err);
          throw err;
        }
        if (out && typeof out.then === 'function') {
          return out.then((v) => { done('ok'); return v; }, (err) => { done('error', err); throw err; });
        }
        done('ok');
        return out;
      };
      wrapped.set(value, fn);
      return fn;
    },
  });
}

/** Called by lib/http.js after each outbound request (host only - never the URL). */
function externalCall(url, { status = 0, ok = false, ms = 0, label = 'http' } = {}) {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const target = hostNode(host);
  if (!target) return;
  external[target] = { ok, status, at: new Date().toISOString() };
  record({
    source: callerFile() || 'file:src/lib/http.js',
    target,
    eventType: 'http.external',
    status: ok ? 'ok' : 'error',
    ms,
    detail: `${String(label).replace(/bot\d+:[\w-]+/g, 'bot[redacted]').slice(0, 60)} -> ${host} ${status ? `HTTP ${status}` : 'network error'}`,
    jobId: require('./job-context').currentJobId(),
  });
}

/** Express middleware: counts in-flight requests and records each one against its route node. */
function requestTracker({ skip = () => false } = {}) {
  return (req, res, next) => {
    if (skip(req)) return next();
    active++;
    const started = Date.now();
    let closed = false;
    const end = () => {
      if (closed) return;
      closed = true;
      active--;
      if (!req.route) return; // 404s and static files are not routes
      const routePath = `${req.baseUrl || ''}${req.route.path === '/' && req.baseUrl ? '' : req.route.path}` || '/';
      const p = req.path || '';
      const source = p.startsWith('/webhook') ? 'ext:meta-whatsapp' : p.startsWith('/telegram') ? 'ext:telegram' : 'client:browser';
      record({
        source,
        target: `route:${req.method} ${routePath}`,
        eventType: 'http.request',
        status: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'info' : 'ok',
        ms: Date.now() - started,
        detail: `${req.method} ${routePath} -> ${res.statusCode}`,
      });
    };
    res.on('finish', end);
    res.on('close', end);
    next();
  };
}

module.exports = {
  bus, record, recent, instrument, externalCall, requestTracker, callerFile, hostNode,
  activeRequests: () => active,
  lastEventAt: () => lastEventAt,
  externalStatus: () => ({ ...external }),
};
