// Graph data model: topology, filters, clusters (collapse/expand), adjacency, events and graph
// algorithms. No rendering here. Clusters are the code-derived categories - nothing invented.

const STATUS_CLASS = {
  ok: ['verified', 'real', 'loaded', 'mounted', 'set', 'reachable', 'installed', 'ok'],
  warn: ['mock', 'mock (local JSON)', 'mock store', 'configured', 'configured · unverified', 'unverified', 'info', 'pending'],
  bad: ['error', 'missing', 'not configured', 'empty'],
  off: ['disabled', 'not loaded', 'present', 'template', 'state', 'external', 'static', 'cluster'],
};
export function statusClass(s) {
  for (const [cls, list] of Object.entries(STATUS_CLASS)) if (list.includes(s)) return cls;
  return 'unk';
}

// Relationship -> edge type (colour + legend). Order matters: first match wins.
export const EDGE_TYPES = {
  data: { label: 'Reads / writes data', color: '#facc15', rels: ['reads', 'writes', 'queries', 'uploads to', 'reads from', 'stores files', 'state', 'sets'] },
  external: { label: 'Calls an external API', color: '#f87171', rels: ['calls', 'connects to', 'hosted on', 'runs', 'delivers webhook'] },
  route: { label: 'Routes / renders', color: '#22d3ee', rels: ['defines', 'renders', 'includes', 'uses', 'opens', 'mounts'] },
  config: { label: 'Configuration', color: '#64748b', rels: ['configures'] },
  imports: { label: 'Imports (code)', color: '#7c93c9', rels: ['imports'] },
};
export function edgeType(l) {
  if (l.aggregate) return 'imports';
  if (l.relationship === 'reads' && l.target.kind === 'env') return 'config';
  for (const [k, t] of Object.entries(EDGE_TYPES)) if (t.rels.includes(l.relationship)) return k;
  return 'imports';
}

// Kinds that are wiring, not data flow: avoided when routing a flow between two components.
const NOT_FLOW = new Set(['config', 'packages', 'tests']);

export function createStore() {
  const s = {
    version: null,
    categories: {},
    nodes: [], // simulation objects (stable across topology updates, keyed by id)
    links: [],
    byId: new Map(),
    adj: new Map(), // full graph: id -> [{ link, other, dir }]
    hidden: new Set(), // hidden categories
    collapsed: new Set(), // categories shown as one cluster node
    clusterNodes: new Map(), // category -> aggregate node (keeps its position)
    events: [],
    lastActive: new Map(), // node id -> ms of its last event
  };
  let view = null;
  s.invalidate = () => { view = null; };

  /** Returns true when the structure changed (simulation must be rebuilt), false for a status-only refresh. */
  s.setTopology = (topo) => {
    if (topo.version === s.version) {
      for (const n of topo.nodes) {
        const o = s.byId.get(n.id);
        if (o) Object.assign(o, { status: n.status, description: n.description, metadata: n.metadata });
      }
      return false;
    }
    const old = s.byId;
    s.version = topo.version;
    s.categories = topo.categories;
    s.byId = new Map();
    s.nodes = topo.nodes.map((n) => {
      const prev = old.get(n.id);
      const o = prev ? Object.assign(prev, n) : { ...n };
      s.byId.set(n.id, o);
      return o;
    });
    s.links = topo.edges.map((e) => ({ ...e, source: s.byId.get(e.source), target: s.byId.get(e.target) }))
      .filter((l) => l.source && l.target);
    s.adj = new Map(s.nodes.map((n) => [n.id, []]));
    for (const l of s.links) {
      s.adj.get(l.source.id).push({ link: l, other: l.target, dir: 'out' });
      s.adj.get(l.target.id).push({ link: l, other: l.source, dir: 'in' });
    }
    for (const n of s.nodes) n.degree = s.adj.get(n.id).length;
    // New nodes start next to a neighbour (or their cluster) that already has a position
    for (const n of s.nodes) {
      if (n.x != null) continue;
      const nb = s.adj.get(n.id).map((a) => a.other).find((o) => o.x != null)
        || s.nodes.find((o) => o.category === n.category && o.x != null);
      if (nb) {
        n.x = nb.x + (Math.random() - 0.5) * 40;
        n.y = nb.y + (Math.random() - 0.5) * 40;
      }
    }
    for (const c of s.clusterNodes.keys()) if (!s.nodes.some((n) => n.category === c)) { s.clusterNodes.delete(c); s.collapsed.delete(c); }
    s.invalidate();
    return true;
  };

  // ---------------------------------------------------------------- the visible graph
  const clusterId = (cat) => `cluster:${cat}`;
  /** The id a node is drawn as right now (its cluster node when that cluster is collapsed). */
  s.resolve = (id) => {
    const n = s.byId.get(id);
    return n && s.collapsed.has(n.category) ? clusterId(n.category) : id;
  };
  /** Any node by id, including cluster nodes. */
  s.get = (id) => s.byId.get(id) || (id?.startsWith('cluster:') ? s.clusterNodes.get(id.slice(8)) : undefined);
  s.isVisible = (n) => !!n && !s.hidden.has(n.category);
  s.members = (cat) => s.nodes.filter((n) => n.category === cat);

  function buildView() {
    const nodes = [];
    const counts = {};
    for (const n of s.nodes) {
      if (s.hidden.has(n.category)) continue;
      if (s.collapsed.has(n.category)) { counts[n.category] = (counts[n.category] || 0) + 1; continue; }
      nodes.push(n);
    }
    for (const [cat, count] of Object.entries(counts)) {
      let c = s.clusterNodes.get(cat);
      const members = s.members(cat).filter((m) => m.x != null);
      if (!c) {
        c = { id: clusterId(cat), kind: 'cluster', category: cat, status: 'cluster', description: '', metadata: {} };
        if (members.length) {
          c.x = members.reduce((a, m) => a + m.x, 0) / members.length;
          c.y = members.reduce((a, m) => a + m.y, 0) / members.length;
        }
        s.clusterNodes.set(cat, c);
      }
      Object.assign(c, { label: `${s.categories[cat]?.label || cat} (${count})`, members: count });
      nodes.push(c);
    }
    const links = [];
    const merged = new Map();
    for (const l of s.links) {
      if (s.hidden.has(l.source.category) || s.hidden.has(l.target.category)) continue;
      const a = s.resolve(l.source.id);
      const b = s.resolve(l.target.id);
      if (a === b) continue;
      if (a === l.source.id && b === l.target.id) { links.push(l); continue; }
      const key = `${a}|${b}`;
      let m = merged.get(key);
      if (!m) {
        m = { id: `agg:${key}`, source: s.get(a), target: s.get(b), relationship: 'links', aggregate: true, count: 0, rels: new Set(), status: 'static' };
        merged.set(key, m);
        links.push(m);
      }
      m.count++;
      m.rels.add(l.relationship);
    }
    for (const m of merged.values()) m.relationship = m.count === 1 ? [...m.rels][0] : `${m.count} links`;
    const adj = new Map(nodes.map((n) => [n.id, []]));
    const between = new Map();
    for (const l of links) {
      adj.get(l.source.id)?.push({ link: l, other: l.target, dir: 'out' });
      adj.get(l.target.id)?.push({ link: l, other: l.source, dir: 'in' });
      between.set(`${l.source.id}|${l.target.id}`, l);
    }
    for (const n of nodes) n.viewDegree = adj.get(n.id).length;
    for (const c of s.clusterNodes.values()) c.degree = c.viewDegree || 0;
    return { nodes, links, adj, between };
  }
  s.view = () => (view ||= buildView());
  s.visibleNodes = () => s.view().nodes;
  s.visibleLinks = () => s.view().links;
  s.neighbors = (id) => s.view().adj.get(id) || [];
  s.linkBetween = (a, b) => s.view().between.get(`${a}|${b}`) || s.view().between.get(`${b}|${a}`) || null;

  s.categoryCounts = () => {
    const c = {};
    for (const n of s.nodes) c[n.category] = (c[n.category] || 0) + 1;
    return c;
  };

  s.hubs = (n = 8) => s.visibleNodes()
    .filter((x) => x.kind !== 'cluster')
    .map((x) => ({ node: x, count: s.neighbors(x.id).length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);

  /** Ranked search over label, id, category, description. */
  s.search = (q, limit = 14) => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    const words = t.split(/\s+/);
    const scored = [];
    for (const n of s.nodes) {
      const label = n.label.toLowerCase();
      const hay = `${label} ${n.id.toLowerCase()} ${(s.categories[n.category]?.label || '').toLowerCase()} ${n.description.toLowerCase()}`;
      if (!words.every((w) => hay.includes(w))) continue;
      let score = 0;
      if (label === t) score += 100;
      if (label.startsWith(t)) score += 40;
      if (label.includes(t)) score += 25;
      if (n.id.toLowerCase().includes(t)) score += 10;
      score += Math.min(20, n.degree);
      if (!s.isVisible(n)) score -= 30;
      scored.push([score, n]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
  };

  /**
   * Shortest path between two node ids over the VISIBLE graph (collapsed clusters count as one hop).
   * directed: follow edge direction only. flow: avoid config/packages/tests hubs.
   */
  s.shortestPath = (fromId, toId, { directed = false, flow = false } = {}) => {
    const from = s.resolve(fromId);
    const to = s.resolve(toId);
    const { adj } = s.view();
    if (!adj.has(from) || !adj.has(to) || from === to) return null;
    const ok = (n) => !flow || !NOT_FLOW.has(n.category) || n.id === to || n.id === from;
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length) {
      const id = q.shift();
      if (id === to) break;
      for (const a of adj.get(id) || []) {
        if (directed && a.dir !== 'out') continue;
        if (prev.has(a.other.id) || !ok(a.other)) continue;
        prev.set(a.other.id, { id, link: a.link });
        q.push(a.other.id);
      }
    }
    if (!prev.has(to)) return null;
    const nodes = [];
    const links = [];
    for (let cur = to; cur != null;) {
      nodes.unshift(cur);
      const p = prev.get(cur);
      if (!p) break;
      links.unshift(p.link);
      cur = p.id;
    }
    return { nodes, links };
  };

  /** Connected components of the visible graph, largest first. */
  s.components = () => {
    const seen = new Set();
    const comps = [];
    for (const n of s.visibleNodes()) {
      if (seen.has(n.id)) continue;
      const comp = [];
      const stack = [n.id];
      seen.add(n.id);
      while (stack.length) {
        const id = stack.pop();
        comp.push(id);
        for (const a of s.neighbors(id)) if (!seen.has(a.other.id)) { seen.add(a.other.id); stack.push(a.other.id); }
      }
      comps.push(comp);
    }
    return comps.sort((a, b) => b.length - a.length);
  };

  /** Cluster facts for the inspector: members, internal links, links to other clusters. */
  s.clusterInfo = (cat) => {
    const members = s.members(cat);
    const ids = new Set(members.map((m) => m.id));
    let internal = 0;
    const outside = {};
    for (const l of s.links) {
      const a = ids.has(l.source.id);
      const b = ids.has(l.target.id);
      if (a && b) internal++;
      else if (a || b) {
        const other = (a ? l.target : l.source).category;
        outside[other] = (outside[other] || 0) + 1;
      }
    }
    return { members, internal, outside: Object.entries(outside).sort((x, y) => y[1] - x[1]) };
  };

  s.addEvent = (ev) => {
    s.events.push(ev);
    if (s.events.length > 400) s.events.shift();
    const t = Date.parse(ev.timestamp) || Date.now();
    s.lastActive.set(ev.source, t);
    s.lastActive.set(ev.target, t);
  };
  s.eventsFor = (id, n = 8) => s.events.filter((e) => e.source === id || e.target === id).slice(-n).reverse();
  s.isActive = (id, withinMs = 10000) => {
    if (id.startsWith('cluster:')) return s.members(id.slice(8)).some((m) => s.isActive(m.id, withinMs));
    return Date.now() - (s.lastActive.get(id) || 0) < withinMs;
  };

  return s;
}
