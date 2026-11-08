'use strict';
// Per-customer conversation state machine.
//   idle -> collecting -> confirming -(YES)-> in_production -> delivered -> (feedback / revisions)
// RESTART / NEW at any time starts a fresh poster request.
const config = require('../config');
const db = require('../services/db');
const gemini = require('../services/gemini');
const { createMockGemini } = require('../services/gemini/mock');
const log = require('../logger');
const outbound = require('./outbound');

const { channelOf } = outbound;
const { FIELDS, QUESTIONS, mergeFields, missingFields, toBrief, summaryText } = require('../lib/brief');
const { formatDue } = require('../lib/time');

const RESTART_RE = /^\s*(restart|new|start over|new poster|reset)\s*[.!]*\s*$/i;
const YES_RE = /^\s*(yes|y|yep|yeah|yup|ya|haan|ha|confirm(ed)?|ok(ay)?|correct|go ahead|looks good|perfect|done|sure|proceed)\b[\s!.👍✅]*$/i;
const LOGO_WORD_RE = /\blogo\b/i;
const NO_LOGO_RE = /\b(no|don'?t|do not|without)\b.*\blogo\b|\bskip\b/i;

const ruleIntake = createMockGemini(); // fallback when Gemini is down or over quota

// ------------------------------------------------------------------ helpers
const publicFields = (c) => Object.fromEntries(FIELDS.map((f) => [f, c[f] ?? null]));

async function save(customer, state, collected) {
  return db.saveConversation(customer.id, { state, collected_fields: collected });
}

function freshCollected(customer) {
  const c = {};
  if (customer.business_name) c.business_name = customer.business_name;
  if (customer.logo_url) {
    c.logo = 'provided';
    c.logo_url = customer.logo_url;
  }
  return c;
}

async function recentHistory(customer) {
  const msgs = await db.listMessages(customer.id, { limit: 12 });
  return msgs.map((m) => ({
    from: m.direction === 'in' ? 'customer' : 'assistant',
    text: m.type === 'image' && !m.content ? '[sent an image]' : (m.type === 'audio' ? `[voice note] ${m.content || ''}` : m.content || ''),
  }));
}

// Image during intake: it's the logo if the caption says so or we just asked for the logo.
// Otherwise remember it and ask.
async function handleImage(customer, collected, message) {
  const caption = message.content || '';
  if (!message.mediaUrl) return { collected, reply: "Sorry, I couldn't save that image. Could you send it again?" };
  if (LOGO_WORD_RE.test(caption) || collected._asking === 'logo') {
    await db.updateCustomer(customer.id, { logo_url: message.mediaUrl });
    customer.logo_url = message.mediaUrl;
    return { collected: { ...collected, logo: 'provided', logo_url: message.mediaUrl, _pending_image_url: null }, logoSet: true };
  }
  return {
    collected: { ...collected, _pending_image_url: message.mediaUrl },
    reply: 'Got your image 👍 Is this your *logo*? Reply LOGO to use it on the poster.',
  };
}

// Runs the intake agent on one customer message and returns the updated fields + reply.
async function runIntake(customer, collected, text, clog) {
  const input = {
    known: {
      customer_personal_name: customer.name || null, // the PERSON chatting - not the business
      business_name: customer.business_name || null,
      has_saved_logo: !!customer.logo_url,
    },
    collected: { ...publicFields(collected), _asking: collected._asking || null },
    history: await recentHistory(customer),
    message: text,
  };
  let result;
  try {
    result = await gemini.intake(input);
  } catch (err) {
    clog.error('intake agent failed, using rule-based fallback', { err });
    result = await ruleIntake.intake(input);
  }

  let next = mergeFields(collected, result.fields || {});
  if (next.logo === 'provided' && !next.logo_url) delete next.logo; // model can't "provide" a logo we don't have
  // The model must not reuse the customer's personal name as the business name unless the customer gave
  // it in answer to the business-name question (some businesses are named after their owner).
  let forceAsk = null;
  const sameAsPerson = (v) => customer.name && v && v.trim().toLowerCase() === customer.name.trim().toLowerCase();
  if (sameAsPerson(next.business_name) && !sameAsPerson(collected.business_name) && collected._asking !== 'business_name') {
    delete next.business_name;
    forceAsk = 'business_name'; // the model thinks it's known, so it would never ask - we ask now
  }
  const missing = missingFields(next);
  if (!missing.length) return { collected: { ...next, _asking: null }, ready: true };

  let asking = FIELDS.includes(result.asking_for) && missing.includes(result.asking_for) ? result.asking_for : missing[0];
  let question = asking === result.asking_for && result.next_question ? result.next_question : QUESTIONS[asking];
  if (forceAsk) {
    asking = forceAsk;
    question = QUESTIONS[forceAsk];
  }
  next = { ...next, _asking: asking };
  return { collected: next, ready: false, question };
}

// ------------------------------------------------------------------ states
async function stepCollecting(customer, convo, message, clog, { greeting = '' } = {}) {
  let collected = { ...convo.collected_fields };
  let text = message.content || '';

  if (message.type === 'image') {
    const r = await handleImage(customer, collected, message);
    collected = r.collected;
    if (r.reply) {
      await save(customer, convo.state, collected);
      return outbound.sendText(customer, greeting + r.reply);
    }
    text = text || '(customer sent their logo image)';
  } else if (collected._pending_image_url && LOGO_WORD_RE.test(text) && !NO_LOGO_RE.test(text)) {
    await db.updateCustomer(customer.id, { logo_url: collected._pending_image_url });
    customer.logo_url = collected._pending_image_url;
    collected = { ...collected, logo: 'provided', logo_url: collected._pending_image_url, _pending_image_url: null };
  }

  // Telegram: the first answer after /start is the customer's own name.
  if (collected._asking === 'customer_name') {
    const name = message.type === 'text' ? cleanName(text) : '';
    if (!name) return outbound.sendText(customer, "Sorry, I didn't catch that - what's your name?");
    customer = await db.updateCustomer(customer.id, { name });
    collected = { ...collected, _asking: null };
    greeting = `Nice to meet you, ${name}! `;
    text = '';
  }

  const r = await runIntake(customer, collected, text, clog);
  if (r.ready) {
    await save(customer, 'confirming', r.collected);
    return outbound.sendText(customer, greeting + summaryText(r.collected));
  }
  await save(customer, 'collecting', r.collected);
  return outbound.sendText(customer, greeting + r.question);
}

async function confirmBrief(customer, convo, clog) {
  const collected = convo.collected_fields;
  const brief = toBrief(collected, customer);
  const deadline = new Date(Date.now() + config.business.deliveryHours * 3600 * 1000).toISOString();
  const job = await db.createJob({ customer_id: customer.id, status: 'brief_confirmed', brief, deadline });
  const jlog = clog.child({ jobId: job.id });
  jlog.info('brief confirmed, job created');

  const remember = { business_name: brief.business_name };
  if (brief.logo_url) remember.logo_url = brief.logo_url;
  await db.updateCustomer(customer.id, remember);
  await save(customer, 'in_production', { ...collected, job_id: job.id });

  await outbound.sendText(customer,
    `Confirmed ✅ Our team is designing your poster now.\nYou'll receive it by *${formatDue(deadline)}*. We'll send it right here.`,
    { jobId: job.id });

  // Lazy require avoids a circular import (jobs -> outbound -> ...).
  require('./jobs').startJob(job.id);
}

async function stepConfirming(customer, convo, message, clog) {
  if (message.type === 'text' && YES_RE.test(message.content)) return confirmBrief(customer, convo, clog);
  // Anything else is a change request: let the intake agent update the fields, then re-confirm.
  return stepCollecting(customer, { ...convo, state: 'confirming' }, message, clog);
}

const STATUS_REPLY = {
  collecting: null,
  brief_confirmed: (due) => `Your poster is being designed 🎨 You'll get it by *${due}*.`,
  generating: (due) => `Your poster is being designed 🎨 You'll get it by *${due}*.`,
  qa_done: (due) => `Your poster is in final review 👀 You'll get it by *${due}*.`,
  pending_review: (due) => `Your poster is in final review 👀 You'll get it by *${due}*.`,
  approved: () => 'Your poster is approved and on its way!',
  revision_requested: (due) => `We're working on your changes ✏️ Expected by *${due}*.`,
  failed: () => "Your poster is taking a little longer than usual - our team is on it and will send it soon.",
};

async function stepInProduction(customer, convo) {
  const job = convo.collected_fields.job_id ? await db.getJob(convo.collected_fields.job_id) : null;
  const make = job && STATUS_REPLY[job.status];
  const status = make ? make(formatDue(job.deadline)) : "We're working on your poster.";
  return outbound.sendText(customer, `${status}\nTo start a different poster, reply *NEW*.`);
}

// ------------------------------------------------------------------ entry point
async function startNew(customer, message, clog, greeting) {
  const convo = { state: 'collecting', collected_fields: freshCollected(customer) };
  await save(customer, convo.state, convo.collected_fields);
  if (message && !(message.type === 'text' && RESTART_RE.test(message.content))) {
    return stepCollecting(customer, convo, message, clog, { greeting });
  }
  const who = customer.business_name ? ` for *${customer.business_name}*` : '';
  return outbound.sendText(customer, `${greeting}Let's create a new poster${who}! What is this poster for?`);
}

const START_RE = /^\s*\/start(\s|@|$)/i;
const WHERE = { whatsapp: 'right here on WhatsApp', telegram: 'right here on Telegram' };
const firstGreeting = (customer) => `Hi! 👋 Welcome to *PIXRA AI* - we design posters for your business ${WHERE[channelOf(customer)] || 'right here in this chat'}.\n\n`;

async function askName(customer, greeting) {
  await save(customer, 'collecting', { ...freshCollected(customer), _asking: 'customer_name' });
  return outbound.sendText(customer, `${greeting}To get started, what's your name? (After that I'll ask about your business.)`);
}

// "my name is Ravi", "I'm ravi kumar." -> "Ravi Kumar"
function cleanName(text) {
  const s = String(text || '')
    .replace(/^\s*(hi|hello|hey)[\s,!.]*/i, '')
    .replace(/^\s*(my name is|my name's|i am|i'm|im|this is|it's|its|name:)\s*/i, '')
    .replace(/[.!,;:]+\s*$/, '')
    .trim()
    .slice(0, 60);
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

async function handle({ customer, message }) {
  const clog = log.child({ phone: customer.phone });

  if (message.mediaError) {
    const reply = message.type === 'audio'
      ? "Sorry, I couldn't understand that voice note 🙏 Could you please type your message instead?"
      : "Sorry, I couldn't open that file 🙏 Could you send it again, or type your message instead?";
    return outbound.sendText(customer, reply);
  }
  if (message.type === 'unsupported') {
    return outbound.sendText(customer, 'Sorry, I can only read text messages, voice notes and images right now.');
  }

  const convo = await db.getConversation(customer.id);

  if (message.type === 'text' && RESTART_RE.test(message.content)) {
    clog.info('customer restarted the conversation');
    return startNew(customer, message, clog, '');
  }

  // Telegram's Start button sends "/start". New customers are asked their name first (Telegram gives us
  // no phone number); returning customers go straight to a new poster.
  if (message.type === 'text' && START_RE.test(message.content)) {
    clog.info('/start received');
    if (!customer.name) return askName(customer, firstGreeting(customer));
    return startNew(customer, { type: 'text', content: 'NEW' }, clog, `Welcome back, ${customer.name}! 👋\n\n`);
  }

  if (!convo || convo.state === 'idle') {
    if (channelOf(customer) === 'telegram' && !customer.name) return askName(customer, firstGreeting(customer));
    const greeting = customer.business_name
      ? `Welcome back to PIXRA AI, ${customer.business_name}! 👋\n\n`
      : firstGreeting(customer);
    return startNew(customer, message, clog, greeting);
  }

  switch (convo.state) {
    case 'collecting': return stepCollecting(customer, convo, message, clog);
    case 'confirming': return stepConfirming(customer, convo, message, clog);
    case 'in_production': return stepInProduction(customer, convo);
    case 'delivered': return require('./revisions').handleFeedback(customer, convo, message, clog);
    default:
      clog.warn(`unknown conversation state "${convo.state}", restarting`);
      return startNew(customer, message, clog, '');
  }
}

module.exports = { handle, startNew, RESTART_RE, YES_RE };
