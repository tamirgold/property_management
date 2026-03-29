'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const OWNER_EMAIL = 'saas.owner@example.com';
const OWNER_PASSWORD = 'OwnerPass123!';

function uniqueStorePath() {
  return path.join(
    os.tmpdir(),
    `platform-store-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

describe('platform role model and RBAC', () => {
  let app;
  let inviteOrCreateTenantUser;
  let tenantId;
  let storePath;

  async function login(email, password, tenantSlug = 'legacy-default') {
    const loginRes = await request(app)
      .post('/api/v2/auth/login')
      .send({ email, password, tenantSlug });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.challengeId).toBeTruthy();
    expect(loginRes.body.otpPreview).toMatch(/^\d{6}$/);

    const verifyRes = await request(app)
      .post('/api/v2/auth/verify-otp')
      .send({ challengeId: loginRes.body.challengeId, code: loginRes.body.otpPreview });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.token).toBeTruthy();
    return verifyRes.body;
  }

  beforeEach(async () => {
    jest.resetModules();

    storePath = uniqueStorePath();
    process.env.PLATFORM_MULTI_TENANT = '1';
    process.env.PLATFORM_STORE_PATH = storePath;
    process.env.PLATFORM_OWNER_EMAIL = OWNER_EMAIL;
    process.env.PLATFORM_OWNER_PASSWORD = OWNER_PASSWORD;
    process.env.DEFAULT_TENANT_SLUG = 'legacy-default';
    process.env.DEFAULT_TENANT_NAME = 'Legacy Default Company';

    const platform = require('../src/platform');
    const auth = require('../src/platform/auth');

    await platform.bootstrapDefaults();
    await auth.bootstrapPlatformOwner();

    const store = await platform.getStore();
    const tenant = await store.getTenantBySlug('legacy-default');
    tenantId = tenant.id;

    inviteOrCreateTenantUser = auth.inviteOrCreateTenantUser;

    const { createWebhookApp } = require('../src/webhook/server');
    app = createWebhookApp();
  });

  afterEach(() => {
    if (storePath) fs.rmSync(storePath, { force: true });
  });

  test('normalizes legacy roles to canonical 4-role model', () => {
    const { normalizeRole } = require('../src/platform/auth');

    expect(normalizeRole('platform_owner')).toBe('saas_admin');
    expect(normalizeRole('tenant_owner')).toBe('company_admin');
    expect(normalizeRole('tenant_admin')).toBe('company_admin');
    expect(normalizeRole('tenant_operator')).toBe('company_user');
    expect(normalizeRole('tenant_viewer')).toBe('company_user');
    expect(normalizeRole('tenant')).toBe('tenant');
  });

  test('multi-tenant admin routes serve SaaS console at /admin and legacy UI at /admin/legacy', async () => {
    const adminRes = await request(app).get('/admin');
    expect(adminRes.status).toBe(200);
    expect(adminRes.text).toContain('Global Property SaaS Control Center');

    const legacyRes = await request(app).get('/admin/legacy');
    expect(legacyRes.status).toBe(200);
    expect(legacyRes.text).toContain('Property Automations');
  });

  test('company_user can read settings but cannot invite users', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'ops.user@example.com',
      role: 'company_user',
      password: 'OpsUserPass123!',
    });

    const session = await login('ops.user@example.com', 'OpsUserPass123!');

    const settingsRes = await request(app)
      .get(`/api/v2/tenants/${tenantId}/settings`)
      .set('Authorization', `Bearer ${session.token}`);
    expect(settingsRes.status).toBe(200);

    const inviteRes = await request(app)
      .post(`/api/v2/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({ email: 'new.member@example.com', role: 'company_user' });
    expect(inviteRes.status).toBe(403);
  });

  test('tenant renter cannot access company management endpoints', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'renter@example.com',
      role: 'tenant',
      password: 'RenterPass123!',
    });

    const session = await login('renter@example.com', 'RenterPass123!');

    const settingsRes = await request(app)
      .get(`/api/v2/tenants/${tenantId}/settings`)
      .set('Authorization', `Bearer ${session.token}`);
    expect(settingsRes.status).toBe(403);

    const automationsRes = await request(app)
      .get(`/api/v2/tenants/${tenantId}/automations`)
      .set('Authorization', `Bearer ${session.token}`);
    expect(automationsRes.status).toBe(403);
  });

  test('company_admin can add company users but cannot assign saas_admin via membership role', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'admin.company@example.com',
      role: 'company_admin',
      password: 'CompanyAdmin123!',
    });

    const session = await login('admin.company@example.com', 'CompanyAdmin123!');

    const invalidRoleRes = await request(app)
      .post(`/api/v2/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({ email: 'should.fail@example.com', role: 'saas_admin' });

    expect(invalidRoleRes.status).toBe(400);
    expect(invalidRoleRes.body.error).toMatch(/cannot be assigned/i);

    const validInviteRes = await request(app)
      .post(`/api/v2/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({ email: 'staff.member@example.com', role: 'company_user' });

    expect(validInviteRes.status).toBe(201);
    expect(validInviteRes.body.role).toBe('company_user');
  });

  test('only saas_admin can create new companies', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'admin.only@example.com',
      role: 'company_admin',
      password: 'AdminOnly123!',
    });

    const companyAdminSession = await login('admin.only@example.com', 'AdminOnly123!');
    const ownerSession = await login(OWNER_EMAIL, OWNER_PASSWORD);

    const forbiddenRes = await request(app)
      .post('/api/v2/tenants')
      .set('Authorization', `Bearer ${companyAdminSession.token}`)
      .send({ name: 'Forbidden Company', slug: 'forbidden-company' });

    expect(forbiddenRes.status).toBe(403);

    const createdRes = await request(app)
      .post('/api/v2/tenants')
      .set('Authorization', `Bearer ${ownerSession.token}`)
      .send({
        name: 'Northwind Property',
        slug: 'northwind-property',
        timezone: 'America/New_York',
        locale: 'en-US',
        currency: 'USD',
      });

    expect(createdRes.status).toBe(201);
    expect(createdRes.body.slug).toBe('northwind-property');

    const meRes = await request(app)
      .get('/api/v2/me')
      .set('Authorization', `Bearer ${ownerSession.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.role).toBe('saas_admin');
  });
});
