// Canvas renderer + d3-force simulation + camera + pointer interaction + minimap.
// Reads the store, never changes topology. Emits 'select', 'trace', 'edge', 'hover', 'background', 'cluster'.
/* global d3 */
import { EDGE_TYPES, edgeType } from './store.js';

const TAU = Math.PI * 2;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Where each cluster settles: the app core in the middle, the request flow around it,
// wiring (config / packages / tests) on an outer ring. Positions are relative (scaled at runtime).
const RING1 = ['whatsapp', 'telegram', 'entry', 'api', 'auth', 'admin', 'frontend', 'workflow', 'output', 'processing', 'ai', 'external', 'storage', 'database'];
const RING2 = ['config', 'packages', 'tests'];

// Architectural importance -> node size (radius in world units before the size slider)
export const TIERS = {
  xl: { r: 15, label: 'Main application / backend core' },
  lg: { r: 10.5, label: 'Database, storage, external services' },
  md: { r: 7, label: 'API routes, services, processing' },
  sm: { r: 4.6, label: 'Files, views, config, packages' },
  xs: { r: 3.2, label: 'Tests & scripts (subdued)' },
};
export function tierOf(n) {
  if (n.kind === 'cluster') return 'cluster';
  const p = n.metadata?.path || '';
  if (/^src\/(server|app|config)\.js$/.test(p) || p === 'src/services/db/index.js' || p === 'src/pipeline/jobs.js') return 'xl';
  if (['external', 'table', 'bucket'].includes(n.kind) || /^src\/services\/\w+\/index\.js$/.test(p)) return 'lg';
  if (n.category === 'tests') return 'xs';
  if (n.kind === 'route' || n.kind === 'model' || /^src\/(pipeline|routes)\//.test(p) || n.kind === 'job-status') return 'md';
  return 'sm';
}

export function createRenderer(canvas, store, { minimap = null } = {}) {
  const ctx = canvas.getContext('2d');
  const mctx = minimap?.getContext('2d');
  const listeners = {};
  const emit = (name, ...a) => (listeners[name] || []).forEach((fn) => fn(...a));

  const opt = {
    labels: 'smart', links: true, arrows: true, hulls: true, highlightActive: true, nodeSize: 1, linkOpacity: 0.28, anim: 0.5,
    eyes: false, holo: true, focus: false, reflex: true,
    repel: 170, linkDistance: 62, collide: 6, gravity: 0.05,
  };
  const sel = { ids: new Set(), primary: null, edge: null, path: null, search: new Set(), highlight: null, hover: null, cluster: null };
  const cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 };
  let W = 0;
  let H = 0;
  let dpr = 1;
  let lastUserInput = 0;
  const particles = []; // real or demo event pulses only
  const edgeGlow = new Map(); // link id -> { t, color } for recently active connections
  let hullLabels = []; // screen boxes of cluster labels (clickable)
  let anchors = {};

  // ---------------------------------------------------------------- simulation
  const radius = (n) => {
    if (n.kind === 'cluster') return (9 + Math.sqrt(n.members || 1) * 3.2) * opt.nodeSize;
    const t = TIERS[tierOf(n)];
    return t.r * (1 + Math.min(0.5, Math.sqrt(n.degree || 0) * 0.04)) * opt.nodeSize;
  };
  const sim = d3.forceSimulation()
    .force('link', d3.forceLink().id((n) => n.id))
    .force('charge', d3.forceManyBody().theta(0.85))
    .force('collide', d3.forceCollide().iterations(2))
    .force('x', d3.forceX())
    .force('y', d3.forceY())
    .alphaDecay(0.022)
    .velocityDecay(0.38)
    .stop();
  let frozen = false;
  let running = true;

  function computeAnchors(nodes) {
    const present = new Set(nodes.map((n) => n.category));
    const scale = 70 + Math.sqrt(nodes.length) * 17 * (opt.linkDistance / 62);
    const ring = (list, r, offset) => {
      const cats = list.filter((c) => present.has(c));
      cats.forEach((c, i) => { const a = offset + (i / cats.length) * TAU; anchors[c] = { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.78 }; });
    };
    anchors = { backend: { x: 0, y: 0 } };
    ring(RING1, scale, -Math.PI / 2);
    ring(RING2, scale * 1.85, -Math.PI / 6);
    for (const c of present) anchors[c] ||= { x: 0, y: 0 };
  }

  function applyForces() {
    const nodes = sim.nodes();
    computeAnchors(nodes);
    const deg = (n) => Math.max(1, n.viewDegree ?? n.degree ?? 1);
    sim.force('charge').strength((n) => -opt.repel * (0.55 + radius(n) / 14)).distanceMax(650);
    sim.force('link')
      .distance((l) => {
        const same = l.source.category === l.target.category;
        return opt.linkDistance * (same ? 0.8 : 1.45) + (radius(l.source) + radius(l.target)) * 1.2
          + Math.sqrt(Math.min(deg(l.source), deg(l.target))) * 6;
      })
      .strength((l) => (l.source.category === l.target.category ? 1 : 0.12) / Math.min(deg(l.source), deg(l.target)));
    // adaptive spacing: bigger and labelled nodes get more room
    sim.force('collide').radius((n) => radius(n) + opt.collide + (tierOf(n) === 'xl' || tierOf(n) === 'lg' ? 10 : 3)).strength(0.9);
    const pull = (n) => opt.gravity * (n.category === 'tests' || n.category === 'config' ? 1.3 : 1);
    sim.force('x').x((n) => anchors[n.category]?.x ?? 0).strength(pull);
    sim.force('y').y((n) => anchors[n.category]?.y ?? 0).strength(pull);
  }

  function rebuild({ alpha = 0.6 } = {}) {
    const nodes = store.visibleNodes();
    // place brand-new nodes at their cluster anchor so they glide in instead of popping from 0,0
    computeAnchors(nodes);
    for (const n of nodes) {
      if (n.x == null) {
        const a = anchors[n.category] || { x: 0, y: 0 };
        n.x = a.x + (Math.random() - 0.5) * 60;
        n.y = a.y + (Math.random() - 0.5) * 60;
      }
    }
    sim.nodes(nodes);
    sim.force('link').links(store.visibleLinks());
    applyForces();
    if (!frozen) sim.alpha(Math.max(sim.alpha(), alpha));
  }

  // ---------------------------------------------------------------- camera
  const toScreen = (x, y) => [(x - cam.x) * cam.k + W / 2, (y - cam.y) * cam.k + H / 2];
  const toWorld = (sx, sy) => [(sx - W / 2) / cam.k + cam.x, (sy - H / 2) / cam.k + cam.y];
  const insets = () => (W > 900 ? { left: 300, right: 276 } : { left: 0, right: 0 });
  let zoomAnchor = null;
  function lookAt(x, y, k = cam.tk, instant = false) {
    zoomAnchor = null;
    cam.tx = x;
    cam.ty = y;
    cam.tk = Math.max(0.08, Math.min(6, k));
    if (instant || reduceMotion) Object.assign(cam, { x: cam.tx, y: cam.ty, k: cam.tk });
  }
  // fit() keeps re-aiming for a moment, so nodes still settling in the simulation stay in frame
  let fitHold = null;
  function fit(ids = null, pad = 70, { hold = true, maxK = 2.2 } = {}) {
    if (hold) fitHold = { ids, pad, maxK, until: performance.now() + 1600 };
    const ns = ids ? [...ids].map((id) => store.get(store.resolve(id))).filter((n) => n && n.x != null) : sim.nodes().filter((n) => n.x != null);
    if (!ns.length) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const n of ns) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const { left, right } = insets();
    const k = Math.min(maxK, ids && ns.length < 3 ? 2.4 : maxK, (W - left - right - pad * 2) / Math.max(40, x1 - x0), (H - pad * 2 - 90) / Math.max(40, y1 - y0));
    lookAt((x0 + x1) / 2 - (left - right) / 2 / k, (y0 + y1) / 2 + 24 / k, k);
  }
  function focusNode(id, zoom = 2) {
    fitHold = null;
    const n = store.get(store.resolve(id));
    if (!n || n.x == null) return;
    const { left, right } = insets();
    const k = Math.max(cam.tk, zoom);
    lookAt(n.x - (left - right) / 2 / k, n.y, k);
  }

  // ---------------------------------------------------------------- emphasis
  // Which nodes are "in focus" right now (null = everything normal).
  function emphasis() {
    if (sel.path) return new Set(sel.path.nodes);
    if (sel.highlight) return sel.highlight;
    if (sel.ids.size) {
      const set = new Set([...sel.ids].map(store.resolve));
      for (const id of [...set]) for (const a of store.neighbors(id)) set.add(a.other.id);
      return set;
    }
    if (sel.search.size) return new Set([...sel.search].map(store.resolve));
    if (sel.cluster) return new Set(sim.nodes().filter((n) => n.category === sel.cluster).map((n) => n.id));
    return null;
  }

  // ---------------------------------------------------------------- drawing
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (minimap) {
      minimap.width = Math.round(minimap.clientWidth * dpr);
      minimap.height = Math.round(minimap.clientHeight * dpr);
    }
  }
  const colorOf = (n) => store.categories[n.category]?.color || '#9aa';
  const alphaHex = (a) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');

  function drawBackground() {
    ctx.fillStyle = '#03060b';
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(14,26,44,0.7)');
    g.addColorStop(1, 'rgba(3,6,11,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (!opt.holo) return;
    let step = 80 * cam.k;
    while (step < 24) step *= 2;
    ctx.strokeStyle = 'rgba(56,130,200,0.05)';
    ctx.lineWidth = 1;
    const [ox, oy] = toScreen(0, 0);
    ctx.beginPath();
    for (let x = ((ox % step) + step) % step; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = ((oy % step) + step) % step; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  // Convex hull (monotone chain)
  function hull(pts) {
    if (pts.length < 3) return pts.slice();
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    const up = [];
    for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  function drawHulls(emph, shown) {
    hullLabels = [];
    if (!opt.hulls) return;
    const groups = {};
    for (const n of sim.nodes()) {
      if (n.kind === 'cluster' || !shown(n)) continue;
      (groups[n.category] ||= []).push(n);
    }
    const labels = [];
    for (const [cat, ns] of Object.entries(groups)) {
      if (ns.length < 2) continue;
      // ignore far outliers so one stray node does not stretch the whole boundary
      const cx = ns.reduce((a, n) => a + n.x, 0) / ns.length;
      const cy = ns.reduce((a, n) => a + n.y, 0) / ns.length;
      const d = ns.map((n) => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
      const lim = d[Math.floor(d.length * 0.5)] * 1.7 + 24;
      const core = ns.filter((n) => Math.hypot(n.x - cx, n.y - cy) <= lim);
      const pts = hull(core.map((n) => [n.x, n.y]));
      const c = store.categories[cat]?.color || '#888';
      const dim = emph && !core.some((n) => emph.has(n.id));
      const focused = sel.cluster === cat;
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (pts.length > 2) ctx.closePath();
      const pad = 22;
      ctx.lineWidth = pad * 2;
      ctx.strokeStyle = `${c}${alphaHex(focused ? 0.1 : 0.045)}`;
      ctx.stroke();
      ctx.fillStyle = `${c}${alphaHex(focused ? 0.08 : 0.035)}`;
      if (pts.length > 2) ctx.fill();
      ctx.globalAlpha = 1;
      const top = core.reduce((m, n) => (n.y < m.y ? n : m), core[0]);
      labels.push({ cat, x: cx, y: top.y - pad - radius(top) - 4, c, dim, focused, n: ns.length });
    }
    hullLabels = labels;
  }

  function drawHullLabels() {
    const boxes = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
    for (const l of hullLabels) {
      const [sx, sy] = toScreen(l.x, l.y);
      if (sx < -60 || sx > W + 60 || sy < -10 || sy > H + 20) continue;
      const text = `${(store.categories[l.cat]?.label || l.cat).toUpperCase()} · ${l.n}`;
      const w = ctx.measureText(text).width;
      ctx.globalAlpha = l.dim ? 0.3 : l.focused ? 1 : 0.7;
      ctx.fillStyle = l.c;
      ctx.fillText(text, sx, sy);
      ctx.globalAlpha = 1;
      boxes.push({ cat: l.cat, x0: sx - w / 2 - 4, x1: sx + w / 2 + 4, y0: sy - 14, y1: sy + 2 });
    }
    hullLabels.boxes = boxes;
  }

  function arrow(l, color, lw, alpha) {
    const { source: a, target: b } = l;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < radius(b) * 2 + 8) return;
    const ux = dx / len;
    const uy = dy / len;
    const tipX = b.x - ux * (radius(b) + 2.5 * lw);
    const tipY = b.y - uy * (radius(b) + 2.5 * lw);
    const s = 5.5 * lw;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * s - uy * s * 0.55, tipY - uy * s + ux * s * 0.55);
    ctx.lineTo(tipX - ux * s + uy * s * 0.55, tipY - uy * s - ux * s * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground();
    const emph = emphasis();
    const pl = new Set(sel.path ? sel.path.links.map((l) => l.id) : []);
    const now = Date.now();
    const links = sim.force('link').links();
    const nodes = sim.nodes();
    const primary = sel.primary && store.resolve(sel.primary);
    const focusSet = opt.focus && primary ? new Set([primary, ...store.neighbors(primary).map((a) => a.other.id)]) : null;
    const shown = (n) => !focusSet || focusSet.has(n.id);

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(cam.k, cam.k);
    ctx.translate(-cam.x, -cam.y);
    const lw = 1 / cam.k;

    drawHulls(emph, shown);

    // links, batched by type; highlighted ones drawn on top
    if (opt.links) {
      const byType = {};
      const top = [];
      for (const l of links) {
        if (!shown(l.source) || !shown(l.target)) continue;
        const hot = emph && emph.has(l.source.id) && emph.has(l.target.id) && (!sel.path || pl.has(l.id));
        if (hot || pl.has(l.id) || edgeGlow.has(l.id) || sel.edge?.id === l.id) top.push(l);
        else (byType[edgeType(l)] ||= []).push(l);
      }
      const base = opt.linkOpacity * (emph ? 0.25 : 1);
      for (const [type, ls] of Object.entries(byType)) {
        const c = EDGE_TYPES[type].color;
        ctx.strokeStyle = c;
        ctx.globalAlpha = base * ({ imports: 0.7, config: 0.45, data: 0.5, external: 0.75, route: 0.7 })[type];
        ctx.lineWidth = 0.8 * lw;
        ctx.beginPath();
        for (const l of ls) { ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); }
        ctx.stroke();
        if (opt.arrows && cam.k > 0.75) for (const l of ls) arrow(l, c, lw, base * 1.3);
      }
      ctx.globalAlpha = 1;
      for (const l of top) {
        const onPath = pl.has(l.id);
        const glow = edgeGlow.get(l.id);
        const glowA = glow ? Math.max(0, 1 - (now - glow.t) / 3500) : 0;
        if (glow && glowA <= 0) edgeGlow.delete(l.id);
        const c = onPath || sel.edge?.id === l.id ? '#ffffff' : glowA > 0 ? glow.color : EDGE_TYPES[edgeType(l)].color;
        ctx.strokeStyle = c;
        ctx.globalAlpha = onPath || sel.edge?.id === l.id ? 0.95 : Math.max(0.6 * (emph ? 1 : 0), glowA * 0.9, emph ? 0.6 : 0.4);
        ctx.lineWidth = (onPath ? 2.2 : glowA > 0 ? 1.8 : 1.2) * lw;
        if (opt.holo && (onPath || glowA > 0.3)) { ctx.shadowColor = c; ctx.shadowBlur = 6; }
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (opt.arrows) arrow(l, c, lw * 1.2, ctx.globalAlpha);
      }
      ctx.globalAlpha = 1;
    }

    // event particles (real or demo events only)
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += p.speed * (reduceMotion ? 3 : 1);
      if (p.t >= 1 || !p.a || !p.b) { particles.splice(i, 1); continue; }
      const e = 1 - (1 - p.t) ** 2;
      const x = p.a.x + (p.b.x - p.a.x) * e;
      const y = p.a.y + (p.b.y - p.a.y) * e;
      const tx = p.a.x + (p.b.x - p.a.x) * Math.max(0, e - 0.16);
      const ty = p.a.y + (p.b.y - p.a.y) * Math.max(0, e - 0.16);
      const grad = ctx.createLinearGradient(tx, ty, x, y);
      grad.addColorStop(0, `${p.color}00`);
      grad.addColorStop(1, p.color);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.2 * lw;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      if (opt.holo) { ctx.shadowColor = p.color; ctx.shadowBlur = 8; }
      ctx.beginPath();
      ctx.arc(x, y, 2.6 * lw * Math.max(1, cam.k * 0.6), 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // nodes
    for (const n of nodes) {
      if (!shown(n)) continue;
      const r = radius(n);
      const dim = emph && !emph.has(n.id);
      const tier = tierOf(n);
      const active = opt.highlightActive && store.isActive(n.id, 8000);
      const c = colorOf(n);
      const base = tier === 'xs' ? 0.55 : 1;
      if (active && (opt.eyes || opt.reflex) && !dim) {
        const age = (now - (store.lastActive.get(n.id) || now)) / 8000;
        ctx.fillStyle = c;
        ctx.globalAlpha = 0.22 * (1 - Math.min(1, age));
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 2.1, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = (dim ? 0.1 : 1) * base;
      const selected = sel.ids.has(n.id) || (primary === n.id);
      if (opt.holo && !dim && (selected || active || tier === 'xl')) { ctx.shadowColor = c; ctx.shadowBlur = selected ? 12 : 6; }
      if (n.kind === 'cluster') {
        ctx.fillStyle = `${c}33`;
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.6 * lw;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([3 * lw, 3 * lw]);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4 * lw, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, TAU);
        ctx.fill();
        if (tier === 'xl' || tier === 'lg') {
          ctx.shadowBlur = 0;
          ctx.strokeStyle = 'rgba(3,6,11,0.55)';
          ctx.lineWidth = Math.max(1, r * 0.18);
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 0.62, 0, TAU);
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
      if (n.status === 'error' || n.status === 'missing' || n.status === 'not configured') {
        ctx.strokeStyle = '#f87171';
        ctx.lineWidth = 1.5 * lw;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 1.5 * lw, 0, TAU);
        ctx.stroke();
      }
      if (selected || sel.search.has(n.id) || sel.hover === n) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = (selected ? 2 : 1.2) * lw;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 * lw + 1, 0, TAU);
        ctx.stroke();
      }
      if (n.fx != null) {
        ctx.fillStyle = '#03060b';
        ctx.beginPath();
        ctx.arc(n.x, n.y, Math.min(2, r / 2.5), 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    drawHullLabels();
    if (opt.labels !== 'none') drawLabels(nodes, emph, shown, primary);
  }

  // Labels in screen space: important first, never on top of each other, dark pill behind the text.
  function drawLabels(nodes, emph, shown, primary) {
    const hubs = new Set(store.hubs(8).map((h) => h.node.id));
    const placed = (hullLabels.boxes || []).map((b) => [b.x0, b.y0, b.x1, b.y1]);
    const free = (b) => !placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    const rank = (n) => (n.id === primary ? 1e6 : 0) + (sel.ids.has(n.id) ? 1e5 : 0) + (sel.hover === n ? 1e5 : 0)
      + (sel.search.has(n.id) ? 5e4 : 0) + ({ cluster: 9e3, xl: 8e3, lg: 6e3, md: 3e3, sm: 1e3, xs: 0 })[tierOf(n)] + (n.degree || 0);
    const minTier = { cluster: 0, xl: 0, lg: 0, md: 1.25, sm: 2.1, xs: 3.2 };
    const ordered = [...nodes].sort((a, b) => rank(b) - rank(a));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of ordered) {
      if (!shown(n)) continue;
      const tier = tierOf(n);
      const important = n.id === primary || sel.ids.has(n.id) || sel.hover === n || sel.search.has(n.id) || (sel.path && emph?.has(n.id));
      const near = emph?.has(n.id) && (sel.ids.size || sel.highlight || sel.cluster);
      const byZoom = opt.labels === 'all' || cam.k >= minTier[tier] || hubs.has(n.id);
      if (!(important || near || byZoom)) continue;
      if (emph && !emph.has(n.id) && !important) continue;
      const [sx, sy0] = toScreen(n.x, n.y);
      if (sx < -120 || sx > W + 120 || sy0 < -30 || sy0 > H + 30) continue;
      const text = n.label.length > 36 ? `${n.label.slice(0, 34)}…` : n.label;
      const size = important ? 11.5 : tier === 'xl' || tier === 'cluster' ? 11 : 10.5;
      ctx.font = `${important || tier === 'xl' ? 600 : 500} ${size}px ui-monospace, Menlo, Consolas, monospace`;
      const tw = ctx.measureText(text).width;
      const sy = sy0 + radius(n) * cam.k + 10;
      const box = [sx - tw / 2 - 5, sy - 8, sx + tw / 2 + 5, sy + 8];
      if (!important && !free(box)) continue;
      placed.push(box);
      ctx.fillStyle = important ? 'rgba(10,18,30,0.92)' : 'rgba(5,9,16,0.72)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(box[0], box[1], box[2] - box[0], 16, 5) : ctx.rect(box[0], box[1], box[2] - box[0], 16);
      ctx.fill();
      if (important) { ctx.strokeStyle = colorOf(n); ctx.globalAlpha = 0.7; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.fillStyle = important ? '#ffffff' : tier === 'xs' ? 'rgba(170,180,195,0.7)' : 'rgba(215,225,238,0.9)';
      ctx.fillText(text, sx, sy + 0.5);
    }
  }

  // ---------------------------------------------------------------- minimap
  let mmBounds = null;
  function drawMinimap() {
    if (!mctx) return;
    const w = minimap.clientWidth;
    const h = minimap.clientHeight;
    if (!w) return;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, w, h);
    const ns = sim.nodes().filter((n) => n.x != null);
    if (!ns.length) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const n of ns) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const pad = 40;
    const s = Math.min((w - 8) / (x1 - x0 + pad * 2), (h - 8) / (y1 - y0 + pad * 2));
    const ox = (w - (x1 - x0) * s) / 2 - x0 * s;
    const oy = (h - (y1 - y0) * s) / 2 - y0 * s;
    mmBounds = { s, ox, oy };
    for (const n of ns) {
      mctx.fillStyle = colorOf(n);
      mctx.globalAlpha = tierOf(n) === 'xs' ? 0.4 : 0.85;
      const r = Math.max(1, radius(n) * s * 0.9);
      mctx.fillRect(n.x * s + ox - r / 2, n.y * s + oy - r / 2, r, r);
    }
    mctx.globalAlpha = 1;
    const [wx0, wy0] = toWorld(0, 0);
    const [wx1, wy1] = toWorld(W, H);
    mctx.strokeStyle = '#22d3ee';
    mctx.lineWidth = 1;
    mctx.strokeRect(wx0 * s + ox, wy0 * s + oy, (wx1 - wx0) * s, (wy1 - wy0) * s);
  }
  if (minimap) {
    let mmDrag = false;
    const go = (e) => {
      if (!mmBounds) return;
      const r = minimap.getBoundingClientRect();
      lastUserInput = Date.now();
      fitHold = null;
      lookAt((e.clientX - r.left - mmBounds.ox) / mmBounds.s, (e.clientY - r.top - mmBounds.oy) / mmBounds.s, cam.tk);
    };
    minimap.addEventListener('pointerdown', (e) => { mmDrag = true; minimap.setPointerCapture(e.pointerId); go(e); });
    minimap.addEventListener('pointermove', (e) => { if (mmDrag) go(e); });
    minimap.addEventListener('pointerup', () => { mmDrag = false; });
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now();
  let frameNo = 0;
  function frame(t) {
    if (!running) return;
    const dt = Math.min(64, t - last);
    last = t;
    if (!frozen && sim.alpha() > sim.alphaMin()) sim.tick();
    if (fitHold) {
      if (t > fitHold.until || Date.now() - lastUserInput < 300) fitHold = null;
      else fit(fitHold.ids, fitHold.pad, { hold: false, maxK: fitHold.maxK });
    }
    const ease = reduceMotion ? 1 : 1 - Math.pow(0.003, dt / 1000);
    cam.k += (cam.tk - cam.k) * ease;
    if (zoomAnchor) {
      cam.x = zoomAnchor.wx - (zoomAnchor.sx - W / 2) / cam.k;
      cam.y = zoomAnchor.wy - (zoomAnchor.sy - H / 2) / cam.k;
      if (Math.abs(cam.tk - cam.k) < 0.001) zoomAnchor = null;
    } else {
      cam.x += (cam.tx - cam.x) * ease;
      cam.y += (cam.ty - cam.y) * ease;
    }
    draw(t);
    if (frameNo++ % 4 === 0) drawMinimap();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- hit testing
  function nodeAt(sx, sy) {
    const [x, y] = toWorld(sx, sy);
    const primary = sel.primary && store.resolve(sel.primary);
    const focusSet = opt.focus && primary ? new Set([primary, ...store.neighbors(primary).map((a) => a.other.id)]) : null;
    let best = null;
    let bd = Infinity;
    for (const n of sim.nodes()) {
      if (focusSet && !focusSet.has(n.id)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      const r = radius(n) + 4 / cam.k;
      if (d < r && d < bd) { best = n; bd = d; }
    }
    return best;
  }
  function edgeAt(sx, sy) {
    if (!opt.links) return null;
    const [x, y] = toWorld(sx, sy);
    let best = null;
    let bd = 5 / cam.k;
    for (const l of sim.force('link').links()) {
      const { source: a, target: b } = l;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      const d = Math.hypot(a.x + u * dx - x, a.y + u * dy - y);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }
  const hullLabelAt = (sx, sy) => (hullLabels.boxes || []).find((b) => sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1)?.cat || null;

  // ---------------------------------------------------------------- pointer input
  const pointers = new Map();
  let drag = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = pos(e);
    pointers.set(e.pointerId, [sx, sy]);
    lastUserInput = Date.now();
    fitHold = null;
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      drag = { kind: 'pinch', startDist: Math.hypot(p1[0] - p2[0], p1[1] - p2[1]), startK: cam.tk, moved: true };
      return;
    }
    const n = nodeAt(sx, sy);
    drag = n ? { kind: 'node', node: n, sx, sy, moved: false } : { kind: 'pan', sx, sy, cx: cam.tx, cy: cam.ty, moved: false };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = pos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
    if (!drag) {
      const n = nodeAt(sx, sy);
      const l = n ? null : edgeAt(sx, sy);
      const hl = n || l ? null : hullLabelAt(sx, sy);
      sel.hover = n;
      canvas.classList.toggle('over', !!(n || l || hl));
      emit('hover', n, l, e.clientX, e.clientY, hl);
      return;
    }
    lastUserInput = Date.now();
    if (drag.kind === 'pinch' && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      lookAt(cam.tx, cam.ty, drag.startK * (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) / drag.startDist), true);
      return;
    }
    if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === 'node') {
      const [x, y] = toWorld(sx, sy);
      drag.node.fx = x;
      drag.node.fy = y;
      if (frozen) { drag.node.x = x; drag.node.y = y; } else sim.alphaTarget(0.2);
    } else if (drag.kind === 'pan') {
      lookAt(drag.cx - (sx - drag.sx) / cam.k, drag.cy - (sy - drag.sy) / cam.k, cam.tk, true);
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    canvas.classList.remove('dragging');
    if (!drag) return;
    const d = drag;
    drag = pointers.size ? drag : null;
    if (d.kind === 'pinch') { drag = null; return; }
    sim.alphaTarget(0);
    if (d.moved) return;
    const [sx, sy] = pos(e);
    if (d.kind === 'node') {
      if (e.shiftKey && sel.primary && store.resolve(sel.primary) !== d.node.id) emit('trace', sel.primary, d.node.id);
      else emit('select', d.node.id, { additive: e.ctrlKey || e.metaKey });
    } else {
      const cat = hullLabelAt(sx, sy);
      const l = cat ? null : edgeAt(sx, sy);
      if (cat) emit('cluster', cat);
      else if (l) emit('edge', l);
      else emit('background');
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag) { sel.hover = null; emit('hover', null); } });
  canvas.addEventListener('dblclick', (e) => {
    const n = nodeAt(...pos(e));
    if (!n) return;
    if (n.kind === 'cluster') { emit('expand', n.category); return; }
    n.fx = null;
    n.fy = null;
    if (!frozen) sim.alpha(0.3);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    lastUserInput = Date.now();
    fitHold = null;
    const [sx, sy] = pos(e);
    const [wx, wy] = toWorld(sx, sy);
    const k = Math.max(0.08, Math.min(6, cam.tk * Math.exp(-e.deltaY * 0.0015)));
    // smooth zoom that keeps the point under the cursor fixed while it eases
    zoomAnchor = { wx, wy, sx, sy };
    cam.tk = k;
    cam.tx = wx - (sx - W / 2) / k;
    cam.ty = wy - (sy - H / 2) / k;
  }, { passive: false });

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- public API
  return {
    on: (name, fn) => ((listeners[name] ||= []).push(fn)),
    rebuild,
    fit,
    focusNode,
    focusCluster(cat) {
      sel.cluster = cat;
      fit(new Set(store.members(cat).map((m) => m.id)), 60, { maxK: 2.6 });
    },
    zoom: (f) => lookAt(cam.tx, cam.ty, cam.tk * f),
    setForces(f) {
      Object.assign(opt, f);
      applyForces();
      if (!frozen) sim.alpha(Math.max(sim.alpha(), 0.5));
    },
    setDisplay(d) {
      Object.assign(opt, d);
      if ('nodeSize' in d) { applyForces(); if (!frozen) sim.alpha(Math.max(sim.alpha(), 0.3)); }
    },
    setFlags(f) { Object.assign(opt, f); },
    get opt() { return opt; },
    freeze(on) { frozen = on; if (!on) sim.alpha(0.3); },
    get frozen() { return frozen; },
    resetLayout() {
      computeAnchors(sim.nodes());
      for (const n of [...store.nodes, ...store.clusterNodes.values()]) {
        const a = anchors[n.category] || { x: 0, y: 0 };
        Object.assign(n, { fx: null, fy: null, x: a.x + (Math.random() - 0.5) * 80, y: a.y + (Math.random() - 0.5) * 80, vx: 0, vy: 0 });
      }
      frozen = false;
      sim.alpha(1);
      setTimeout(() => fit(), 1400);
    },
    select(ids, primary = null) {
      sel.ids = new Set(ids);
      sel.primary = primary ?? [...sel.ids][0] ?? null;
      sel.edge = null;
      if (!sel.ids.size) sel.path = null;
    },
    setEdge(l) { sel.edge = l; },
    setPath(p) { sel.path = p; },
    setSearch(ids) { sel.search = new Set(ids); },
    setHighlight(set) { sel.highlight = set && set.size ? set : null; },
    setCluster(cat) { sel.cluster = cat; },
    clear() { Object.assign(sel, { ids: new Set(), primary: null, edge: null, path: null, search: new Set(), highlight: null, cluster: null }); },
    get selection() { return sel; },
    /** Animates one event: along its connection (lit for ~3 s) or straight between the two nodes. */
    pulse(ev, { color = '#22d3ee', speed = 0.02 } = {}) {
      const ai = store.resolve(ev.source);
      const bi = store.resolve(ev.target);
      const a = store.get(ai);
      const b = store.get(bi);
      if (!a || !b || a === b || a.x == null || b.x == null || !sim.nodes().includes(a) || !sim.nodes().includes(b)) return;
      const l = store.linkBetween(ai, bi);
      if (l) edgeGlow.set(l.id, { t: Date.now(), color });
      if (particles.length > 160) particles.shift();
      particles.push({ a, b, t: 0, speed: speed * (0.5 + opt.anim), color });
    },
    pulsePath(path, { color = '#ffffff', gapMs = 260 } = {}) {
      path.links.forEach((l, i) => setTimeout(() => {
        const fwd = path.nodes[i] === l.source.id;
        edgeGlow.set(l.id, { t: Date.now(), color: '#22d3ee' });
        particles.push({ a: fwd ? l.source : l.target, b: fwd ? l.target : l.source, t: 0, speed: 0.03, color });
      }, i * gapMs));
    },
    /** EYES: follow a node unless the user moved the camera in the last 4 s. */
    track(id) {
      if (Date.now() - lastUserInput < 4000) return;
      const n = store.get(store.resolve(id));
      if (n && n.x != null) lookAt(n.x, n.y, Math.max(cam.tk, 0.9));
    },
    /** Screen position (CSS px, relative to the canvas) of a node - used by tests and tooltips. */
    screenOf(id) { const n = store.get(store.resolve(id)); return n ? toScreen(n.x, n.y) : null; },
    get camera() { return { x: cam.x, y: cam.y, k: cam.k }; },
    stop() { running = false; sim.stop(); },
  };
}
