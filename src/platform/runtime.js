'use strict';

const { config } = require('../config');
const { getStore } = require('./index');

function withDefaults(integrations = {}) {
  return {
    erpnext: {
      baseUrl: integrations.erpnext?.baseUrl || config.pms.erpnext.baseUrl,
      apiKey: integrations.erpnext?.apiKey || config.pms.erpnext.apiKey,
      apiSecret: integrations.erpnext?.apiSecret || config.pms.erpnext.apiSecret,
      webhookSecret: integrations.erpnext?.webhookSecret || config.webhook.secret || '',
    },
    openai: {
      apiKey: integrations.openai?.apiKey || config.openai.apiKey,
      model: integrations.openai?.model || config.openai.model,
    },
    telegram: {
      botToken: integrations.telegram?.botToken || config.telegram.botToken,
      allowedUserIds: Array.isArray(integrations.telegram?.allowedUserIds)
        ? integrations.telegram.allowedUserIds
        : [...config.telegram.allowedUserIds],
      allowedGroupIds: Array.isArray(integrations.telegram?.allowedGroupIds)
        ? integrations.telegram.allowedGroupIds
        : [...config.telegram.allowedGroupIds],
    },
    twilio: {
      accountSid: integrations.twilio?.accountSid || process.env.TWILIO_ACCOUNT_SID || '',
      authToken: integrations.twilio?.authToken || process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: integrations.twilio?.fromNumber || process.env.TWILIO_FROM_NUMBER || '',
    },
    stripe: {
      secretKey: integrations.stripe?.secretKey || config.stripe.secretKey,
      publishableKey: integrations.stripe?.publishableKey || config.stripe.publishableKey,
      webhookSecret: integrations.stripe?.webhookSecret || config.stripe.webhookSecret,
      paymentAccount: integrations.stripe?.paymentAccount || config.stripe.paymentAccount,
      bankAccount: integrations.stripe?.bankAccount || config.stripe.bankAccount,
    },
  };
}

async function buildTenantContext(tenant) {
  if (!tenant) return null;

  const store = await getStore();
  const [integrations, settings] = await Promise.all([
    store.listIntegrationConfigs(tenant.id),
    store.getTenantSettings(tenant.id),
  ]);

  const mergedIntegrations = withDefaults(integrations);

  return {
    source: 'platform',
    tenant,
    tenantId: tenant.id,
    settings: settings || {},
    integrations: mergedIntegrations,
    timezone: tenant.timezone || 'UTC',
    locale: tenant.locale || 'en-US',
    currency: tenant.currency || 'USD',
  };
}

async function getTenantContextById(tenantId) {
  const store = await getStore();
  const tenant = await store.getTenantById(tenantId);
  return buildTenantContext(tenant);
}

async function getTenantContextByWebhookKey(webhookKey) {
  const store = await getStore();
  const tenant = await store.getTenantByWebhookKey(webhookKey);
  return buildTenantContext(tenant);
}

async function getTenantContextBySlug(slug) {
  const store = await getStore();
  const tenant = await store.getTenantBySlug(slug);
  return buildTenantContext(tenant);
}

async function getDefaultTenantContext() {
  const slug = (process.env.DEFAULT_TENANT_SLUG || 'legacy-default').trim().toLowerCase();
  const fromSlug = await getTenantContextBySlug(slug);
  if (fromSlug) return fromSlug;

  const store = await getStore();
  const tenants = await store.listTenants();
  if (!tenants.length) return null;
  return buildTenantContext(tenants[0]);
}

async function getTenantContextForTelegramPrincipal({ userId, chatId }) {
  const store = await getStore();
  const tenant = await store.findTenantByTelegramPrincipal({ userId, chatId });
  if (!tenant) return null;
  return buildTenantContext(tenant);
}

async function getTenantContextFromRequest(req) {
  const explicitTenantId = String(req.headers['x-tenant-id'] || req.query?.tenant_id || '').trim();
  if (explicitTenantId) {
    const byId = await getTenantContextById(explicitTenantId);
    if (byId) return byId;
  }

  const paramKey = String(req.params?.tenantKey || '').trim();
  if (paramKey) {
    const byKey = await getTenantContextByWebhookKey(paramKey);
    if (byKey) return byKey;
  }

  return getDefaultTenantContext();
}

module.exports = {
  getDefaultTenantContext,
  getTenantContextById,
  getTenantContextBySlug,
  getTenantContextByWebhookKey,
  getTenantContextForTelegramPrincipal,
  getTenantContextFromRequest,
  buildTenantContext,
};
