// PIXRA AI network visualizer: wires the store, renderer, live feed and the UI panels together.
import { createStore, statusClass, EDGE_TYPES, edgeType } from './store.js';
import { createRenderer, TIERS } from './renderer.js';
import { fetchJSON, subscribe, createDemo } from './live.js';
import { parse, EXAMPLES, categoryWord, ALIASES } from './commands.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
};
const ago = (iso) => {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
// replaceChildren() turns an array argument into text, so flatten nested sections first
const setInspector = (...kids) => $('inspector').replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
const catColor = (cat) => store.categories[cat]?.color || '#9aa';
const catLabel = (cat) => store.categories[cat]?.label || cat;

const store = createStore();
const renderer = createRenderer($('graph'), store, { minimap: $('minimap') });
const ui = { status: null, sse: 'connecting', lastTopoAt: null, inspecting: null };
const flags = { eyes: false, holo: true, focus: false, reflex: true };

// ------------------------------------------------------------------ boot
async function loadTopology({ first = false } = {}) {
  const topo = await fetchJSON('/api/topology');
  const before = new Set(store.nodes.map((n) => n.id));
  const changed = store.setTopology(topo);
  ui.lastTopoAt = topo.builtAt;
  if (changed) {
    renderer.rebuild({ alpha: first ? 1 : 0.3 });
    if (!first) {
      const now = new Set(store.nodes.map((n) => n.id));
      const added = [...now].filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !now.has(id));
      keepSelection();
      if (added.length || removed.length) say(`Architecture updated from the code: +${added.length} / −${removed.length} node(s).`);
      for (const id of added) store.lastActive.set(id, Date.now()); // briefly glow what is new
    }
  }
  renderFilters();
  renderHubs();
  renderStats();
  if (ui.inspecting?.type === 'node' && store.byId.has(ui.inspecting.id)) inspectNode(ui.inspecting.id, { keepCamera: true });
}

// After a structural update: keep whatever is still there selected.
function keepSelection() {
  const sel = renderer.selection;
  const ids = [...sel.ids].filter((id) => store.get(id));
  if (!ids.length && sel.ids.size) { clearSelection(); return; }
  if (ids.length !== sel.ids.size) renderer.select(ids, store.get(sel.primary) ? sel.primary : ids[0]);
  if (sel.path && !sel.path.nodes.every((id) => store.get(id))) renderer.setPath(null);
  if (sel.edge && !store.visibleLinks().some((l) => l.id === sel.edge.id)) renderer.setEdge(null);
}

async function boot() {
  renderLegend();
  try {
    await loadTopology({ first: true });
    ui.status = await fetchJSON('/api/status');
    renderStatus();
    setTimeout(() => renderer.fit(), 1500);
    $('overlay').classList.add('hide');
    setTimeout(() => { $('overlay').hidden = true; }, 600); // gone after the fade, even if transitions were paused
  } catch (err) {
    $('overlay').classList.add('err');
    $('overlayMsg').textContent = `Could not load the architecture: ${err.message}`;
    $('overlay').append(el('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Retry'));
    return;
  }
  subscribe({
    onState: (s) => { ui.sse = s; renderMode(); renderStatus(); },
    onHello: ({ events }) => { for (const ev of events) store.addEvent(ev); renderFeed(); },
    onEvent: (ev) => handleEvent(ev),
    onStatus: (s) => { ui.status = s; renderStatus(); },
    onTopology: () => loadTopology().catch(() => {}),
  });
  // statuses on nodes (verified / error) change as calls happen: refresh them quietly
  setInterval(() => { if (document.visibilityState === 'visible') loadTopology().catch(() => {}); }, 30000);
}

// ------------------------------------------------------------------ events (live + demo)
const demo = createDemo(store, (ev) => handleEvent(ev));
function handleEvent(ev) {
  store.addEvent(ev);
  if (flags.reflex) {
    const target = store.byId.get(ev.target);
    const color = ev.status === 'error' ? '#f87171' : ev.demo ? '#fbbf24' : catColor(target?.category) || '#22d3ee';
    renderer.pulse(ev, { color });
  }
  if (flags.eyes) renderer.track(ev.target);
  renderFeed(ev.id);
  if (ui.inspecting?.type === 'node' && (ev.source === ui.inspecting.id || ev.target === ui.inspecting.id)) renderNodeEvents(ui.inspecting.id);
}

function renderFeed(newId) {
  const list = $('feed');
  const evs = store.events.slice(-40).reverse();
  list.replaceChildren(...(evs.length ? evs.map((ev) => {
    const s = store.byId.get(ev.source);
    const t = store.byId.get(ev.target);
    const cls = ev.status === 'error' ? '#f87171' : ev.demo ? '#fbbf24' : catColor(t?.category);
    return el('li', { class: ev.id === newId ? 'new' : '' }, el('button', { type: 'button', onclick: () => inspectEvent(ev) },
      el('i', { class: 'dot', style: `color:${cls}` }),
      el('span', { class: 'ev' },
        el('b', {}, `${s?.label || ev.source} → ${t?.label || ev.target}`),
        el('small', {}, `${clock(ev.timestamp)} · ${ev.demo ? 'DEMO · ' : ''}${ev.detail || ev.eventType}${ev.ms != null ? ` · ${ev.ms} ms` : ''}`))));
  }) : [el('li', { class: 'empty' }, 'No events yet. Use the app (admin portal, /demo or /dev chat) and they appear here live, or turn on DEMO.')]));
  $('sEvents').textContent = String(store.events.filter((e) => !e.demo).length);
}

// ------------------------------------------------------------------ panels
function renderStats() {
  const vn = store.visibleNodes().length;
  const vl = store.visibleLinks().length;
  const n = store.nodes.length;
  const l = store.links.length;
  $('stNodes').replaceChildren(String(vn), vn !== n ? el('small', {}, ` /${n}`) : '');
  $('stEdges').replaceChildren(String(vl), vl !== l ? el('small', {}, ` /${l}`) : '');
  $('brandSub').textContent = `${n} nodes · ${l} connections · built from the code`;
  $('stUpdated').textContent = ago(ui.lastTopoAt);
}

function renderFilters() {
  const counts = store.categoryCounts();
  const cats = Object.entries(store.categories).filter(([k]) => counts[k]);
  const focus = renderer.selection.cluster;
  $('filters').replaceChildren(...cats.map(([k, c]) => el('li', { class: focus === k ? 'focus' : '' },
    el('button', {
      type: 'button', class: 'main', 'aria-pressed': String(!store.hidden.has(k)), title: `Show/hide ${c.label}`,
      onclick: () => toggleCategory(k),
    }, el('i', { class: 'dot', style: `color:${c.color}` }), el('span', { class: 'name' }, c.label), el('span', { class: 'num' }, counts[k])),
    el('button', {
      type: 'button', class: 'mini', 'aria-pressed': String(store.collapsed.has(k)),
      title: store.collapsed.has(k) ? `Expand ${c.label}` : `Collapse ${c.label} into one node`,
      'aria-label': store.collapsed.has(k) ? `Expand ${c.label}` : `Collapse ${c.label}`,
      onclick: () => toggleCollapse(k),
    }, store.collapsed.has(k) ? '⊞' : '⊟'),
    el('button', { type: 'button', class: 'mini', title: `Focus ${c.label}`, 'aria-label': `Focus ${c.label}`, onclick: () => inspectCluster(k) }, '⌖'))));
}
function toggleCategory(k, on = store.hidden.has(k)) {
  if (on) store.hidden.delete(k);
  else store.hidden.add(k);
  afterFilter();
}
function toggleCollapse(k, on = !store.collapsed.has(k)) {
  if (on) store.collapsed.add(k);
  else {
    store.collapsed.delete(k);
    // members fan out from where the cluster node was
    const c = store.clusterNodes.get(k);
    if (c?.x != null) for (const m of store.members(k)) { m.x = c.x + (Math.random() - 0.5) * 50; m.y = c.y + (Math.random() - 0.5) * 50; }
  }
  if (on && renderer.selection.primary && store.byId.get(renderer.selection.primary)?.category === k) renderer.select([`cluster:${k}`]);
  afterFilter();
  say(on ? `${catLabel(k)} collapsed into one node - double-click it to expand.` : `${catLabel(k)} expanded.`);
}
function afterFilter() {
  store.invalidate();
  renderer.rebuild({ alpha: 0.35 });
  keepSelection();
  renderFilters();
  renderHubs();
  renderStats();
}

function renderHubs() {
  $('hubs').replaceChildren(...store.hubs(8).map(({ node, count }) => el('li', {}, el('button', {
    type: 'button', onclick: () => selectNode(node.id), title: catLabel(node.category),
  }, el('i', { class: 'dot', style: `color:${catColor(node.category)}` }), el('span', { class: 'name' }, node.label), el('span', { class: 'num' }, count)))));
}

function renderLegend() {
  $('legendTiers').replaceChildren(...Object.values(TIERS).map((t) => el('li', {},
    el('span', { class: 'sz' }, el('i', { style: `width:${t.r * 1.2}px;height:${t.r * 1.2}px` })), t.label)),
  el('li', {}, el('span', { class: 'sz' }, el('i', { style: 'width:16px;height:16px;background:transparent;border:1.5px dashed var(--muted)' })), 'Collapsed cluster'));
  $('legendEdges').replaceChildren(...Object.values(EDGE_TYPES).map((t) => el('li', {}, el('i', { class: 'ln', style: `--c:${t.color}` }), t.label)));
}

function renderMode() {
  const b = $('modeBadge');
  const mock = ui.status?.mode?.mock;
  if (demo.on) { b.className = 'mode demo'; b.textContent = 'DEMO MODE'; }
  else if (ui.sse === 'live') { b.className = 'mode live'; b.textContent = mock ? 'LIVE · MOCK' : 'LIVE'; b.title = mock ? 'Live events from this server; its services run in MOCK_MODE' : 'Live events from this server'; }
  else if (ui.sse === 'offline') { b.className = 'mode off'; b.textContent = 'OFFLINE · RETRYING'; }
  else { b.className = 'mode'; b.textContent = 'CONNECTING'; }
  $('feedMode').textContent = demo.on ? 'demo' : 'live';
  $('feedMode').className = `tag${demo.on ? ' demo' : ''}`;
}

function setSt(id, text, cls) {
  const e = $(id);
  e.textContent = text;
  e.className = `st ${cls}`;
}
function serviceLabel(mode, verified) {
  if (mode === 'mock') return ['mock', 'warn'];
  if (mode === 'real') return verified ? ['verified', 'ok'] : ['configured · unverified', 'warn'];
  if (mode === 'disabled') return ['disabled', 'off'];
  return [mode || 'not configured', 'bad'];
}
function renderStatus() {
  const s = ui.status;
  const online = ui.sse === 'live' && s?.online;
  setSt('sSystem', online ? 'ONLINE' : ui.sse === 'offline' ? 'OFFLINE' : 'connecting', online ? 'ok' : ui.sse === 'offline' ? 'bad' : 'warn');
  if (!s) return;
  setSt('sBackend', ui.sse === 'offline' ? 'unreachable' : `online · up ${Math.round(s.uptimeSec / 60)}m`, ui.sse === 'offline' ? 'bad' : 'ok');
  const g = serviceLabel(s.services.gemini, s.external['ext:google-gemini']?.ok);
  const c = serviceLabel(s.services.cloudflare, s.external['ext:cloudflare']?.ok);
  const worst = [g, c].find((x) => x[1] === 'bad') || [g, c].find((x) => x[1] === 'warn') || g;
  setSt('sAi', g[0] === c[0] ? g[0] : `Gemini ${g[0]} · CF ${c[0]}`, worst[1]);
  $('sAi').title = `Gemini: ${g[0]}, Cloudflare: ${c[0]}, Hugging Face: ${s.services.huggingface || '–'}`;
  const db = s.db || {};
  if (db.kind === 'local') setSt('sDb', 'local JSON · mock', 'warn');
  else if (db.reachable === true) setSt('sDb', 'Supabase · verified', 'ok');
  else if (db.reachable === false) setSt('sDb', db.error || 'error', 'bad');
  else setSt('sDb', 'unverified', 'unk');
  setSt('sReq', String(s.activeRequests), s.activeRequests ? 'ok' : 'unk');

  const modes = Object.values(s.services);
  const ready = modes.filter((m) => m === 'real' || m === 'mock').length;
  $('stServices').replaceChildren(`${ready}/${modes.length}`, s.mode.mock ? el('small', {}, ' mock') : '');
  $('arcServices').setAttribute('stroke-dasharray', `${(ready / Math.max(1, modes.length)) * 100} 100`);
  $('arcLoad').setAttribute('stroke-dasharray', `${Math.min(1, s.activeRequests / 10) * 100} 100`);
  $('hudSub').textContent = !online ? 'offline' : s.mode.mock ? 'mock mode' : s.mode.production ? 'production' : 'live';
  $('hud').classList.toggle('off', !online);
  renderMode();
  renderStats();
}

// ------------------------------------------------------------------ selection + inspector
function nodeLine(n, rel, relColor) {
  return el('li', {}, el('button', { type: 'button', onclick: () => selectNode(n.id), title: n.metadata?.path || n.id },
    el('i', { class: 'dot', style: `color:${catColor(n.category)}` }),
    el('span', { class: 'name' }, n.label), rel ? el('span', { class: 'rel', style: relColor ? `color:${relColor}` : '' }, rel) : ''));
}
// Connections grouped by edge type (colour = legend)
function connGroups(items) {
  const groups = {};
  for (const a of items) (groups[edgeType(a.link)] ||= []).push(a);
  return Object.entries(groups).map(([type, list]) => {
    const t = EDGE_TYPES[type];
    const shown = list.slice(0, 25);
    return [el('div', { class: 'grp', style: `--c:${t.color}` }, el('i'), `${t.label} · ${list.length}`),
      el('ul', { class: 'list conns' }, shown.map((a) => nodeLine(a.other, a.link.relationship, t.color)),
        list.length > shown.length ? el('li', { class: 'rel' }, `+${list.length - shown.length} more`) : '')];
  });
}

function selectNode(id, { additive = false, keepCamera = false } = {}) {
  const n = store.byId.get(id);
  if (n && store.collapsed.has(n.category)) toggleCollapse(n.category, false); // opening a member expands its cluster
  if (id.startsWith('cluster:')) { renderer.select([id], id); return inspectCluster(id.slice(8), { fromNode: true }); }
  const sel = renderer.selection;
  renderer.setCluster(null);
  if (additive && sel.ids.size) {
    const ids = new Set(sel.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    renderer.select(ids, id);
    renderer.setPath(null);
    if (ids.size > 1) return inspectMulti([...ids]);
  } else {
    renderer.select([id], id);
    renderer.setPath(null);
  }
  renderer.setHighlight(null);
  renderer.setSearch([]);
  inspectNode(id, { keepCamera });
}

function inspectNode(id, { keepCamera = false } = {}) {
  const n = store.byId.get(id);
  if (!n) return;
  ui.inspecting = { type: 'node', id };
  if (!store.isVisible(n)) toggleCategory(n.category, true);
  const out = store.neighbors(id).filter((a) => a.dir === 'out');
  const inc = store.neighbors(id).filter((a) => a.dir === 'in');
  const meta = Object.entries(n.metadata || {}).filter(([k, v]) => v !== '' && v != null && k !== 'path');
  const sc = statusClass(n.status);
  setInspector(
    el('h3', {}, n.label),
    el('p', { class: 'path' }, n.metadata?.path || n.id),
    el('div', { class: 'cat' }, el('i', { class: 'dot', style: `color:${catColor(n.category)}` }), `${catLabel(n.category)} · ${n.kind || 'node'}`, ' ',
      el('b', { class: `pill st ${sc}` }, n.status)),
    n.description ? el('p', { class: 'desc' }, n.description) : '',
    el('div', { class: 'counts' },
      el('div', {}, el('b', {}, inc.length), el('small', {}, 'incoming')),
      el('div', {}, el('b', {}, out.length), el('small', {}, 'outgoing')),
      el('div', {}, el('b', {}, inc.length + out.length), el('small', {}, 'total'))),
    meta.length ? el('dl', { class: 'kv' }, el('dt', {}, 'id'), el('dd', {}, n.id), ...meta.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])) : el('dl', { class: 'kv' }, el('dt', {}, 'id'), el('dd', {}, n.id)),
    el('h4', {}, `Outgoing (${out.length})`), out.length ? connGroups(out) : el('p', { class: 'rel' }, 'none'),
    el('h4', {}, `Incoming (${inc.length})`), inc.length ? connGroups(inc) : el('p', { class: 'rel' }, 'none'),
    el('h4', {}, 'Recent events'), el('div', { id: 'nodeEvents' }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => renderer.focusNode(id, 2) }, 'Focus node'),
      el('button', { class: 'btn', type: 'button', onclick: () => inspectCluster(n.category) }, 'Focus cluster'),
      el('button', { class: 'btn', type: 'button', onclick: () => setFlag('focus', !flags.focus) }, flags.focus ? 'Exit FOCUS' : 'FOCUS mode'),
      el('button', { class: 'btn', type: 'button', onclick: () => { ui.traceFrom = id; say('Trace: now click the destination node.'); } }, 'Trace from here'),
      n.fx != null ? el('button', { class: 'btn', type: 'button', onclick: () => { n.fx = null; n.fy = null; renderer.rebuild({ alpha: 0.2 }); inspectNode(id, { keepCamera: true }); } }, 'Unpin') : ''),
  );
  renderNodeEvents(id);
  $('inspector').parentElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!keepCamera) {
    if (flags.focus) renderer.fit(new Set([id, ...store.neighbors(id).map((a) => a.other.id)]));
    else renderer.focusNode(id, 1.8);
  }
  openPanel(null);
}
function renderNodeEvents(id) {
  const box = $('nodeEvents');
  if (!box) return;
  const evs = store.eventsFor(id, 6);
  box.replaceChildren(evs.length
    ? el('ul', { class: 'list conns' }, evs.map((ev) => el('li', {}, el('button', { type: 'button', onclick: () => inspectEvent(ev) },
      el('i', { class: 'dot', style: `color:${ev.status === 'error' ? '#f87171' : ev.demo ? '#fbbf24' : '#34d399'}` }),
      el('span', { class: 'name' }, `${clock(ev.timestamp)} ${ev.demo ? 'DEMO ' : ''}${ev.detail || ev.eventType}`)))))
    : el('p', { class: 'rel' }, 'No events recorded for this node yet.'));
}

function inspectCluster(cat, { fromNode = false } = {}) {
  if (!store.categories[cat]) return;
  if (store.hidden.has(cat)) toggleCategory(cat, true);
  ui.inspecting = { type: 'cluster', cat };
  if (!fromNode) renderer.select([]);
  renderer.setPath(null);
  renderer.setHighlight(null);
  renderer.setSearch([]);
  renderer.focusCluster(cat);
  renderFilters();
  const info = store.clusterInfo(cat);
  const top = [...info.members].sort((a, b) => b.degree - a.degree);
  const collapsed = store.collapsed.has(cat);
  setInspector(
    el('h3', {}, catLabel(cat)),
    el('div', { class: 'cat' }, el('i', { class: 'dot', style: `color:${catColor(cat)}` }), `cluster · ${collapsed ? 'collapsed' : 'expanded'}`),
    el('div', { class: 'counts' },
      el('div', {}, el('b', {}, info.members.length), el('small', {}, 'nodes')),
      el('div', {}, el('b', {}, info.internal), el('small', {}, 'inside')),
      el('div', {}, el('b', {}, info.outside.reduce((a, [, c]) => a + c, 0)), el('small', {}, 'to others'))),
    el('p', { class: 'desc' }, 'Grouped by where the code lives (folder / kind), from the code scan. Links below are real connections to other clusters.'),
    el('h4', {}, 'Connected clusters'),
    el('ul', { class: 'list conns' }, info.outside.slice(0, 10).map(([c, count]) => el('li', {}, el('button', { type: 'button', onclick: () => inspectCluster(c) },
      el('i', { class: 'dot', style: `color:${catColor(c)}` }), el('span', { class: 'name' }, catLabel(c)), el('span', { class: 'rel' }, `${count} links`))))),
    el('h4', {}, `Members (${info.members.length})`),
    el('ul', { class: 'list conns' }, top.slice(0, 40).map((m) => nodeLine(m, `${m.degree} links`))),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => toggleCollapse(cat) }, collapsed ? 'Expand' : 'Collapse'),
      el('button', { class: 'btn', type: 'button', onclick: () => renderer.focusCluster(cat) }, 'Focus'),
      el('button', { class: 'btn', type: 'button', onclick: () => { store.hidden = new Set(Object.keys(store.categories).filter((k) => k !== cat)); afterFilter(); renderer.focusCluster(cat); } }, 'Show only this'),
      el('button', { class: 'btn', type: 'button', onclick: () => globalView() }, 'Global view')));
  openPanel(null);
}

function inspectMulti(ids) {
  ui.inspecting = { type: 'multi' };
  const ns = ids.map((i) => store.get(i)).filter(Boolean);
  setInspector(el('h3', {}, `${ns.length} nodes selected`),
    el('p', { class: 'desc' }, 'Ctrl/⌘-click toggles nodes in the selection. Their connections are lit.'),
    el('ul', { class: 'list conns' }, ns.map((n) => nodeLine(n, `${n.degree} links`))),
    ns.length === 2 ? el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => trace(ns[0].id, ns[1].id) }, 'Trace path between them')) : '');
  renderer.fit(new Set(ids));
}

function inspectEdge(l) {
  ui.inspecting = { type: 'edge' };
  renderer.setCluster(null);
  renderer.select([l.source.id, l.target.id], l.source.id);
  renderer.setEdge(l);
  const type = EDGE_TYPES[edgeType(l)];
  const evs = store.events.filter((e) => (store.resolve(e.source) === l.source.id && store.resolve(e.target) === l.target.id)
    || (store.resolve(e.source) === l.target.id && store.resolve(e.target) === l.source.id)).slice(-6).reverse();
  setInspector(
    el('h3', {}, l.relationship),
    el('div', { class: 'cat' }, el('i', { class: 'dot', style: `color:${type.color}` }), `${type.label}${l.aggregate ? ' · combined (collapsed cluster)' : ''}`),
    el('dl', { class: 'kv' },
      el('dt', {}, 'source'), el('dd', {}, `${l.source.label} (${catLabel(l.source.category)})`),
      el('dt', {}, 'destination'), el('dd', {}, `${l.target.label} (${catLabel(l.target.category)})`),
      l.aggregate ? [el('dt', {}, 'contains'), el('dd', {}, [...l.rels].join(', '))] : '',
      el('dt', {}, 'found in'), el('dd', {}, l.source.metadata?.path || l.source.metadata?.file || l.source.id)),
    el('p', { class: 'desc' }, `${l.source.label} → ${l.target.label}: arrows on the graph point from source to destination.`),
    el('ul', { class: 'list conns' }, nodeLine(l.source, 'source'), nodeLine(l.target, 'destination')),
    el('h4', {}, 'Events on this connection'),
    evs.length ? el('ul', { class: 'list conns' }, evs.map((ev) => el('li', {}, el('button', { type: 'button', onclick: () => inspectEvent(ev) },
      el('i', { class: 'dot', style: `color:${ev.status === 'error' ? '#f87171' : ev.demo ? '#fbbf24' : '#34d399'}` }),
      el('span', { class: 'name' }, `${clock(ev.timestamp)} ${ev.demo ? 'DEMO ' : ''}${ev.detail || ev.eventType}`)))))
      : el('p', { class: 'rel' }, 'None recorded yet.'));
}

function inspectEvent(ev) {
  ui.inspecting = { type: 'event' };
  const s = store.byId.get(ev.source);
  const t = store.byId.get(ev.target);
  if (s && t) {
    renderer.setCluster(null);
    renderer.select([ev.source, ev.target], ev.target);
    const p = store.shortestPath(ev.source, ev.target);
    renderer.setPath(p && p.links.length === 1 ? p : null);
    renderer.fit(new Set([ev.source, ev.target]));
  }
  setInspector(
    el('h3', {}, ev.detail || ev.eventType),
    el('div', { class: 'cat' }, ev.demo ? 'DEMO event (sample, not real)' : 'recorded system event'),
    el('dl', { class: 'kv' },
      el('dt', {}, 'type'), el('dd', {}, ev.eventType),
      el('dt', {}, 'status'), el('dd', {}, el('b', { class: `st ${statusClass(ev.status)}` }, ev.status)),
      el('dt', {}, 'time'), el('dd', {}, new Date(ev.timestamp).toLocaleString()),
      ev.ms != null ? [el('dt', {}, 'took'), el('dd', {}, `${ev.ms} ms`)] : '',
      ev.jobId ? [el('dt', {}, 'job'), el('dd', {}, ev.jobId)] : ''),
    el('ul', { class: 'list conns' }, s ? nodeLine(s, 'source') : '', t ? nodeLine(t, 'destination') : ''));
}

function trace(a, b) {
  const p = store.shortestPath(a, b, { directed: true, flow: true }) || store.shortestPath(a, b);
  const A = store.get(a);
  const B = store.get(b);
  if (!p) { say(`No connection between ${A?.label} and ${B?.label} among the visible nodes.`, true); return; }
  renderer.setCluster(null);
  renderer.select([a, b], a);
  renderer.setPath(p);
  renderer.pulsePath(p);
  renderer.fit(new Set(p.nodes));
  ui.inspecting = { type: 'path' };
  setInspector(
    el('h3', {}, `Path · ${p.links.length} hop${p.links.length === 1 ? '' : 's'}`),
    el('div', { class: 'cat' }, `${A.label} → ${B.label}`),
    el('ul', { class: 'list conns' }, p.nodes.map((id, i) => nodeLine(store.get(id), i ? p.links[i - 1].relationship : 'start',
      i ? EDGE_TYPES[edgeType(p.links[i - 1])].color : null))));
  say(`Traced ${A.label} → ${B.label}: ${p.links.length} hops.`);
}

function clearSelection() {
  renderer.clear();
  ui.inspecting = null;
  ui.traceFrom = null;
  $('search').value = '';
  $('results').replaceChildren();
  renderFilters();
  setInspector(el('p', { class: 'hint' }, 'Click a node to focus it — it and its connections light up and its details appear here. Shift-click a second node to trace the shortest path. Ctrl/⌘-click to multi-select. Click a line to inspect a connection, or a cluster title to open the cluster.'));
}
function globalView() {
  if (flags.focus) setFlag('focus', false);
  clearSelection();
  renderer.fit();
}

renderer.on('select', (id, { additive }) => {
  if (ui.traceFrom && ui.traceFrom !== id) { const from = ui.traceFrom; ui.traceFrom = null; trace(from, id); return; }
  selectNode(id, { additive });
});
renderer.on('trace', (a, b) => trace(a, b));
renderer.on('edge', (l) => inspectEdge(l));
renderer.on('cluster', (cat) => inspectCluster(cat));
renderer.on('expand', (cat) => toggleCollapse(cat, false));
renderer.on('background', () => {
  const s = renderer.selection;
  if (s.ids.size || s.highlight || s.path || s.cluster || s.search.size) clearSelection();
});
renderer.on('hover', (n, l, x, y, cat) => {
  const tip = $('tip');
  if (!n && !l && !cat) { tip.hidden = true; return; }
  tip.replaceChildren(...(n
    ? [el('b', {}, n.label), el('span', {}, n.kind === 'cluster' ? `collapsed cluster · ${n.members} nodes · double-click to expand` : `${catLabel(n.category)} · ${n.status} · ${n.degree} links`)]
    : l ? [el('b', {}, `${l.relationship}`), el('span', {}, `${l.source.label} → ${l.target.label}`)]
      : [el('b', {}, catLabel(cat)), el('span', {}, 'cluster · click to focus')]));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, x + 14)}px`;
  tip.style.top = `${Math.min(window.innerHeight - r.height - 8, y + 14)}px`;
});

// ------------------------------------------------------------------ search
let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 90);
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = store.search(e.target.value)[0]; if (first) selectNode(first.id); }
  if (e.key === 'Escape') { clearSelection(); e.target.blur(); }
});
function runSearch() {
  const q = $('search').value;
  const hits = store.search(q);
  renderer.setCluster(null);
  renderer.setSearch(hits.map((n) => n.id));
  renderer.setHighlight(hits.length ? new Set(hits.map((n) => store.resolve(n.id))) : null);
  $('results').replaceChildren(...(q.trim() && !hits.length ? [el('li', { class: 'rel' }, 'No matching nodes.')] : hits.map((n) => {
    const li = nodeLine(n);
    li.firstChild.title = `${n.label} · ${catLabel(n.category)}`;
    return li;
  })));
  if (hits.length) renderer.fit(new Set(hits.map((n) => n.id)));
}

// ------------------------------------------------------------------ forces + display
const bind = (id, fn) => { const e = $(id); e.addEventListener('input', () => fn(e)); fn(e); };
bind('fRepel', (e) => renderer.setForces({ repel: +e.value }));
bind('fLink', (e) => renderer.setForces({ linkDistance: +e.value }));
bind('fCollide', (e) => renderer.setForces({ collide: +e.value }));
bind('fGravity', (e) => renderer.setForces({ gravity: +e.value / 100 }));
bind('dLinks', (e) => renderer.setDisplay({ links: e.checked }));
bind('dArrows', (e) => renderer.setDisplay({ arrows: e.checked }));
bind('dHulls', (e) => renderer.setDisplay({ hulls: e.checked }));
bind('dActive', (e) => renderer.setDisplay({ highlightActive: e.checked }));
bind('dSize', (e) => renderer.setDisplay({ nodeSize: +e.value / 100 }));
bind('dOpacity', (e) => renderer.setDisplay({ linkOpacity: +e.value / 100 }));
bind('dAnim', (e) => renderer.setDisplay({ anim: +e.value / 100 }));
for (const b of document.querySelectorAll('[data-labels]')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('[data-labels]')) o.setAttribute('aria-checked', String(o === b));
    renderer.setDisplay({ labels: b.dataset.labels });
  });
}
$('resetLayout').addEventListener('click', () => { renderer.resetLayout(); say('Layout reset: all nodes released and re-spread by cluster.'); });

// ------------------------------------------------------------------ toolbar
$('tbFit').addEventListener('click', () => renderer.fit());
$('tbIn').addEventListener('click', () => renderer.zoom(1.35));
$('tbOut').addEventListener('click', () => renderer.zoom(1 / 1.35));
$('tbNode').addEventListener('click', () => {
  const id = renderer.selection.primary;
  if (!id) return say('Select a node first.', true);
  renderer.focusNode(id, 2.2);
});
$('tbCluster').addEventListener('click', () => {
  const id = renderer.selection.primary;
  const n = id && store.get(id);
  if (!n) return say('Select a node first: its cluster will be focused.', true);
  inspectCluster(n.category);
});
$('tbGlobal').addEventListener('click', () => globalView());
$('tbPause').addEventListener('click', (e) => {
  renderer.freeze(!renderer.frozen);
  e.currentTarget.setAttribute('aria-pressed', String(renderer.frozen));
  e.currentTarget.textContent = renderer.frozen ? '▶ Resume' : '❚❚ Freeze';
});
$('tbDemo').addEventListener('click', () => setDemo(!demo.on));
function setDemo(on) {
  if (on) demo.start();
  else demo.stop();
  $('tbDemo').setAttribute('aria-pressed', String(on));
  $('tbDemo').textContent = on ? 'DEMO on' : 'DEMO off';
  $('demoBanner').hidden = !on;
  renderMode();
}

// ------------------------------------------------------------------ JARVIS controls
const FLAG_BTN = { eyes: 'jEyes', holo: 'jHolo', focus: 'jFocus', reflex: 'jReflex' };
function setFlag(name, on) {
  if (name === 'focus' && on && !renderer.selection.primary) { say('FOCUS needs a selected node: click one first.', true); return; }
  flags[name] = on;
  renderer.setFlags({ [name]: on });
  const b = $(FLAG_BTN[name]);
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('span').textContent = on ? (name === 'eyes' ? 'tracking' : 'on') : 'off';
  if (name === 'focus') {
    const id = store.resolve(renderer.selection.primary || '');
    if (on) renderer.fit(new Set([id, ...store.neighbors(id).map((a) => a.other.id)]));
    else renderer.fit();
    if (ui.inspecting?.type === 'node') inspectNode(ui.inspecting.id, { keepCamera: true });
  }
  if (name === 'holo') document.body.classList.toggle('flat', !on);
}
for (const [name, id] of Object.entries(FLAG_BTN)) $(id).addEventListener('click', () => setFlag(name, !flags[name]));

// ------------------------------------------------------------------ command bar
const say = (text, err = false) => { const o = $('cmdOut'); o.textContent = text; o.classList.toggle('err', err); };
$('chips').replaceChildren(...EXAMPLES.slice(0, 8).map((x) => el('button', { type: 'button', onclick: () => { $('cmd').value = x; run(x); } }, x)));
$('cmdForm').addEventListener('submit', (e) => { e.preventDefault(); run($('cmd').value); });

function best(term) {
  const alias = ALIASES[term.trim().toLowerCase().replace(/^the\s+/, '')];
  if (alias && store.byId.has(alias)) return store.byId.get(alias);
  const cat = categoryWord(term);
  const hits = store.search(term.replace(/\b(the|service|services|node|component)\b/g, '').trim() || term);
  if (cat && (!hits.length || !hits[0].label.toLowerCase().includes(term.trim()))) {
    const n = store.nodes.filter((x) => x.category === cat).sort((a, b) => b.degree - a.degree)[0];
    if (n) return n;
  }
  return hits[0] || null;
}

function run(text) {
  const c = parse(text);
  switch (c.type) {
    case 'none': return;
    case 'help':
      return say(`Commands: ${EXAMPLES.join(' · ')}. Also "show <name>", "trace <a> to <b>", "show <category> architecture", "collapse <cluster>", "expand <cluster>".`);
    case 'reset':
      setFlag('focus', false);
      store.hidden.clear();
      store.collapsed.clear();
      afterFilter();
      clearSelection();
      renderer.fit();
      return say('Network reset: all clusters shown and expanded, selection cleared.');
    case 'fit':
      renderer.fit();
      return say('Showing the whole network.');
    case 'collapse':
    case 'expand': {
      const cat = categoryWord(c.term);
      if (!cat) return say(`Unknown cluster "${c.term}".`, true);
      return toggleCollapse(cat, c.type === 'collapse');
    }
    case 'disconnected': {
      const comps = store.components();
      const loose = comps.slice(1).flat();
      if (!loose.length) return say(`All ${comps[0]?.length || 0} visible nodes are connected in one network.`);
      renderer.clear();
      renderer.setHighlight(new Set(loose));
      renderer.setSearch(loose);
      renderer.fit(new Set(loose));
      $('results').replaceChildren(...loose.map((id) => nodeLine(store.get(id), 'disconnected')));
      return say(`${comps.length - 1} separate component(s), ${loose.length} node(s) not connected to the main network (listed under Search).`);
    }
    case 'active': {
      const ids = store.nodes.filter((n) => ['real', 'mock', 'verified'].includes(n.status) || store.isActive(n.id, 5 * 60000)).map((n) => n.id);
      renderer.clear();
      renderer.setHighlight(new Set(ids.map(store.resolve)));
      renderer.setSearch(ids);
      renderer.fit(new Set(ids));
      $('results').replaceChildren(...ids.map((id) => nodeLine(store.byId.get(id), store.byId.get(id).status)));
      return say(`${ids.length} active: services in real/mock mode, verified externals and nodes with events in the last 5 minutes.`);
    }
    case 'trace': {
      const a = best(c.from);
      const b = best(c.to);
      if (!a || !b) return say(`Could not find "${!a ? c.from : c.to}".`, true);
      return trace(a.id, b.id);
    }
    case 'connections': {
      const cat = categoryWord(c.term);
      const base = cat ? store.nodes.filter((n) => n.category === cat) : [best(c.term)].filter(Boolean);
      if (!base.length) return say(`Nothing matches "${c.term}".`, true);
      if (cat && store.hidden.has(cat)) toggleCategory(cat, true);
      const set = new Set(base.map((n) => store.resolve(n.id)));
      for (const id of [...set]) for (const a of store.neighbors(id)) set.add(a.other.id);
      renderer.clear();
      renderer.select(base.map((n) => n.id), base[0].id);
      renderer.setHighlight(set);
      renderer.fit(set);
      return say(`${base.length} ${cat ? catLabel(cat) : base[0].label} node(s) with ${set.size - base.length} connected node(s) lit.`);
    }
    case 'architecture': {
      const cat = categoryWord(c.term);
      const groups = cat === 'backend' ? ['entry', 'backend', 'api', 'auth', 'database', 'processing', 'external']
        : cat === 'frontend' ? ['frontend', 'admin', 'auth', 'api', 'entry'] : cat ? [cat] : null;
      if (!groups) return say(`Unknown area "${c.term}". Try backend, frontend, database, ai, whatsapp…`, true);
      store.hidden = new Set(Object.keys(store.categories).filter((k) => !groups.includes(k)));
      afterFilter();
      clearSelection();
      setTimeout(() => renderer.fit(), 900);
      return say(`Showing ${groups.filter((g) => store.categories[g]).map(catLabel).join(', ')}. "reset network" shows everything again.`);
    }
    case 'focus':
    case 'find': {
      const cat = categoryWord(c.term);
      if (c.type === 'focus' && cat && /cluster/.test(text)) return inspectCluster(cat);
      const n = best(c.term);
      if (!n) return say(`No node matches "${c.term}".`, true);
      selectNode(n.id);
      if (c.type === 'focus' && !flags.focus) setFlag('focus', true);
      renderer.focusNode(n.id, 1.8);
      return say(`${c.type === 'focus' ? 'Focused on' : 'Found'} ${n.label} (${catLabel(n.category)}).`);
    }
    default:
      return say('Unknown command. Type "help".', true);
  }
}

// ------------------------------------------------------------------ mobile drawers + keys
function openPanel(which) {
  for (const p of ['left', 'right']) $(p).classList.toggle('open', p === which);
  $('scrim').hidden = !which;
}
$('openLeft').addEventListener('click', () => openPanel($('left').classList.contains('open') ? null : 'left'));
$('openRight').addEventListener('click', () => openPanel($('right').classList.contains('open') ? null : 'right'));
$('scrim').addEventListener('click', () => openPanel(null));
$('fAll').addEventListener('click', () => { store.hidden.clear(); afterFilter(); });
$('fNone').addEventListener('click', () => { store.hidden = new Set(Object.keys(store.categories)); afterFilter(); });
$('fExpand').addEventListener('click', () => { store.collapsed.clear(); afterFilter(); });

window.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); }
  else if (e.key === 'Escape') { clearSelection(); openPanel(null); }
  else if (!typing && (e.key === 'f' || e.key === 'F')) renderer.fit();
  else if (!typing && (e.key === 'g' || e.key === 'G')) globalView();
});
setInterval(() => { $('stUpdated').textContent = ago(ui.lastTopoAt); }, 5000);

boot();
// exposed for debugging in the browser console only
window.__nv = { store, renderer, run };
