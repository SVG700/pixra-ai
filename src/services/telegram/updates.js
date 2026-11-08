'use strict';
// Shared entry for Telegram updates from the webhook AND from long polling:
// dedup by update_id, parse, hand to the common inbound pipeline.
const log = require('../../logger');
const { parseUpdate } = require('./parse');

const SEEN_MAX = 5000;
const seen = new Set();

/** Returns the inbound processing promise, or null if the update was ignored/duplicate. */
function handleUpdate(update) {
  const id = update?.update_id;
  if (typeof id !== 'number') return null;
  if (seen.has(id)) {
    log.info(`telegram: duplicate update ${id} ignored`);
    return null;
  }
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);

  const msg = parseUpdate(update);
  if (!msg) return null; // not a private-chat message (group, edit, callback...) - ignored
  return require('../../pipeline/inbound').enqueue(msg);
}

module.exports = { handleUpdate };
