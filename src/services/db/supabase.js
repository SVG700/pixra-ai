'use strict';
// Real DB: Supabase Postgres + Storage, using the service role key (server-side only).
const { createClient } = require('@supabase/supabase-js');
const { fetchWithRetry, ensureOk } = require('../../lib/http');

function createSupabaseDb({ url, serviceRoleKey, bucket }) {
  const sb = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Unwraps { data, error } and throws readable errors.
  const run = async (label, query) => {
    const { data, error } = await query;
    if (error) {
      const err = new Error(`supabase ${label}: ${error.message}`);
      err.code = error.code;
      throw err;
    }
    return data;
  };
  const one = (label, query) => run(label, query.maybeSingle());

  return {
    kind: 'supabase',

    // ---------------- customers
    getCustomerByPhone: (phone) => one('getCustomerByPhone', sb.from('customers').select('*').eq('phone', phone)),
    getCustomer: (id) => one('getCustomer', sb.from('customers').select('*').eq('id', id)),
    getCustomers: (ids) => (ids.length ? run('getCustomers', sb.from('customers').select('*').in('id', ids)) : []),
    createCustomer: (row) => run('createCustomer', sb.from('customers').insert(row).select().single()),
    listCustomers({ channel, limit = 50 } = {}) {
      let q = sb.from('customers').select('*').order('created_at', { ascending: false }).limit(limit);
      if (channel) q = q.eq('channel', channel);
      return run('listCustomers', q);
    },
    updateCustomer: (id, changes) => one('updateCustomer', sb.from('customers').update(changes).eq('id', id).select()),

    // ---------------- messages
    async hasMessage(waMessageId) {
      const row = await one('hasMessage', sb.from('messages').select('id').eq('wa_message_id', waMessageId));
      return !!row;
    },
    async insertMessage(row) {
      const { data, error } = await sb.from('messages').insert(row).select().single();
      if (error) {
        if (error.code === '23505') return null; // duplicate wa_message_id -> already processed
        throw new Error(`supabase insertMessage: ${error.message}`);
      }
      return data;
    },
    async listMessages(customerId, { limit = 200 } = {}) {
      const rows = await run('listMessages', sb.from('messages').select('*').eq('customer_id', customerId)
        .order('created_at', { ascending: false }).limit(limit));
      return rows.reverse();
    },

    // ---------------- conversations
    getConversation: (customerId) => one('getConversation', sb.from('conversations').select('*').eq('customer_id', customerId)),
    saveConversation: (customerId, { state, collected_fields }) => run('saveConversation',
      sb.from('conversations').upsert({ customer_id: customerId, state, collected_fields }, { onConflict: 'customer_id' }).select().single()),

    // ---------------- jobs
    createJob: (row) => run('createJob', sb.from('jobs').insert(row).select().single()),
    getJob: (id) => one('getJob', sb.from('jobs').select('*').eq('id', id)),
    updateJob: (id, changes) => one('updateJob', sb.from('jobs').update(changes).eq('id', id).select()),
    listJobs({ statuses, limit = 200 } = {}) {
      let q = sb.from('jobs').select('*').order('created_at', { ascending: false }).limit(limit);
      if (statuses) q = q.in('status', statuses);
      return run('listJobs', q);
    },
    getLatestJobForCustomer: (customerId) => one('getLatestJobForCustomer', sb.from('jobs').select('*')
      .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(1)),

    // ---------------- assets
    async createAsset(row) {
      // version = max+1 unless given; retry once if two inserts race on unique(job_id, version)
      for (let attempt = 0; attempt < 3; attempt++) {
        let version = row.version;
        if (version == null) {
          const last = await one('nextVersion', sb.from('assets').select('version').eq('job_id', row.job_id)
            .order('version', { ascending: false }).limit(1));
          version = (last?.version || 0) + 1;
        }
        const { data, error } = await sb.from('assets').insert({ ...row, version }).select().single();
        if (!error) return data;
        if (error.code !== '23505' || row.version != null) throw new Error(`supabase createAsset: ${error.message}`);
      }
      throw new Error('supabase createAsset: could not allocate a version number');
    },
    getAsset: (id) => one('getAsset', sb.from('assets').select('*').eq('id', id)),
    updateAsset: (id, changes) => one('updateAsset', sb.from('assets').update(changes).eq('id', id).select()),
    listAssets: (jobId) => run('listAssets', sb.from('assets').select('*').eq('job_id', jobId).order('version')),

    // ---------------- reviews
    createReview: (row) => run('createReview', sb.from('reviews').insert(row).select().single()),
    listReviews: (jobId) => run('listReviews', sb.from('reviews').select('*').eq('job_id', jobId).order('created_at')),

    // ---------------- storage
    async uploadFile(key, buffer, contentType = 'image/png') {
      await run('uploadFile', sb.storage.from(bucket).upload(key, buffer, { contentType, upsert: true }));
      return sb.storage.from(bucket).getPublicUrl(key).data.publicUrl;
    },
    async readFile(fileUrl) {
      const res = await ensureOk(await fetchWithRetry(fileUrl, {}, { label: 'storage download' }), 'storage download');
      return Buffer.from(await res.arrayBuffer());
    },

    async ping() {
      await run('ping', sb.from('jobs').select('id').limit(1));
      return true;
    },
  };
}

module.exports = { createSupabaseDb };
