'use strict';
// Lenient JSON extraction for LLM output: strips ```json fences / surrounding prose,
// then parses the first top-level {...} or [...] block. Throws with a useful message on failure.

function extractJsonText(text) {
  if (text == null) throw new Error('empty response');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (s.startsWith('{') || s.startsWith('[')) return s;
  // find first balanced object/array, respecting strings
  const start = s.search(/[{[]/);
  if (start === -1) throw new Error('no JSON object found');
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  throw new Error('unterminated JSON');
}

function parseJsonLoose(text) {
  const s = extractJsonText(text);
  try {
    return JSON.parse(s);
  } catch (e) {
    // common LLM slip: trailing commas
    const fixed = s.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fixed);
    } catch {
      throw new Error(`invalid JSON: ${e.message}`);
    }
  }
}

module.exports = { parseJsonLoose, extractJsonText };
