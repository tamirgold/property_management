'use strict';

const path = require('path');
const PlatformStore = require('./store');
const logger = require('../logger');

const store = new PlatformStore({
  storagePath: process.env.PLATFORM_STORE_PATH || path.resolve(process.cwd(), 'platform-store.json'),
});

let bootstrapped = false;

async function bootstrapDefaults() {
  if (bootstrapped) return;
  await store.init();

  const tenantSlug = (process.env.DEFAULT_TENANT_SLUG || 'legacy-default').trim().toLowerCase();
  const tenantName = (process.env.DEFAULT_TENANT_NAME || 'Legacy Default Company').trim();

  let tenant = await store.getTenantBySlug(tenantSlug);
  if (!tenant) {
    tenant = await store.createTenant({
      slug: tenantSlug,
      name: tenantName,
      timezone: process.env.DEFAULT_TENANT_TIMEZONE || 'America/Los_Angeles',
      locale: process.env.DEFAULT_TENANT_LOCALE || 'en-US',
      currency: process.env.DEFAULT_TENANT_CURRENCY || 'USD',
    });

    logger.info('Created bootstrap tenant', {
      tenantId: tenant.id,
      slug: tenant.slug,
      webhookKey: tenant.webhookKey,
    });
  }

  // Seed integrations from existing single-tenant env vars (idempotent).
  const hasErpnextEnv = !!(process.env.ERPNEXT_BASE_URL && process.env.ERPNEXT_API_KEY && process.env.ERPNEXT_API_SECRET);
  if (hasErpnextEnv) {
    await store.setIntegrationConfig(tenant.id, 'erpnext', {
      baseUrl: process.env.ERPNEXT_BASE_URL,
      apiKey: process.env.ERPNEXT_API_KEY,
      apiSecret: process.env.ERPNEXT_API_SECRET,
      webhookSecret: process.env.WEBHOOK_SECRET || '',
    });
  }

  if (process.env.OPENAI_API_KEY) {
    await store.setIntegrationConfig(tenant.id, 'openai', {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o',
    });
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    await store.setIntegrationConfig(tenant.id, 'telegram', {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
        .split(',')
        .map(v => Number(v.trim()))
        .filter(Number.isFinite),
      allowedGroupIds: (process.env.TELEGRAM_ALLOWED_GROUP_IDS || '')
        .split(',')
        .map(v => Number(v.trim()))
        .filter(Number.isFinite),
    });
  }

  if (process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_FROM_NUMBER) {
    await store.setIntegrationConfig(tenant.id, 'twilio', {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    });
  }

  if (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_PUBLISHABLE_KEY) {
    await store.setIntegrationConfig(tenant.id, 'stripe', {
      secretKey: process.env.STRIPE_SECRET_KEY || '',
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
      paymentAccount: process.env.STRIPE_PAYMENT_ACCOUNT || 'Debtors - LD',
      bankAccount: process.env.STRIPE_BANK_ACCOUNT || '',
    });
  }

  bootstrapped = true;
}

async function getStore() {
  await bootstrapDefaults();
  return store;
}

module.exports = {
  getStore,
  bootstrapDefaults,
};
