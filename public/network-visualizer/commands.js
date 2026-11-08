// Local command parser for the bottom command bar. Not an AI chatbot: it understands a fixed set
// of graph commands and turns them into actions the app runs on the real topology.

export const EXAMPLES = [
  'show gemini', 'find supabase', 'trace whatsapp to ai', 'show all database connections',
  'highlight active services', 'find disconnected components', 'show backend architecture',
  'focus on admin dashboard', 'reset network', 'help',
];

// Words that name a category rather than a component.
const CATEGORY_WORDS = {
  ai: 'ai', 'ai models': 'ai', model: 'ai', models: 'ai', whatsapp: 'whatsapp', telegram: 'telegram',
  frontend: 'frontend', views: 'frontend', backend: 'backend', api: 'api', routes: 'api', 'api routes': 'api',
  processing: 'processing', database: 'database', db: 'database', tables: 'database', storage: 'storage',
  admin: 'admin', 'admin dashboard': 'admin', workflow: 'workflow', workflows: 'workflow', output: 'output',
  delivery: 'output', external: 'external', 'external services': 'external', config: 'config', env: 'config',
  packages: 'packages', tests: 'tests', testing: 'tests', entry: 'entry', 'entry points': 'entry',
  auth: 'auth', authentication: 'auth', login: 'auth', 'ai integrations': 'ai',
};
// Plain names for the main components (used when present in the topology).
export const ALIASES = {
  whatsapp: 'ext:meta-whatsapp', 'whatsapp customer': 'ext:meta-whatsapp', meta: 'ext:meta-whatsapp',
  telegram: 'ext:telegram', gemini: 'file:src/services/gemini/index.js', ai: 'file:src/services/gemini/index.js',
  cloudflare: 'ext:cloudflare', 'workers ai': 'ext:cloudflare', 'hugging face': 'ext:huggingface', huggingface: 'ext:huggingface',
  supabase: 'ext:supabase', database: 'file:src/services/db/index.js', db: 'file:src/services/db/index.js',
  storage: 'storage:posters', poster: 'file:src/services/poster/index.js', posters: 'file:src/services/poster/index.js',
  admin: 'file:src/routes/admin.js', 'admin dashboard': 'file:src/routes/admin.js', 'admin approval': 'route:POST /admin/jobs/:id/approve',
  approval: 'route:POST /admin/jobs/:id/approve', backend: 'file:src/app.js', server: 'file:src/server.js',
  jobs: 'file:src/pipeline/jobs.js', delivery: 'file:src/pipeline/outbound.js', webhook: 'route:POST /webhook',
};
export const categoryWord = (w) => CATEGORY_WORDS[w.trim().toLowerCase().replace(/^the\s+/, '')] || null;

const clean = (s) => s.trim().toLowerCase().replace(/[.?!]+$/, '').replace(/^(please|can you|could you)\s+/, '');

/**
 * Returns { type, ... }:
 *  help | reset | fit | disconnected | active | trace {from,to} | connections {term} |
 *  architecture {term} | focus {term} | find {term} | unknown {text}
 */
export function parse(input) {
  const t = clean(input);
  if (!t) return { type: 'none' };
  if (/^(help|\?|commands)$/.test(t)) return { type: 'help' };
  if (/^(reset|reset (the )?(network|graph|view|all)|clear)$/.test(t)) return { type: 'reset' };
  if (/^(fit|zoom to fit|show everything|show all)$/.test(t)) return { type: 'fit' };
  if (/disconnected|isolated|orphan/.test(t)) return { type: 'disconnected' };
  let c = t.match(/^(collapse|expand)\s+(?:the\s+)?(.+?)(?:\s+cluster)?$/);
  if (c) return { type: c[1], term: c[2] };
  if (/^(highlight|show|find|list) (all )?(the )?active( services)?$/.test(t) || /active services/.test(t)) return { type: 'active' };
  let m = t.match(/^(?:trace|path|route|connect|how does)\s+(?:from\s+)?(.+?)\s+(?:to|->|→|reach|and)\s+(.+?)$/);
  if (m) return { type: 'trace', from: m[1], to: m[2] };
  m = t.match(/^(?:show|find|list|highlight)\s+(?:all\s+)?(?:the\s+)?(.+?)\s+(?:connections|links|edges)$/);
  if (m) return { type: 'connections', term: m[1] };
  m = t.match(/^(?:show|display|filter)\s+(?:only\s+)?(?:the\s+)?(.+?)\s+(?:architecture|layer|category|only)$/);
  if (m) return { type: 'architecture', term: m[1] };
  m = t.match(/^(?:focus|zoom|center|centre)\s+(?:on\s+)?(?:the\s+)?(.+)$/);
  if (m) return { type: 'focus', term: m[1] };
  m = t.match(/^(?:show|find|search|search for|inspect|open|where is|select|locate)\s+(?:the\s+)?(.+)$/);
  if (m) return { type: 'find', term: m[1] };
  return { type: 'find', term: t, loose: true };
}
