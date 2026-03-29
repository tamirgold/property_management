'use strict';

/**
 * Telegram message handlers.
 *
 * The bot supports three interaction modes:
 *   1. Free-form NLP  – any plain-text message is routed through the OpenAI
 *      agentic loop, which decides which PMS API calls to make and formats
 *      the response naturally.
 *   2. /start command – welcome message and capability overview.
 *   3. /help command  – lists example queries the landlord can ask.
 *
 * Per-user conversation history is kept in memory so the model maintains
 * context across multiple turns in the same session.  History is capped at
 * MAX_HISTORY_TURNS to avoid exceeding the context window.
 */

const logger = require('../logger');
const { chat } = require('../ai/openai');

const MAX_HISTORY_TURNS = 20; // pairs of user+assistant messages

// In-memory session store keyed by tenantId + Telegram userId
const sessions = new Map();

function historyKey(userId, tenantId) {
  return `${tenantId || 'default'}:${userId}`;
}

function getHistory(userId, tenantId) {
  const key = historyKey(userId, tenantId);
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}

function trimHistory(history) {
  // Each "turn" = 1 user message + 1 assistant message = 2 entries
  const maxEntries = MAX_HISTORY_TURNS * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

// ─── /start ──────────────────────────────────────────────────────────────────

async function handleStart(bot, msg) {
  const name = msg.from.first_name || 'there';
  await bot.sendMessage(
    msg.chat.id,
    `👋 Hi ${name}! I'm your property management AI assistant.\n\n` +
      `I can answer real-time questions about your portfolio, including:\n` +
      `• Outstanding rent balances\n` +
      `• Maintenance work orders\n` +
      `• Lease status and expirations\n` +
      `• Vacant units\n` +
      `• Financial summaries\n\n` +
      `Just ask me anything in plain English, or type /help for examples.`
  );
}

// ─── /help ───────────────────────────────────────────────────────────────────

async function handleHelp(bot, msg) {
  await bot.sendMessage(
    msg.chat.id,
    `📋 *Example queries you can ask:*\n\n` +
      `💰 *Rent & Financials*\n` +
      `• "Which tenants are late on rent this month?"\n` +
      `• "What is the total outstanding balance across the portfolio?"\n` +
      `• "Give me a financial summary for this week."\n\n` +
      `🔧 *Maintenance*\n` +
      `• "What maintenance tickets have been open for more than 3 days?"\n` +
      `• "What is the status of the plumbing issue in Unit 4B?"\n` +
      `• "List all open work orders."\n\n` +
      `🏠 *Leases & Tenants*\n` +
      `• "Which units are vacant right now?"\n` +
      `• "When does the lease for 123 Maple St expire?"\n` +
      `• "Give me info on John Doe in Unit 3A."\n\n` +
      `Type /clear to reset our conversation history.`,
    { parse_mode: 'Markdown' }
  );
}

// ─── /clear ──────────────────────────────────────────────────────────────────

async function handleClear(bot, msg) {
  sessions.delete(historyKey(msg.from.id, msg.tenantContext?.tenantId));
  await bot.sendMessage(msg.chat.id, '🗑️ Conversation history cleared. Starting fresh!');
}

// ─── /chatid ─────────────────────────────────────────────────────────────────

async function handleChatId(bot, msg) {
  await bot.sendMessage(
    msg.chat.id,
    `Chat ID: \`${msg.chat.id}\`\nType: ${msg.chat.type}\nTitle: ${msg.chat.title || '(private)'}`,
    { parse_mode: 'Markdown' }
  );
}

// ─── Free-form NLP message ────────────────────────────────────────────────────

async function handleMessage(bot, msg, options = {}) {
  const userId = msg.from.id;
  const text = msg.text?.trim();
  const tenantContext = options.tenantContext || msg.tenantContext || null;

  if (!text) return;

  // Show typing indicator while the AI processes the request
  await bot.sendChatAction(msg.chat.id, 'typing');

  const history = getHistory(userId, tenantContext?.tenantId);

  try {
    const reply = tenantContext
      ? await chat(text, history, { tenantContext })
      : await chat(text, history);
    trimHistory(history);
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Error processing Telegram message via AI', { userId, error: err.message });
    await bot.sendMessage(
      msg.chat.id,
      '⚠️ I encountered an error while processing your request. Please try again or rephrase your question.'
    );
  }
}

module.exports = { handleStart, handleHelp, handleClear, handleChatId, handleMessage };
