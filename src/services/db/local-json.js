'use strict';
// Mock DB: a single JSON file (data/db.json) + files in uploads/ served at /uploads.
// Same interface as supabase.js. Single-process only; fine for local development.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TABLES = ['customers', 'messages', 'conversations', 'jobs', 'assets', 'reviews'];
const now = () => new Date().toISOString();
const clone = (v) => (v == null ? v : structuredClone(v));

function createLocalDb({ dataDir, uploadsDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');

  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      const bad = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, bad);
      console.error(`local db: could not parse ${file}, moved it to ${bad}`);
    }
  }
  for (const t of TABLES) data[t] = data[t] || [];

  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, JSON.stringify(data, null, 1)); // Windows may lock the target briefly
    }
  }

  const insert = (table, row) => {
    const rec = { id: crypto.randomUUID(), created_at: now(), ...row };
    data[table].push(rec);
    save();
    return clone(rec);
  };
  const find = (table, pred) => clone(data[table].find(pred) || null);
  const patch = (table, pred, changes, touch = false) => {
    const rec = data[table].find(pred);
    if (!rec) return null;
    Object.assign(rec, changes, touch ? { updated_at: now() } : {});
    save();
    return clone(rec);
  };
  const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

  return {
    kind: 'local',

    // ---------------- customers
    async getCustomerByPhone(phone) { return find('customers', (c) => c.phone === phone); },
    async getCustomer(id) { return find('customers', (c) => c.id === id); },
    async getCustomers(ids) { return clone(data.customers.filter((c) => ids.includes(c.id))); },
    async createCustomer(row) {
      return insert('customers', { name: null, business_name: null, logo_url: null, brand_colors: null, simulated: false, channel: 'whatsapp', ...row });
    },
    async listCustomers({ channel, limit = 50 } = {}) {
      const rows = data.customers.filter((c) => !channel || (c.channel || 'whatsapp') === channel);
      return clone([...rows].sort(byCreated).reverse().slice(0, limit));
    },
    async updateCustomer(id, changes) { return patch('customers', (c) => c.id === id, changes); },

    // ---------------- messages
    async hasMessage(waMessageId) { return data.messages.some((m) => m.wa_message_id === waMessageId); },
    // Returns null if wa_message_id already exists (dedup).
    async insertMessage(row) {
      if (row.wa_message_id && data.messages.some((m) => m.wa_message_id === row.wa_message_id)) return null;
      return insert('messages', { type: 'text', content: null, media_url: null, ...row });
    },
    async listMessages(customerId, { limit = 200 } = {}) {
      return clone(data.messages.filter((m) => m.customer_id === customerId).sort(byCreated).slice(-limit));
    },

    // ---------------- conversations
    async getConversation(customerId) { return find('conversations', (c) => c.customer_id === customerId); },
    async saveConversation(customerId, { state, collected_fields }) {
      const existing = data.conversations.find((c) => c.customer_id === customerId);
      if (existing) {
        Object.assign(existing, { state, collected_fields, updated_at: now() });
        save();
        return clone(existing);
      }
      const rec = { customer_id: customerId, state, collected_fields, updated_at: now() };
      data.conversations.push(rec);
      save();
      return clone(rec);
    },

    // ---------------- jobs
    async createJob(row) {
      return insert('jobs', {
        status: 'collecting', brief: {}, deadline: null, assigned_to: null, error: null, regen_note: null,
        revision_request: null, revision_count: 0, delivered_asset_id: null, attempts: 0, updated_at: now(), ...row,
      });
    },
    async getJob(id) { return find('jobs', (j) => j.id === id); },
    async updateJob(id, changes) { return patch('jobs', (j) => j.id === id, changes, true); },
    async listJobs({ statuses, limit = 200 } = {}) {
      let rows = data.jobs;
      if (statuses) rows = rows.filter((j) => statuses.includes(j.status));
      return clone([...rows].sort(byCreated).reverse().slice(0, limit));
    },
    async getLatestJobForCustomer(customerId) {
      const rows = data.jobs.filter((j) => j.customer_id === customerId).sort(byCreated);
      return clone(rows[rows.length - 1] || null);
    },

    // ---------------- assets
    async createAsset(row) {
      const version = row.version ?? (Math.max(0, ...data.assets.filter((a) => a.job_id === row.job_id).map((a) => a.version)) + 1);
      return insert('assets', { background_url: null, template: null, size: null, source: 'ai', qa_report: null, ...row, version });
    },
    async getAsset(id) { return find('assets', (a) => a.id === id); },
    async updateAsset(id, changes) { return patch('assets', (a) => a.id === id, changes); },
    async listAssets(jobId) {
      return clone(data.assets.filter((a) => a.job_id === jobId).sort((a, b) => a.version - b.version));
    },

    // ---------------- reviews
    async createReview(row) { return insert('reviews', { asset_id: null, reviewer: null, notes: null, ...row }); },
    async listReviews(jobId) { return clone(data.reviews.filter((r) => r.job_id === jobId).sort(byCreated)); },

    // ---------------- storage
    // key like "posters/<job>/v1.png" -> returns a URL path the app serves from /uploads
    async uploadFile(key, buffer) {
      const safeKey = key.replace(/\\/g, '/').replace(/\.\.+/g, '.');
      const dest = path.join(uploadsDir, ...safeKey.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      return `/uploads/${safeKey}`; // relative; made absolute when sent to WhatsApp
    },
    async readFile(url) {
      const idx = url.indexOf('/uploads/');
      if (idx === -1) throw new Error(`local storage cannot read ${url}`);
      const rel = decodeURIComponent(url.slice(idx + '/uploads/'.length));
      return fs.readFileSync(path.join(uploadsDir, ...rel.split('/')));
    },

    async ping() { return true; },
  };
}

module.exports = { createLocalDb };
