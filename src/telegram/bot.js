'use strict';

/**
 * Telegram bot – supports two operating modes:
 *
 *   Polling mode  (local / non-Vercel)
 *     createBot() starts long-polling.  Called once from src/index.js.
 *
 *   Webhook mode  (Vercel serverless)
 *     No polling.  Telegram POSTs updates to /telegram.
 *     api/index.js calls processUpdate(body) for each incoming POST.
 *     A bot instance is created on the first call and reused within
 *     the same function invocation.
 *
 * notifyLandlord() works in both modes – it lazily creates a send-only
 * bot instance if one is not already running.
 */

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');
const { guard } = require('./security');
const { handleStart, handleHelp, handleClear, handleChatId, handleMessage } = require('./handlers');
const { getTenantContextForTelegramPrincipal, getDefaultTenantContext } = require('../platform/runtime');

let bot = null;
let botInfo = null; // populated by getMe() – used for @mention + reply-to detection

// ─── Group-mention filter ─────────────────────────────────────────────────────

/**
 * Returns true when a message should be processed.
 *
 * Private chats  → always respond.
 * Group chats    → only respond when the bot is explicitly addressed:
 *                    • @mention in the message text/entities, OR
 *                    • a direct reply to one of the bot's own messages.
 *
 * Also returns the message text with the @mention prefix stripped so the AI
 * receives clean input ("@LandlordBot what is the rent status?" → "what is
 * the rent status?").
 *
 * @returns {{ addressed: boolean, text: string }}
 */
function parseGroupMessage(msg) {
  const isGroup = ['group', 'supergroup'].includes(msg.chat?.type);
  const text = msg.text || '';

  if (!isGroup) {
    return { addressed: true, text };
  }

  // Direct reply to the bot's own message
  if (botInfo && msg.reply_to_message?.from?.id === botInfo.id) {
    return { addressed: true, text };
  }

  // @mention anywhere in the message (Telegram marks these in msg.entities)
  const mentioned = (msg.entities || []).some(
    (e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase()
      === `@${(botInfo?.username || '').toLowerCase()}`
  );

  if (!mentioned) {
    return { addressed: false, text };
  }

  // Strip the @mention so the AI gets clean input
  const cleanText = text
    .replace(new RegExp(`@${botInfo?.username}\\s*`, 'i'), '')
    .trim();

  return { addressed: true, text: cleanText };
}

// ─── Handler registration ─────────────────────────────────────────────────────

async function resolveTenantContext(msg) {
  if (msg.__tenantContext) return msg.__tenantContext;

  const userId = msg?.from?.id;
  const chatId = msg?.chat?.id;

  const byPrincipal = await getTenantContextForTelegramPrincipal({ userId, chatId });
  msg.__tenantContext = byPrincipal || await getDefaultTenantContext();
  return msg.__tenantContext;
}

async function resolveAllowList(msg) {
  const tenantContext = await resolveTenantContext(msg);
  const telegram = tenantContext?.integrations?.telegram || {};
  return {
    allowedUserIds: telegram.allowedUserIds || [...config.telegram.allowedUserIds],
    allowedGroupIds: telegram.allowedGroupIds || [...config.telegram.allowedGroupIds],
  };
}

/**
 * Attaches all message handlers to a bot instance.
 * Called for both polling bots and webhook-mode bots.
 */
function _registerHandlers(b) {
  b.onText(/^\/start(@\w+)?$/, guard(async (msg) => {
    const tenantContext = await resolveTenantContext(msg);
    await handleStart(b, { ...msg, tenantContext });
  }, { resolveAllowList }));

  b.onText(/^\/help(@\w+)?$/, guard(async (msg) => {
    const tenantContext = await resolveTenantContext(msg);
    await handleHelp(b, { ...msg, tenantContext });
  }, { resolveAllowList }));

  b.onText(/^\/clear(@\w+)?$/, guard(async (msg) => {
    const tenantContext = await resolveTenantContext(msg);
    await handleClear(b, { ...msg, tenantContext });
  }, { resolveAllowList }));

  b.onText(/^\/chatid(@\w+)?$/, guard(async (msg) => {
    const tenantContext = await resolveTenantContext(msg);
    await handleChatId(b, { ...msg, tenantContext });
  }, { resolveAllowList }));

  b.on('message', guard(async (msg) => {
    if (msg.text?.startsWith('/')) return;

    const tenantContext = await resolveTenantContext(msg);
    const { addressed, text } = parseGroupMessage(msg);
    if (!addressed) return;

    await handleMessage(b, { ...msg, text, tenantContext }, { tenantContext });
  }, { resolveAllowList }));

  b.on('polling_error', (err) => {
    logger.error('Telegram polling error', { error: err.message, code: err.code });
    if (err.message && err.message.includes('409')) {
      logger.warn('Telegram 409 conflict — another instance still running, retrying in 15 s');
      b.stopPolling()
        .then(() => new Promise(resolve => setTimeout(resolve, 15000)))
        .then(() => b.startPolling())
        .catch(restartErr => logger.error('Telegram polling restart failed', { error: restartErr.message }));
    }
  });

  b.on('error', (err) => {
    logger.error('Telegram bot error', { error: err.message });
  });
}

// ─── Shared: lazy bot for sending / webhook processing ───────────────────────

/**
 * Returns a bot instance suitable for sending messages or processing webhook
 * updates.  Does NOT start polling – safe to call in serverless functions.
 */
function _getOrCreateBot() {
  if (bot) return bot;
  bot = new TelegramBot(config.telegram.botToken, { polling: false });
  _registerHandlers(bot);
  return bot;
}

// ─── Polling mode (local dev) ─────────────────────────────────────────────────

function createBot() {
  if (bot) return bot;

  // node-telegram-bot-api uses @cypress/request-promise internally.
  // Pass the system HTTPS proxy so polling works inside proxied containers.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

  bot = new TelegramBot(config.telegram.botToken, {
    polling: { interval: 300, params: { timeout: 10 } },
    ...(proxyUrl && { request: { proxy: proxyUrl } }),
  });

  _registerHandlers(bot);

  // Debug: log every raw update – runs before the guard.
  bot.on('message', (msg) => {
    logger.debug('Telegram raw message received', {
      chatId: msg.chat?.id,
      chatType: msg.chat?.type,
      chatTitle: msg.chat?.title,
      fromId: msg.from?.id,
      fromUsername: msg.from?.username,
      text: msg.text?.slice(0, 60),
    });
  });

  // Fetch bot identity for @mention detection
  bot.getMe().then((info) => {
    botInfo = info;
    logger.info('Telegram bot started (long-polling)', {
      username: botInfo.username,
      id: botInfo.id,
      allowedUserIds: [...config.telegram.allowedUserIds],
      allowedGroupIds: [...config.telegram.allowedGroupIds],
    });
  }).catch((err) => {
    logger.error('Telegram getMe() failed', { error: err.message });
  });

  return bot;
}

// ─── Webhook mode (Vercel) ────────────────────────────────────────────────────

/**
 * Process a single Telegram update received via the /telegram POST endpoint.
 * Called by api/index.js on every incoming Telegram webhook request.
 */
async function processUpdate(update) {
  const b = _getOrCreateBot();

  // Populate botInfo on first call of each serverless invocation.
  // Needed so parseGroupMessage can detect @mentions and reply-to checks.
  if (!botInfo) {
    try {
      botInfo = await b.getMe();
      logger.debug('Telegram bot identity resolved (webhook mode)', {
        username: botInfo.username,
        id: botInfo.id,
      });
    } catch (err) {
      logger.error('Telegram getMe() failed in webhook mode', { error: err.message });
    }
  }

  b.processUpdate(update);
}

// ─── Proactive landlord notifications ────────────────────────────────────────

/**
 * Push a message to all whitelisted landlord users and groups.
 * Works in both polling and webhook mode.
 */
async function notifyLandlord(text, options = {}) {
  const tenantContext = options.tenantContext || null;

  const tenantTelegram = tenantContext?.integrations?.telegram || null;
  const token = tenantTelegram?.botToken || config.telegram.botToken;
  const recipientUsers = Array.isArray(tenantTelegram?.allowedUserIds)
    ? tenantTelegram.allowedUserIds
    : [...config.telegram.allowedUserIds];
  const recipientGroups = Array.isArray(tenantTelegram?.allowedGroupIds)
    ? tenantTelegram.allowedGroupIds
    : [...config.telegram.allowedGroupIds];

  const recipients = recipientGroups.length > 0 ? recipientGroups : recipientUsers;

  if (!token || recipients.length === 0) {
    logger.warn('Telegram notification skipped — no token or recipients configured');
    return;
  }

  const sendDirect = async (recipientId) => {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: recipientId,
      text,
      disable_web_page_preview: true,
    });
  };

  const useBotInstance = token === config.telegram.botToken;
  const b = useBotInstance ? _getOrCreateBot() : null;

  const results = await Promise.allSettled(
    recipients.map((id) => (useBotInstance ? b.sendMessage(id, text) : sendDirect(id)))
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error('Failed to deliver Telegram notification to landlord', {
        recipientId: recipients[i],
        error: r.reason?.message,
      });
    } else {
      logger.info('Telegram notification delivered', { recipientId: recipients[i] });
    }
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function stopBot() {
  if (bot) {
    await bot.stopPolling();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}

module.exports = { createBot, processUpdate, notifyLandlord, stopBot };
