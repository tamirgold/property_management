'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');

const execFileAsync = promisify(execFile);

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

function getErpnextPortalUrls(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return {
      deskUrl: '',
      loginUrl: '',
      invoicesUrl: '',
      paidInvoicesUrl: '',
      helpdeskUrl: '',
      leaseUrl: '',
      documentsUrl: '',
      applyUrl: '',
    };
  }

  return {
    deskUrl: `${normalized}/app`,
    loginUrl: `${normalized}/login`,
    invoicesUrl: `${normalized}/my-invoices`,
    paidInvoicesUrl: `${normalized}/paid-invoices`,
    helpdeskUrl: `${normalized}/helpdesk`,
    leaseUrl: `${normalized}/my-lease`,
    documentsUrl: `${normalized}/my-docs`,
    applyUrl: `${normalized}/apply`,
  };
}

async function validateErpnextConnection({ baseUrl, apiKey, apiSecret }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl || !apiKey || !apiSecret) {
    throw new Error('ERPNext base URL, API key, and API secret are required');
  }

  const { data } = await axios.get(`${normalizedBaseUrl}/api/method/ping`, {
    headers: {
      Authorization: `token ${apiKey}:${apiSecret}`,
      Accept: 'application/json',
    },
    timeout: 20_000,
  });

  if (!data || data.message !== 'pong') {
    throw new Error('ERPNext ping failed');
  }

  return { ok: true };
}

async function runNodeScript(scriptName, env) {
  const scriptPath = path.resolve(process.cwd(), 'scripts', scriptName);
  try {
    const result = await execFileAsync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8,
    });

    return {
      script: scriptName,
      success: true,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    const failure = new Error(`ERPNext bootstrap failed in ${scriptName}: ${err.stderr || err.message}`);
    failure.script = scriptName;
    failure.stdout = err.stdout || '';
    failure.stderr = err.stderr || '';
    failure.exitCode = typeof err.code === 'number' ? err.code : null;
    throw failure;
  }
}

async function bootstrapErpnextIntegration(options) {
  const baseUrl = normalizeBaseUrl(options?.baseUrl);
  const apiKey = String(options?.apiKey || '').trim();
  const apiSecret = String(options?.apiSecret || '').trim();
  const webhookSecret = String(options?.webhookSecret || '').trim();
  const webhookBaseUrl = normalizeBaseUrl(options?.webhookBaseUrl || process.env.WEBHOOK_BASE_URL);
  const stripePublishableKey = String(options?.stripePublishableKey || '').trim();
  const stripeSecretKey = String(options?.stripeSecretKey || '').trim();
  const stripePaymentAccount = String(options?.stripePaymentAccount || '').trim();
  const stripeBankAccount = String(options?.stripeBankAccount || '').trim();
  const telegramAllowedGroupIds = Array.isArray(options?.telegramAllowedGroupIds)
    ? options.telegramAllowedGroupIds.join(',')
    : String(options?.telegramAllowedGroupIds || '').trim();

  await validateErpnextConnection({ baseUrl, apiKey, apiSecret });

  const sharedEnv = {
    ERPNEXT_BASE_URL: baseUrl,
    ERPNEXT_API_KEY: apiKey,
    ERPNEXT_API_SECRET: apiSecret,
    WEBHOOK_SECRET: webhookSecret || process.env.WEBHOOK_SECRET || '',
    WEBHOOK_BASE_URL: webhookBaseUrl,
    STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
    STRIPE_SECRET_KEY: stripeSecretKey,
    STRIPE_PAYMENT_ACCOUNT: stripePaymentAccount,
    STRIPE_BANK_ACCOUNT: stripeBankAccount,
    TELEGRAM_ALLOWED_GROUP_IDS: telegramAllowedGroupIds,
  };

  const outputs = [];
  outputs.push(await runNodeScript('setup-erpnext-fields.js', sharedEnv));
  outputs.push(await runNodeScript('run-erpnext-setup.js', sharedEnv));
  outputs.push(await runNodeScript('setup-tenant-portal.js', sharedEnv));

  return {
    success: true,
    baseUrl,
    portalUrls: getErpnextPortalUrls(baseUrl),
    outputs: outputs.map(item => ({
      script: item.script,
      success: item.success,
      stdout: item.stdout.trim(),
      stderr: item.stderr.trim(),
    })),
  };
}

module.exports = {
  bootstrapErpnextIntegration,
  getErpnextPortalUrls,
  normalizeBaseUrl,
  validateErpnextConnection,
};
