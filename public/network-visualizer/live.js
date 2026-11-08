// Live data: topology + status over fetch, system events over Server-Sent Events.
// Demo mode is a separate, clearly marked generator: sample events along the REAL workflow path
// of this codebase (routed over actual graph edges), every event tagged demo: true.

const API = '/network-visualizer';

export async function fetchJSON(path) {
  const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (res.status === 401) throw new Error('Not logged in - open /admin and log in first.');
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** SSE subscription with reconnect and cleanup. Returns { close }. */
export function subscribe({ onHello, onEvent, onStatus, onTopology, onState }) {
  let es = null;
  let closed = false;
  let retry = 1000;
  let timer = null;
  const open = () => {
    if (closed) return;
    onState('connecting');
    es = new EventSource(`${API}/events`);
    es.addEventListener('open', () => { retry = 1000; onState('live'); });
    es.addEventListener('hello', (e) => onHello(JSON.parse(e.data)));
    es.addEventListener('event', (e) => onEvent(JSON.parse(e.data)));
    es.addEventListener('status', (e) => onStatus(JSON.parse(e.data)));
    es.addEventListener('topology', (e) => onTopology(JSON.parse(e.data)));
    es.addEventListener('error', () => {
      onState('offline');
      es.close();
      if (!closed) timer = setTimeout(open, retry);
      retry = Math.min(15000, retry * 2);
    });
  };
  open();
  const onVis = () => { if (document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED) { clearTimeout(timer); open(); } };
  document.addEventListener('visibilitychange', onVis);
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      es?.close();
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

// The customer workflow as implemented: each segment is routed over real edges (directed first).
const DEMO_FLOW = [
  { label: 'Customer message arrives', via: ['ext:meta-whatsapp', 'route:POST /webhook', 'file:src/pipeline/inbound.js', 'file:src/pipeline/conversation.js'] },
  { label: 'Gemini reads the brief', via: ['file:src/pipeline/conversation.js', 'file:src/services/gemini/index.js', 'ext:google-gemini'] },
  { label: 'Job created', via: ['file:src/pipeline/conversation.js', 'table:jobs', 'status:brief_confirmed'] },
  { label: 'Image prompt', via: ['file:src/pipeline/jobs.js', 'file:src/services/gemini/index.js', 'ext:google-gemini'] },
  { label: 'Poster backgrounds', via: ['file:src/pipeline/jobs.js', 'file:src/services/images/index.js', 'ext:cloudflare'] },
  { label: 'Poster composed', via: ['file:src/pipeline/jobs.js', 'file:src/services/poster/index.js'] },
  { label: 'Saved to storage', via: ['file:src/pipeline/jobs.js', 'storage:posters'] },
  { label: 'Waiting for admin', via: ['file:src/pipeline/jobs.js', 'status:pending_review'] },
  { label: 'Admin approves', via: ['client:browser', 'route:POST /admin/jobs/:id/approve', 'file:src/pipeline/review.js', 'file:src/pipeline/outbound.js'] },
  { label: 'Delivered on WhatsApp', via: ['file:src/pipeline/outbound.js', 'file:src/services/whatsapp/index.js', 'ext:meta-whatsapp'] },
];

/** Hops [a, b] for the demo flow, routed through the store's graph. Skips waypoints that don't exist. */
export function demoHops(store) {
  const hops = [];
  for (const seg of DEMO_FLOW) {
    const via = seg.via.filter((id) => store.byId.has(id));
    for (let i = 0; i + 1 < via.length; i++) {
      const p = store.shortestPath(via[i], via[i + 1], { directed: true, flow: true })
        || store.shortestPath(via[i], via[i + 1], { flow: true });
      const ids = p ? p.nodes : [via[i], via[i + 1]];
      for (let j = 0; j + 1 < ids.length; j++) hops.push({ source: ids[j], target: ids[j + 1], step: seg.label });
    }
  }
  return hops;
}

export function createDemo(store, emit) {
  let timer = null;
  let n = 0;
  const run = () => {
    const hops = demoHops(store);
    let i = 0;
    const job = Math.random().toString(16).slice(2, 10);
    const next = () => {
      if (!timer) return;
      if (i >= hops.length) { timer = setTimeout(run, 2600); return; }
      const h = hops[i++];
      emit({
        id: `demo-${++n}`, source: h.source, target: h.target, eventType: 'demo.flow', status: 'ok',
        detail: h.step, ms: null, jobId: job, timestamp: new Date().toISOString(), demo: true,
      });
      timer = setTimeout(next, 520);
    };
    next();
  };
  return {
    start() { if (!timer) { timer = setTimeout(() => {}, 0); run(); } },
    stop() { clearTimeout(timer); timer = null; },
    get on() { return !!timer; },
  };
}
