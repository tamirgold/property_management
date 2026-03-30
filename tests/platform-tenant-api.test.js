'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

function uniqueStorePath() {
  return path.join(
    os.tmpdir(),
    `platform-tenant-api-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

describe('tenant self-service API (/api/v2/tenant/*)', () => {
  let app;
  let tenantId;
  let inviteOrCreateTenantUser;
  let storePath;
  let mockClient;
  let mockForTenant;

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

    mockClient = {
      getTenants: jest.fn(),
      getLeases: jest.fn(),
      getLeaseFiles: jest.fn(),
      getTenantInvoices: jest.fn(),
      getTenantPayments: jest.fn(),
      getTenantTickets: jest.fn(),
      createTenantTicket: jest.fn(),
    };

    mockForTenant = jest.fn(() => mockClient);

    jest.doMock('../src/api/index', () => ({
      forTenant: mockForTenant,
      ...mockClient,
    }));

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

  test('tenant can read /tenant/me and /tenant/lease with linked customer and active lease', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'renter@example.com',
      role: 'tenant',
      password: 'RenterPass123!',
    });

    mockClient.getTenants.mockResolvedValue([
      { name: 'CUST-OTHER', customer_name: 'Other Person', email_id: 'other@example.com' },
      {
        name: 'CUST-0001',
        customer_name: 'Renter One',
        email_id: 'renter@example.com',
        mobile_no: '+14155550001',
        custom_unit: 'Unit 2A',
      },
    ]);

    mockClient.getLeases.mockResolvedValue([
      {
        name: 'LEASE-0001',
        lease_customer: 'CUST-0001',
        property: 'Unit 2A',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        lease_status: 'Active',
        monthly_rent: 2100,
        notice_period: 30,
      },
    ]);

    const token = await login('renter@example.com', 'RenterPass123!');

    const res = await request(app)
      .get('/api/v2/tenant/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('renter@example.com');
    expect(res.body.user.role).toBe('tenant');
    expect(res.body.tenantProfile.customerId).toBe('CUST-0001');
    expect(res.body.activeLease.leaseId).toBe('LEASE-0001');
    expect(mockForTenant).toHaveBeenCalled();

    const leaseRes = await request(app)
      .get('/api/v2/tenant/lease')
      .set('Authorization', `Bearer ${token}`);
    expect(leaseRes.status).toBe(200);
    expect(leaseRes.body.lease.leaseId).toBe('LEASE-0001');
  });

  test('tenant can read invoices/payments/tickets and create a ticket', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'renter2@example.com',
      role: 'tenant',
      password: 'RenterPass123!',
    });

    mockClient.getTenants.mockResolvedValue([
      { name: 'CUST-0002', customer_name: 'Renter Two', email_id: 'renter2@example.com' },
    ]);
    mockClient.getTenantInvoices.mockResolvedValue([{ name: 'ACC-SINV-0001' }]);
    mockClient.getTenantPayments.mockResolvedValue([{ name: 'PAY-0001' }]);
    mockClient.getTenantTickets.mockResolvedValue([{ name: 'HDT-0001' }]);
    mockClient.createTenantTicket.mockResolvedValue({ name: 'HDT-0002', status: 'Open' });

    const token = await login('renter2@example.com', 'RenterPass123!');

    const invoicesRes = await request(app)
      .get('/api/v2/tenant/invoices?status=unpaid')
      .set('Authorization', `Bearer ${token}`);
    expect(invoicesRes.status).toBe(200);
    expect(invoicesRes.body).toEqual([{ name: 'ACC-SINV-0001' }]);
    expect(mockClient.getTenantInvoices).toHaveBeenCalledWith('CUST-0002', { status: 'unpaid' });

    const paymentsRes = await request(app)
      .get('/api/v2/tenant/payments')
      .set('Authorization', `Bearer ${token}`);
    expect(paymentsRes.status).toBe(200);
    expect(paymentsRes.body).toEqual([{ name: 'PAY-0001' }]);

    const ticketsRes = await request(app)
      .get('/api/v2/tenant/tickets')
      .set('Authorization', `Bearer ${token}`);
    expect(ticketsRes.status).toBe(200);
    expect(ticketsRes.body).toEqual([{ name: 'HDT-0001' }]);

    const createRes = await request(app)
      .post('/api/v2/tenant/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Broken AC', description: 'No cold air', priority: 'High' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('HDT-0002');
    expect(mockClient.createTenantTicket).toHaveBeenCalledWith('CUST-0002', {
      subject: 'Broken AC',
      description: 'No cold air',
      priority: 'High',
      raisedBy: 'renter2@example.com',
    });
  });

  test('tenant can read lease documents for own lease and cannot access other tenant lease docs', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'docs@example.com',
      role: 'tenant',
      password: 'DocsPass123!',
    });

    mockClient.getTenants.mockResolvedValue([
      { name: 'CUST-0003', customer_name: 'Doc Tenant', email_id: 'docs@example.com' },
    ]);
    mockClient.getLeases.mockResolvedValue([
      {
        name: 'LEASE-OWN-1',
        lease_customer: 'CUST-0003',
        property: 'Unit 9B',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        lease_status: 'Active',
      },
      {
        name: 'LEASE-OTHER-1',
        lease_customer: 'CUST-OTHER',
        property: 'Unit 8A',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        lease_status: 'Active',
      },
    ]);
    mockClient.getLeaseFiles.mockResolvedValue([
      {
        name: 'FILE-001',
        file_name: 'signed-lease.pdf',
        file_url: '/private/files/signed-lease.pdf',
        creation: '2026-02-01 10:00:00',
      },
    ]);

    const token = await login('docs@example.com', 'DocsPass123!');

    const docsRes = await request(app)
      .get('/api/v2/tenant/documents')
      .set('Authorization', `Bearer ${token}`);
    expect(docsRes.status).toBe(200);
    expect(docsRes.body.lease.leaseId).toBe('LEASE-OWN-1');
    expect(docsRes.body.documents).toHaveLength(1);
    expect(docsRes.body.documents[0].fileName).toBe('signed-lease.pdf');

    const forbiddenLeaseRes = await request(app)
      .get('/api/v2/tenant/documents?leaseId=LEASE-OTHER-1')
      .set('Authorization', `Bearer ${token}`);
    expect(forbiddenLeaseRes.status).toBe(404);
  });

  test('company users cannot access tenant self-service endpoints', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'staff@example.com',
      role: 'company_user',
      password: 'StaffPass123!',
    });

    const token = await login('staff@example.com', 'StaffPass123!');

    const res = await request(app)
      .get('/api/v2/tenant/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('returns 400 for invalid invoice status filter and 404 when tenant profile mapping is missing', async () => {
    await inviteOrCreateTenantUser({
      tenantId,
      email: 'nomap@example.com',
      role: 'tenant',
      password: 'NoMapPass123!',
    });

    const token = await login('nomap@example.com', 'NoMapPass123!');

    const invalidStatusRes = await request(app)
      .get('/api/v2/tenant/invoices?status=oops')
      .set('Authorization', `Bearer ${token}`);
    expect(invalidStatusRes.status).toBe(400);

    mockClient.getTenants.mockResolvedValue([]);
    const notFoundRes = await request(app)
      .get('/api/v2/tenant/me')
      .set('Authorization', `Bearer ${token}`);
    expect(notFoundRes.status).toBe(404);
  });
});
