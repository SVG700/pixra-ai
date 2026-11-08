'use strict';
const { startApp, textWebhook, signedWebhook } = require('./helpers'); // sets env first
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const telemetry = require('../src/lib/telemetry');
const { build } = require('../src/lib/topology');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('topology is built from the code: routes, tables, externals, env names', () => {
  const t = build();
  const ids = new Set(t.nodes.map((n) => n.id));
  for (const id of ['route:POST /webhook', 'route:POST /admin/jobs/:id/approve', 'route:GET /network-visualizer',
    'table:jobs', 'status:pending_review', 'ext:google-gemini', 'file:src/pipeline/jobs.js', 'env:GEMINI_API_KEY']) {
    assert.ok(ids.has(id), `missing node ${id}`);
  }
  assert.ok(t.edges.some((e) => e.source === 'file:src/app.js' && e.target === 'file:src/routes/admin.js' && e.relationship === 'mounts'));
  assert.ok(t.edges.every((e) => ids.has(e.source) && ids.has(e.target)), 'no dangling edges');
  assert.equal(new Set(t.nodes.map((n) => n.id)).size, t.nodes.length, 'ids are unique');
});

test('topology never contains secret values', () => {
  const json = JSON.stringify(build());
  for (const secret of ['test-admin', 'test-session-secret-123456', 'test-app-secret', 'test-verify-token']) {
    assert.ok(!json.includes(secret), `topology leaks ${secret}`);
  }
});

test('page, topology and status endpoints answer in local dev mode', async () => {
  const page = await fetch(`${app.base}/network-visualizer`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PIXRA AI/);
  const topo = await (await fetch(`${app.base}/network-visualizer/api/topology`)).json();
  assert.ok(topo.nodes.length > 100);
  const status = await (await fetch(`${app.base}/network-visualizer/api/status`)).json();
  assert.equal(status.online, true);
  assert.equal(status.db.kind, 'local');
  assert.equal(status.services.gemini, 'mock');
  const js = await fetch(`${app.base}/network-visualizer/vendor/d3-force.js`);
  assert.equal(js.status, 200);
});

test('a real webhook request is recorded as events (request + service calls)', async () => {
  const before = telemetry.recent(300).length;
  const res = await signedWebhook(app.base, textWebhook({ id: `wamid.nv-${Date.now()}` }));
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const evs = telemetry.recent(300).slice(before);
  assert.ok(evs.some((e) => e.source === 'ext:meta-whatsapp' && e.target === 'route:POST /webhook' && e.eventType === 'http.request'));
  assert.ok(evs.some((e) => e.target === 'file:src/services/db/index.js'), 'db calls recorded');
  assert.ok(evs.every((e) => !/919800000001/.test(JSON.stringify(e))), 'no phone numbers in events');
});

test('event stream sends hello with recent events', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${app.base}/network-visualizer/events`, { signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^event: hello/);
  ctrl.abort();
});
