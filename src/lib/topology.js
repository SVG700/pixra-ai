'use strict';
// Builds the architecture graph for /network-visualizer FROM THE CODE, nothing hand-drawn:
//   files      every .js / .ejs under src/, scripts/ and tests/ (description = the file's header comment)
//   imports    require('./x') between them, require('<package>') to npm packages
//   routes     router.get/post(...) per route file + its mount prefix in app.js; what each route
//              handler renders and which imported modules it uses
//   database   tables from schema.sql, which db methods touch which table (services/db/supabase.js)
//              and which files call those methods; job statuses from the jobs.status check
//   external   API hosts found in the code, AI model names and env var NAMES from config.js
// Status comes from the running process (services/select.js modes, require.cache, telemetry) -
// a service is only "verified" after a real call to it succeeded. Never includes secret values.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const ROOT = config.root;
const SRC = path.join(ROOT, 'src');

const CATEGORIES = {
  entry: { label: 'Entry points', color: '#f5f5f5' },
  whatsapp: { label: 'WhatsApp', color: '#25d366' },
  telegram: { label: 'Telegram', color: '#2aabee' },
  frontend: { label: 'Frontend', color: '#5b8cff' },
  backend: { label: 'Backend', color: '#3fa7ff' },
  api: { label: 'API routes', color: '#22d3ee' },
  processing: { label: 'Processing', color: '#a78bfa' },
  ai: { label: 'AI models', color: '#e879f9' },
  database: { label: 'Database', color: '#facc15' },
  storage: { label: 'Storage', color: '#fb923c' },
  admin: { label: 'Admin dashboard', color: '#f472b6' },
  auth: { label: 'Authentication', color: '#bef264' },
  workflow: { label: 'Workflows', color: '#34d399' },
  output: { label: 'Output & delivery', color: '#4ade80' },
  external: { label: 'External services', color: '#f87171' },
  config: { label: 'Config (env names)', color: '#94a3b8' },
  packages: { label: 'npm packages', color: '#64748b' },
  tests: { label: 'Tests & scripts', color: '#475569' },
};

// Paths are checked in order; first match wins.
const FILE_CATEGORY = [
  [/^src\/(server|app)\.js$/, 'entry'],
  [/^src\/routes\/webhook\.js$|^src\/services\/whatsapp\//, 'whatsapp'],
  [/^src\/routes\/telegram\.js$|^src\/services\/telegram\//, 'telegram'],
  [/^src\/lib\/session\.js$|^src\/views\/.*login\.ejs$/, 'auth'],
  [/^src\/routes\/admin\.js$|^src\/views\/admin\//, 'admin'],
  [/^src\/views\//, 'frontend'],
  [/^src\/pipeline\/(review|revisions)\.js$/, 'workflow'],
  [/^src\/pipeline\/outbound\.js$/, 'output'],
  [/^src\/pipeline\/|^src\/services\/poster\/|^src\/templates\//, 'processing'],
  [/^src\/services\/(gemini|cloudflare|images)\//, 'ai'],
  [/^src\/services\/db\//, 'database'],
  [/^(tests|scripts)\//, 'tests'],
  [/^src\//, 'backend'],
];

const EXTERNALS = {
  'ext:google-gemini': { label: 'Google Gemini API', mode: 'gemini', desc: 'generativelanguage.googleapis.com - brief extraction, replies, image prompts and poster QA.' },
  'ext:cloudflare': { label: 'Cloudflare Workers AI', mode: 'cloudflare', desc: 'api.cloudflare.com - FLUX poster backgrounds and Whisper voice-note transcription.' },
  'ext:meta-whatsapp': { label: 'Meta WhatsApp Cloud API', mode: 'whatsapp', desc: 'graph.facebook.com - inbound webhook and outbound messages/media.' },
  'ext:telegram': { label: 'Telegram Bot API', mode: 'telegram', desc: 'api.telegram.org - webhook or long polling, outbound messages.' },
  'ext:huggingface': { label: 'Hugging Face Inference', mode: 'huggingface', desc: 'Optional second poster-background provider (IMAGE_PROVIDER).' },
  'ext:supabase': { label: 'Supabase (Postgres + Storage)', mode: 'db', desc: 'Hosted Postgres tables and the poster storage bucket.' },
};
const HOST_TO_EXT = [
  [/generativelanguage\.googleapis\.com/, 'ext:google-gemini'], [/api\.cloudflare\.com/, 'ext:cloudflare'],
  [/graph\.facebook\.com/, 'ext:meta-whatsapp'], [/api\.telegram\.org/, 'ext:telegram'],
];
const PACKAGE_TO_EXT = { '@supabase/supabase-js': 'ext:supabase', '@huggingface/inference': 'ext:huggingface' };
// env var prefix -> the module that consumes it
const ENV_OWNER = [
  [/^GEMINI_/, 'file:src/services/gemini/index.js'], [/^CF_/, 'file:src/services/cloudflare/index.js'],
  [/^(WHATSAPP_|GRAPH_|WEBHOOK_)/, 'file:src/services/whatsapp/index.js'], [/^TELEGRAM_/, 'file:src/services/telegram/index.js'],
  [/^SUPABASE_/, 'file:src/services/db/index.js'], [/^(HF_|IMAGE_)/, 'file:src/services/images/index.js'],
  [/^(ADMIN_|SESSION_)/, 'file:src/routes/admin.js'], [/^DEMO_/, 'file:src/routes/demo.js'],
];
const SERVICE_MODE_FILE = {
  'file:src/services/gemini/index.js': 'gemini', 'file:src/services/cloudflare/index.js': 'cloudflare',
  'file:src/services/whatsapp/index.js': 'whatsapp', 'file:src/services/telegram/index.js': 'telegram',
  'file:src/services/db/index.js': 'db', 'file:src/services/images/huggingface.js': 'huggingface',
};

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const fid = (r) => `file:${r}`;

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

// First comment block of a file (after 'use strict'), as its description.
function headerComment(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length && (/^\s*$/.test(lines[i]) || /^['"]use strict['"]/.test(lines[i]) || /^#!/.test(lines[i]))) i++;
  if (/^\s*\/\*/.test(lines[i] || '')) {
    for (; i < lines.length; i++) {
      out.push(lines[i].replace(/^\s*\/?\*+\/?\s?/, '').replace(/\*\/\s*$/, ''));
      if (/\*\//.test(lines[i])) break;
    }
  } else {
    for (; i < lines.length && /^\s*\/\//.test(lines[i]); i++) out.push(lines[i].replace(/^\s*\/\/\s?/, ''));
  }
  const ejs = text.match(/<%#\s*([\s\S]*?)%>/);
  if (!out.length && ejs) out.push(ejs[1]);
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function resolveRequire(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const c of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function build() {
  const nodes = new Map();
  const edges = new Map();
  const node = (id, props) => {
    const cur = nodes.get(id);
    if (cur) return Object.assign(cur, props, { metadata: { ...cur.metadata, ...(props.metadata || {}) } });
    const n = { id, label: id, category: 'backend', description: '', status: 'present', metadata: {}, ...props };
    nodes.set(id, n);
    return n;
  };
  const edge = (source, target, relationship) => {
    if (!source || !target || source === target) return;
    const id = `${source}|${target}|${relationship}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, relationship, status: 'static' });
  };

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // ---------------------------------------------------------------- files + imports
  const files = [...walk(SRC, ['.js', '.ejs']), ...walk(path.join(ROOT, 'scripts'), ['.js']), ...walk(path.join(ROOT, 'tests'), ['.js'])];
  const texts = new Map();
  for (const abs of files) {
    const r = rel(abs);
    const text = fs.readFileSync(abs, 'utf8');
    texts.set(abs, text);
    const category = (FILE_CATEGORY.find(([re]) => re.test(r)) || [null, 'backend'])[1];
    const isView = abs.endsWith('.ejs');
    node(fid(r), {
      label: isView ? r.replace(/^src\/views\//, '').replace(/\.ejs$/, '') + '.ejs' : r.replace(/^src\//, ''),
      category,
      kind: isView ? 'view' : 'module',
      description: headerComment(text) || (isView ? 'EJS template' : ''),
      status: isView ? 'template' : require.cache[abs] ? 'loaded' : 'present',
      metadata: { path: r, lines: text.split('\n').length },
    });
  }
  // require('x') -> name bindings, used for route-level "uses" edges
  const bindings = new Map(); // abs -> [{ names, target }]
  for (const [abs, text] of texts) {
    if (!abs.endsWith('.js')) continue;
    const from = fid(rel(abs));
    const list = [];
    const re = /(?:(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[2];
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      const relName = /app\.use\([^)]*$/.test(before) || /app\.use\(\s*$/.test(before) ? 'mounts' : 'imports';
      let target = null;
      if (spec.startsWith('.')) {
        const t = resolveRequire(abs, spec);
        if (t) target = fid(rel(t));
      } else {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (deps[name]) {
          target = `pkg:${name}`;
          node(target, { label: name, category: 'packages', kind: 'package', description: `npm dependency ${name}@${deps[name]}`, status: 'installed', metadata: { version: deps[name] } });
          if (PACKAGE_TO_EXT[name]) edge(target, PACKAGE_TO_EXT[name], 'connects to');
        }
      }
      if (!target) continue;
      edge(from, target, relName);
      if (m[1]) list.push({ names: m[1].replace(/[{}\s]/g, '').split(',').map((s) => s.split(':').pop()).filter(Boolean), target });
    }
    bindings.set(abs, list);
  }
  // EJS includes
  for (const [abs, text] of texts) {
    if (!abs.endsWith('.ejs')) continue;
    for (const m of text.matchAll(/include\(\s*['"]([^'"]+)['"]/g)) {
      const t = path.resolve(path.dirname(abs), m[1].endsWith('.ejs') ? m[1] : `${m[1]}.ejs`);
      if (fs.existsSync(t)) edge(fid(rel(abs)), fid(rel(t)), 'includes');
    }
  }

  // ---------------------------------------------------------------- routes
  const appText = texts.get(path.join(SRC, 'app.js')) || '';
  const mounts = {}; // route file abs -> prefix
  for (const m of appText.matchAll(/app\.use\(\s*(?:['"]([^'"]+)['"]\s*,\s*)?require\(\s*['"](\.\/routes\/[^'"]+)['"]\s*\)/g)) {
    const t = resolveRequire(path.join(SRC, 'app.js'), m[2]);
    if (t) mounts[t] = m[1] || '';
  }
  const routeFiles = [[path.join(SRC, 'app.js'), '', 'app'], ...Object.entries(mounts).map(([f, p]) => [f, p, 'router'])];
  for (const [abs, prefix, obj] of routeFiles) {
    const text = texts.get(abs) || '';
    const base = (text.match(/const BASE = '([^']+)'/) || [])[1] || ''; // routes written as `${BASE}/x`
    const re = new RegExp(`${obj}\\.(get|post|put|patch|delete|all)\\(\\s*(?:['"\`]([^'"\`]+)['"\`]|BASE\\b)`, 'g');
    const found = [...text.matchAll(re)];
    found.forEach((m, i) => {
      const method = m[1].toUpperCase();
      const sub = (m[2] ?? base).replace('${BASE}', base);
      const full = `${prefix}${sub === '/' && prefix ? '' : sub}` || '/';
      const id = `route:${method} ${full}`;
      const line = text.slice(0, m.index).split('\n').length;
      const dev = prefix === '/dev';
      node(id, {
        label: `${method} ${full}`, category: /\/(login|logout)$/.test(full) ? 'auth' : 'api', kind: 'route',
        description: `HTTP endpoint ${method} ${full}, defined in ${rel(abs)}:${line}.${dev ? ' Only answers when DEV_MODE=true.' : ''}`,
        status: dev && !config.devMode ? 'disabled' : 'mounted',
        metadata: { method, path: full, file: rel(abs), line },
      });
      edge(fid(rel(abs)), id, 'defines');
      // What this handler does: the code up to the next route definition
      const body = text.slice(m.index, found[i + 1]?.index ?? text.length);
      for (const v of body.matchAll(/res\.render\(\s*['"]([^'"]+)['"]/g)) {
        const view = fid(`src/views/${v[1]}.ejs`);
        if (nodes.has(view)) edge(id, view, 'renders');
      }
      for (const b of bindings.get(abs) || []) {
        if (b.names.some((n) => new RegExp(`\\b${n.replace('$', '\\$')}\\s*[.(]`).test(body))) edge(id, b.target, 'uses');
      }
    });
  }
  if (nodes.has('route:POST /webhook')) edge('ext:meta-whatsapp', 'route:POST /webhook', 'delivers webhook');
  if (nodes.has('route:POST /telegram/webhook')) edge('ext:telegram', 'route:POST /telegram/webhook', 'delivers webhook');
  node('client:browser', {
    label: 'Browser clients', category: 'entry', kind: 'client', status: 'external',
    description: 'Admin portal, the /demo customer web chat and the /dev simulator, used from a browser.',
  });
  for (const r of ['route:GET /admin', 'route:GET /demo', 'route:GET /dev/chat', 'route:GET /network-visualizer']) if (nodes.has(r)) edge('client:browser', r, 'opens');

  // ---------------------------------------------------------------- database + storage
  const schemaPath = path.join(ROOT, 'schema.sql');
  const schema = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : '';
  for (const m of schema.matchAll(/create table if not exists public\.(\w+)/g)) {
    node(`table:${m[1]}`, { label: `${m[1]} table`, category: 'database', kind: 'table', description: `Postgres table public.${m[1]} (schema.sql).`, status: 'unverified', metadata: { table: m[1] } });
    edge('file:src/services/db/supabase.js', `table:${m[1]}`, 'queries');
    edge(`table:${m[1]}`, 'ext:supabase', 'hosted on');
  }
  const statusBlock = schema.match(/status\s+text[^\n]*check \(status in \(([\s\S]*?)\)\)/);
  for (const s of statusBlock ? [...statusBlock[1].matchAll(/'(\w+)'/g)].map((x) => x[1]) : []) {
    node(`status:${s}`, { label: `job: ${s}`, category: 'workflow', kind: 'job-status', description: `Job lifecycle state "${s}" (jobs.status check constraint).`, status: 'state' });
    edge('table:jobs', `status:${s}`, 'state');
  }
  // db method -> tables it touches
  const supa = texts.get(path.join(SRC, 'services/db/supabase.js')) || '';
  const methodTables = {};
  let current = null;
  for (const line of supa.split('\n')) {
    const h = line.match(/^ {4}(?:async\s+)?(\w+)(?::\s*(?:async\s*)?\(|\()/);
    if (h) current = h[1];
    if (!current) continue;
    for (const f of line.matchAll(/from\('(\w+)'\)/g)) (methodTables[current] ||= new Set()).add(f[1]);
    if (/storage/.test(line)) (methodTables[current] ||= new Set()).add('__bucket');
  }
  const bucket = `storage:${config.supabase.bucket}`;
  node(bucket, { label: `${config.supabase.bucket} bucket`, category: 'storage', kind: 'bucket', description: 'Supabase Storage bucket for poster images, backgrounds and logos.', status: 'unverified' });
  edge('file:src/services/db/supabase.js', bucket, 'stores files');
  edge(bucket, 'ext:supabase', 'hosted on');
  node('storage:local-uploads', { label: 'local uploads/ + data/db.json', category: 'storage', kind: 'local', description: 'Mock storage used only when MOCK_MODE=true outside production.', status: 'mock store' });
  edge('file:src/services/db/local-json.js', 'storage:local-uploads', 'stores files');
  for (const [abs, text] of texts) {
    if (!abs.endsWith('.js') || !abs.startsWith(SRC) || abs.includes(`${path.sep}services${path.sep}db${path.sep}`)) continue;
    const from = fid(rel(abs));
    for (const m of text.matchAll(/\bdb\.(\w+)\(/g)) {
      for (const t of methodTables[m[1]] || []) {
        const target = t === '__bucket' ? bucket : `table:${t}`;
        const write = /^(create|update|insert|upsert|delete|upload|set|save)/i.test(m[1]);
        edge(from, target, t === '__bucket' ? (write ? 'uploads to' : 'reads from') : write ? 'writes' : 'reads');
      }
    }
    for (const m of text.matchAll(/status:\s*'(\w+)'/g)) if (nodes.has(`status:${m[1]}`)) edge(from, `status:${m[1]}`, 'sets');
  }

  // ---------------------------------------------------------------- external services
  for (const [id, e] of Object.entries(EXTERNALS)) {
    node(id, { label: e.label, category: 'external', kind: 'external', description: e.desc, status: 'unverified', metadata: { mode: e.mode } });
  }
  for (const [abs, text] of texts) {
    if (!abs.startsWith(SRC)) continue;
    for (const [re, id] of HOST_TO_EXT) if (re.test(text)) edge(fid(rel(abs)), id, 'calls');
  }
  // AI models (names only)
  const models = [
    ['model:gemini', config.gemini.model, 'Gemini text model', 'file:src/services/gemini/gemini.js', 'ext:google-gemini'],
    ['model:gemini-fallback', config.gemini.fallbackModel, 'Gemini fallback model', 'file:src/services/gemini/gemini.js', 'ext:google-gemini'],
    ['model:cf-image', config.cloudflare.imageModel, 'Cloudflare image model', 'file:src/services/cloudflare/workers-ai.js', 'ext:cloudflare'],
    ['model:cf-whisper', config.cloudflare.whisperModel, 'Cloudflare speech-to-text', 'file:src/services/cloudflare/workers-ai.js', 'ext:cloudflare'],
    ['model:hf-image', config.huggingface.imageModel, 'Hugging Face image model', 'file:src/services/images/huggingface.js', 'ext:huggingface'],
  ];
  for (const [id, name, what, owner, ext] of models) {
    if (!name) continue;
    node(id, { label: name, category: 'ai', kind: 'model', description: `${what} (from config).`, status: 'unverified', metadata: { model: name } });
    edge(owner, id, 'runs');
    edge(id, ext, 'hosted on');
  }
  // env var names (never values) from config.js
  const cfgText = texts.get(path.join(SRC, 'config.js')) || '';
  for (const name of new Set([...cfgText.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))) {
    const id = `env:${name}`;
    const set = typeof process.env[name] === 'string' && process.env[name].trim() !== '';
    node(id, { label: name, category: 'config', kind: 'env', description: `Environment variable ${name} (value never shown).`, status: set ? 'set' : 'empty' });
    edge('file:src/config.js', id, 'reads');
    const owner = (ENV_OWNER.find(([re]) => re.test(name)) || [null, null])[1];
    if (owner && nodes.has(owner)) edge(id, owner, 'configures');
  }

  // drop dangling edges, compute degrees
  for (const [id, e] of edges) if (!nodes.has(e.source) || !nodes.has(e.target)) edges.delete(id);
  const list = [...nodes.values()];
  const links = [...edges.values()];
  const deg = Object.fromEntries(list.map((n) => [n.id, { in: 0, out: 0 }]));
  for (const e of links) {
    deg[e.source].out++;
    deg[e.target].in++;
  }
  for (const n of list) Object.assign(n, { inDegree: deg[n.id].in, outDegree: deg[n.id].out });
  const version = crypto.createHash('sha1').update(JSON.stringify([list.map((n) => [n.id, n.category]), links.map((e) => e.id)])).digest('hex').slice(0, 12);
  return { version, builtAt: new Date().toISOString(), categories: CATEGORIES, nodes: list, edges: links };
}

// Live status on top of the static graph (cheap; called per request).
function withStatus(topo, { modes, db, external }) {
  const nodes = topo.nodes.map((n) => {
    let status = n.status;
    const ext = external[n.id];
    if (n.kind === 'external') {
      const mode = modes[n.metadata.mode];
      if (mode === 'mock') status = 'mock';
      else if (mode === 'missing' || mode === 'not configured') status = 'not configured';
      else if (mode === 'disabled') status = 'disabled';
      else if (n.id === 'ext:supabase' && db.reachable != null) status = db.reachable ? 'verified' : 'error';
      else if (ext) status = ext.ok ? 'verified' : 'error';
      else status = 'configured · unverified';
    } else if (SERVICE_MODE_FILE[n.id]) {
      status = modes[SERVICE_MODE_FILE[n.id]] || 'not loaded';
    } else if (n.kind === 'table' || n.kind === 'bucket') {
      status = db.kind === 'local' ? 'mock (local JSON)' : db.reachable === true ? 'reachable' : db.reachable === false ? 'error' : 'unverified';
    } else if (n.kind === 'model') {
      const ext = topo.edges.find((e) => e.source === n.id && e.relationship === 'hosted on');
      const mode = modes[EXTERNALS[ext?.target]?.mode];
      status = mode === 'mock' ? 'mock' : mode === 'real' ? 'configured' : mode || 'not configured';
    } else if (n.kind === 'module' && status === 'present') {
      const abs = path.join(ROOT, n.metadata.path);
      if (require.cache[abs]) status = 'loaded';
    }
    return status === n.status ? n : { ...n, status };
  });
  return { ...topo, nodes };
}

let cache = null;
let cachedAt = 0;
/** The graph, rebuilt from disk at most every `maxAgeMs` (new files/routes appear without a restart). */
function getTopology({ maxAgeMs = 10000 } = {}) {
  if (!cache || Date.now() - cachedAt > maxAgeMs) {
    cache = build();
    cachedAt = Date.now();
  }
  return cache;
}

module.exports = { build, getTopology, withStatus, CATEGORIES };
