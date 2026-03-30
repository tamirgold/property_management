'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

function uniqueStorePath() {
  return path.join(
    os.tmpdir(),
    `platform-erpnext-bootstrap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

describe('ERPNext bootstrap API', () => {
  let app;
  let tenantId;
  let storePath;
  let inviteOrCreateTenantUser;
  let bootstrapErpnextIntegration;

  async function login(email, password, tenantSlug = 'legacy-default') {
    const loginRes = await request(app)
      .post('/api/v2/auth/login')
      .send({ email, password, tenantSlug });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeTruthy();
    return loginRes.body.token;
  }

  beforeEach(async () => {
    jest.resetModules();

    storePath = uniqueStorePath();
    process.env.PLATFORM_MULTI_TENANT = '1';
    process.env.PLATFORM_STORE_PATH = storePath;
    process.env.PLATFORM_OWNER_EMAIL = 'owner@example.com';
    process.env.PLATFORM_OWNER_PASSWORD = 'OwnerPass123!';
    process.env.DEFAULT_TENANT_SLUG = 'legacy-default';
    process.env.DEFAULT_TENANT_NAME = 'Legacy Default Company';
    process.env.WEBHOOK_BASE_URL = 'https://pm.betterdeal.ai';

    bootstrapErpnextIntegration = jest.fn().mockResolvedValue({
      success: true,
      baseUrl: 'https://erp.example.com',
      portalUrls: {
        loginUrl: 'https://erp.example.com/login',
        invoicesUrl: 'https://erp.example.com/my-invoices',
      },
      outputs: [
        { script: 'setup-erpnext-fields.js', success: true, stdout: 'ok', stderr: '' },
      ],
    });

    jest.doMock('../src/platform/erpnext-bootstrap', () => ({
      bootstrapErpnextIntegration,
      getErpnextPortalUrls: jest.fn(baseUrl => ({
        loginUrl: `${baseUrl}/login`,
      })),
    }));

    const platform = require('../src/platform');
    const auth = require('../src/platform/auth');
    await platform.bootstrapDefaults();
    await auth.bootstrapPlatformOwner();

    const store = await platform.getStore();
    const tenant = await store.getTenantBySlug('legacy-default');
    tenantId = tenant.id;
    inviteOrCreateTenantUser = auth.inviteOrCreateTenantUser;

    await store.setIntegrationConfig(tenantId, 'erpnext', {
      baseUrl: 'https://erp.example.com',
      apiKey: 'erp-key',
      apiSecret: 'erp-secret',
      webhookSecret: 'erp-webhook',
    });

    await store.setIntegrationConfig(tenantId, 'stripe', {
      publishableKey: 'pk_live_123',
      secretKey: 'sk_live_123',
      paymentAccount: 'Debtors - LD',
    });

    await store.setIntegrationConfig(tenantId, 'telegram', {
      allowedGroupIds: [-1001234567890],
    });

    const { createWebhookApp } = require('../src/webhook/server');
    app = createWebhookApp();
  });

  afterEach(() => {
    if (storePath) fs.rmSync(storePath, { force: true });
  });

  test('company admin can run ERPNext bootstrap with saved tenant integration config', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'admin@example.com',
      role: 'company_admin',
      password: 'CompanyAdmin123!',
    });

    const token = await login('admin@example.com', 'CompanyAdmin123!');

    const res = await request(app)
      .post(`/api/v2/tenants/${tenantId}/integrations/erpnext/bootstrap`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(bootstrapErpnextIntegration).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://erp.example.com',
      apiKey: 'erp-key',
      apiSecret: 'erp-secret',
      webhookSecret: 'erp-webhook',
      webhookBaseUrl: 'https://pm.betterdeal.ai',
      stripePublishableKey: 'pk_live_123',
      stripeSecretKey: 'sk_live_123',
      stripePaymentAccount: 'Debtors - LD',
      telegramAllowedGroupIds: [-1001234567890],
    }));
  });

  test('company user cannot run ERPNext bootstrap', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'ops@example.com',
      role: 'company_user',
      password: 'CompanyUser123!',
    });

    const token = await login('ops@example.com', 'CompanyUser123!');

    const res = await request(app)
      .post(`/api/v2/tenants/${tenantId}/integrations/erpnext/bootstrap`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(bootstrapErpnextIntegration).not.toHaveBeenCalled();
  });
});
