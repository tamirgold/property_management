'use strict';

const express = require('express');
const logger = require('../logger');
const apiRoot = require('../api/index');
const { getStore } = require('./index');
const {
  beginLogin,
  verifyOtpAndCreateSession,
  requireAuth,
  inviteOrCreateTenantUser,
  bootstrapPlatformOwner,
  roleAtLeast,
  normalizeRole,
} = require('./auth');
const { buildTenantContext } = require('./runtime');

function parseBearer(req) {
  const raw = req.headers.authorization || '';
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  return raw.slice(7).trim();
}

function isSameTenantOrPlatformOwner(req, tenantId) {
  return req.auth?.user?.isPlatformOwner || req.auth?.tenant?.id === tenantId;
}

function requireTenantAccess(minRole = 'company_admin') {
  return async function (req, res, next) {
    const tenantId = req.params.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    if (!isSameTenantOrPlatformOwner(req, tenantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // If platform owner, no further checks.
    if (req.auth.user.isPlatformOwner) return next();

    const memberRole = normalizeRole(req.auth.role);
    if (!roleAtLeast(memberRole, minRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
}

function requireExactRole(role) {
  return function (req, res, next) {
    if (normalizeRole(req.auth?.role) !== normalizeRole(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}

async function getTenantApiForAuth(auth) {
  const tenantContext = await buildTenantContext(auth?.tenant);
  if (tenantContext && typeof apiRoot.forTenant === 'function') {
    return {
      api: apiRoot.forTenant(tenantContext),
      tenantContext,
    };
  }
  return {
    api: apiRoot,
    tenantContext: null,
  };
}

async function resolveTenantPortalCustomer(api, userEmail) {
  if (!api || typeof api.getTenants !== 'function') {
    const err = new Error('Tenant portal data source is not configured');
    err.statusCode = 503;
    throw err;
  }

  const normalizedEmail = String(userEmail || '').trim().toLowerCase();
  const customers = await api.getTenants({});
  const customer = customers.find(t => (t.email_id || '').trim().toLowerCase() === normalizedEmail);

  if (!customer) {
    const err = new Error('Tenant profile was not found for this account');
    err.statusCode = 404;
    throw err;
  }

  return customer;
}

function mapTenantLease(lease) {
  if (!lease) return null;
  return {
    leaseId: lease.name,
    property: lease.property || '',
    startDate: lease.start_date || '',
    endDate: lease.end_date || '',
    status: lease.lease_status || '',
    monthlyRent: lease.monthly_rent || '',
    noticePeriod: lease.notice_period || '',
  };
}

async function resolveActiveTenantLease(api, customerId) {
  if (typeof api.getLeases !== 'function') {
    const err = new Error('Tenant lease API is not configured');
    err.statusCode = 503;
    throw err;
  }

  const leases = await api.getLeases({ status: 'active' });
  return leases
    .filter(l => l.lease_customer === customerId)
    .sort((a, b) => String(a.end_date || '').localeCompare(String(b.end_date || '')))[0] || null;
}

function makePlatformRouter() {
  const router = express.Router();

  // Ensure owner account exists before first auth attempt.
  bootstrapPlatformOwner().catch(err => {
    logger.error('Platform owner bootstrap failed', { error: err.message });
  });

  router.post('/auth/login', async (req, res, next) => {
    try {
      const { email, password, tenantId, tenantSlug } = req.body || {};
      const response = await beginLogin({ email, password, tenantId, tenantSlug });
      res.json(response);
    } catch (err) {
      if (/Invalid credentials|member/.test(err.message)) {
        return res.status(401).json({ error: err.message });
      }
      return next(err);
    }
  });

  router.post('/auth/verify-otp', async (req, res, next) => {
    try {
      const { challengeId, code } = req.body || {};
      const session = await verifyOtpAndCreateSession({ challengeId, code });
      res.json(session);
    } catch (err) {
      if (/Invalid or expired OTP/.test(err.message)) {
        return res.status(401).json({ error: err.message });
      }
      return next(err);
    }
  });

  router.post('/auth/logout', async (req, res, next) => {
    try {
      const token = parseBearer(req);
      if (!token) return res.status(204).end();

      const store = await getStore();
      await store.deleteSession(token);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth({ minRole: 'tenant' }), async (req, res) => {
    res.json({
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        isPlatformOwner: !!req.auth.user.isPlatformOwner,
      },
      tenant: req.auth.tenant,
      membership: {
        ...req.auth.membership,
        role: normalizeRole(req.auth.membership?.role),
      },
      role: req.auth.role,
    });
  });

  router.get('/tenants', requireAuth({ minRole: 'tenant' }), async (req, res, next) => {
    try {
      const store = await getStore();
      if (req.auth.user.isPlatformOwner) {
        const all = await store.listTenants();
        return res.json(all);
      }

      const memberships = await store.listMembershipsForUser(req.auth.user.id);
      const tenantIds = memberships.filter(m => m.status === 'active').map(m => m.tenantId);
      const tenants = await Promise.all(tenantIds.map(id => store.getTenantById(id)));
      return res.json(tenants.filter(Boolean));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/tenants', requireAuth({ platformOwnerOnly: true }), async (req, res, next) => {
    try {
      const store = await getStore();
      const { name, slug, timezone, locale, currency, ownerEmail, ownerRole } = req.body || {};

      const tenant = await store.createTenant({
        name,
        slug,
        timezone: timezone || 'UTC',
        locale: locale || 'en-US',
        currency: currency || 'USD',
      });

      if (ownerEmail) {
        await inviteOrCreateTenantUser({
          tenantId: tenant.id,
          email: ownerEmail,
          role: ownerRole || 'company_admin',
        });
      }

      return res.status(201).json(tenant);
    } catch (err) {
      if (/cannot be assigned/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      return next(err);
    }
  });

  router.get('/tenants/:tenantId/settings', requireAuth({ minRole: 'company_user' }), requireTenantAccess('company_user'), async (req, res, next) => {
    try {
      const store = await getStore();
      const [tenant, settings] = await Promise.all([
        store.getTenantById(req.params.tenantId),
        store.getTenantSettings(req.params.tenantId),
      ]);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      res.json({
        ...(settings || {}),
        name: settings?.name || tenant.name,
        timezone: settings?.timezone || tenant.timezone,
        locale: settings?.locale || tenant.locale,
        currency: settings?.currency || tenant.currency,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/tenants/:tenantId/settings', requireAuth({ minRole: 'company_admin' }), requireTenantAccess('company_admin'), async (req, res, next) => {
    try {
      const store = await getStore();
      const payload = req.body || {};
      const tenantPatch = {};

      if (typeof payload.name === 'string' && payload.name.trim()) {
        tenantPatch.name = payload.name.trim();
      }
      if (typeof payload.timezone === 'string' && payload.timezone.trim()) {
        tenantPatch.timezone = payload.timezone.trim();
      }
      if (typeof payload.locale === 'string' && payload.locale.trim()) {
        tenantPatch.locale = payload.locale.trim();
      }
      if (typeof payload.currency === 'string' && payload.currency.trim()) {
        tenantPatch.currency = payload.currency.trim().toUpperCase();
      }

      if (Object.keys(tenantPatch).length > 0) {
        const updated = await store.updateTenant(req.params.tenantId, tenantPatch);
        if (!updated) return res.status(404).json({ error: 'Tenant not found' });
      }

      const saved = await store.saveTenantSettings(req.params.tenantId, payload);
      res.json(saved || {});
    } catch (err) {
      next(err);
    }
  });

  router.get('/tenants/:tenantId/runtime', requireAuth({ minRole: 'company_user' }), requireTenantAccess('company_user'), async (req, res, next) => {
    try {
      const store = await getStore();
      const tenant = await store.getTenantById(req.params.tenantId);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      const ctx = await buildTenantContext(tenant);
      res.json({
        tenant: ctx.tenant,
        timezone: ctx.timezone,
        locale: ctx.locale,
        currency: ctx.currency,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/tenants/:tenantId/integrations/:provider', requireAuth({ minRole: 'company_admin' }), requireTenantAccess('company_admin'), async (req, res, next) => {
    try {
      const store = await getStore();
      await store.setIntegrationConfig(req.params.tenantId, req.params.provider, req.body || {});
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tenants/:tenantId/integrations/:provider', requireAuth({ minRole: 'company_admin' }), requireTenantAccess('company_admin'), async (req, res, next) => {
    try {
      const store = await getStore();
      const integration = await store.getIntegrationConfig(req.params.tenantId, req.params.provider);
      res.json(integration || {});
    } catch (err) {
      next(err);
    }
  });

  router.get('/tenants/:tenantId/automations', requireAuth({ minRole: 'company_user' }), requireTenantAccess('company_user'), async (req, res, next) => {
    try {
      const store = await getStore();
      const settings = await store.getAutomationSettings(req.params.tenantId);
      res.json(settings || {});
    } catch (err) {
      next(err);
    }
  });

  router.put('/tenants/:tenantId/automations', requireAuth({ minRole: 'company_admin' }), requireTenantAccess('company_admin'), async (req, res, next) => {
    try {
      const store = await getStore();
      const saved = await store.saveAutomationSettings(req.params.tenantId, req.body || {});
      res.json(saved);
    } catch (err) {
      next(err);
    }
  });

  router.post('/tenants/:tenantId/users', requireAuth({ minRole: 'company_admin' }), requireTenantAccess('company_admin'), async (req, res, next) => {
    try {
      const { email, role } = req.body || {};
      const invited = await inviteOrCreateTenantUser({ tenantId: req.params.tenantId, email, role });
      res.status(201).json(invited);
    } catch (err) {
      if (/cannot be assigned/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  });

  router.get('/tenants/:tenantId/users', requireAuth({ minRole: 'company_admin' }), requireTenantAccess('company_admin'), async (req, res, next) => {
    try {
      const store = await getStore();
      const memberships = await store.listMembershipsForTenant(req.params.tenantId);
      const users = await Promise.all(memberships.map(m => store.getUserById(m.userId)));

      res.json(
        memberships.map((m, idx) => ({
          userId: m.userId,
          email: users[idx]?.email || '',
          role: normalizeRole(m.role),
          status: m.status,
        }))
      );
    } catch (err) {
      next(err);
    }
  });

  // Tenant renter self-service API (strictly tenant role, company-scoped).
  router.get('/tenant/me', requireAuth({ minRole: 'tenant' }), requireExactRole('tenant'), async (req, res, next) => {
    try {
      const { api } = await getTenantApiForAuth(req.auth);
      const customer = await resolveTenantPortalCustomer(api, req.auth.user.email);

      let activeLease = null;
      if (typeof api.getLeases === 'function') {
        activeLease = await resolveActiveTenantLease(api, customer.name);
      }

      return res.json({
        user: {
          id: req.auth.user.id,
          email: req.auth.user.email,
          role: 'tenant',
        },
        company: {
          id: req.auth.tenant.id,
          slug: req.auth.tenant.slug,
          name: req.auth.tenant.name,
        },
        tenantProfile: {
          customerId: customer.name,
          name: customer.customer_name || customer.name,
          email: customer.email_id || '',
          phone: customer.mobile_no || '',
          unit: customer.custom_unit || '',
        },
        activeLease: mapTenantLease(activeLease),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/tenant/lease', requireAuth({ minRole: 'tenant' }), requireExactRole('tenant'), async (req, res, next) => {
    try {
      const { api } = await getTenantApiForAuth(req.auth);
      const customer = await resolveTenantPortalCustomer(api, req.auth.user.email);
      const lease = await resolveActiveTenantLease(api, customer.name);
      return res.json({ lease: mapTenantLease(lease) });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/tenant/documents', requireAuth({ minRole: 'tenant' }), requireExactRole('tenant'), async (req, res, next) => {
    try {
      const leaseId = String(req.query.leaseId || '').trim();
      const { api } = await getTenantApiForAuth(req.auth);
      const customer = await resolveTenantPortalCustomer(api, req.auth.user.email);

      if (typeof api.getLeaseFiles !== 'function') {
        return res.status(503).json({ error: 'Tenant documents API is not configured' });
      }

      let lease = null;
      if (leaseId) {
        if (typeof api.getLeases !== 'function') {
          return res.status(503).json({ error: 'Tenant lease API is not configured' });
        }
        const leases = await api.getLeases({ status: 'all' });
        lease = leases.find(l => l.name === leaseId && l.lease_customer === customer.name) || null;
        if (!lease) {
          return res.status(404).json({ error: 'Lease not found for this tenant' });
        }
      } else {
        lease = await resolveActiveTenantLease(api, customer.name);
      }

      if (!lease) {
        return res.json({ lease: null, documents: [] });
      }

      const files = await api.getLeaseFiles(lease.name);
      return res.json({
        lease: mapTenantLease(lease),
        documents: (files || []).map(file => ({
          id: file.name,
          fileName: file.file_name || '',
          fileUrl: file.file_url || '',
          createdAt: file.creation || '',
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/tenant/invoices', requireAuth({ minRole: 'tenant' }), requireExactRole('tenant'), async (req, res, next) => {
    try {
      const status = String(req.query.status || '').trim().toLowerCase();
      if (status && !['all', 'paid', 'unpaid'].includes(status)) {
        return res.status(400).json({ error: 'status must be one of: all, paid, unpaid' });
      }

      const { api } = await getTenantApiForAuth(req.auth);
      const customer = await resolveTenantPortalCustomer(api, req.auth.user.email);
      if (typeof api.getTenantInvoices !== 'function') {
        return res.status(503).json({ error: 'Tenant invoices API is not configured' });
      }

      const invoices = await api.getTenantInvoices(customer.name, status && status !== 'all' ? { status } : {});
      return res.json(invoices || []);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/tenant/payments', requireAuth({ minRole: 'tenant' }), requireExactRole('tenant'), async (req, res, next) => {
    try {
      const { api } = await getTenantApiForAuth(req.auth);
      const customer = await resolveTenantPortalCustomer(api, req.auth.user.email);
      if (typeof api.getTenantPayments !== 'function') {
        return res.status(503).json({ error: 'Tenant payments API is not configured' });
      }
      const payments = await api.getTenantPayments(customer.name);
      return res.json(payments || []);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/tenant/tickets', requireAuth({ minRole: 'tenant' }), requireExactRole('tenant'), async (req, res, next) => {
    try {
      const { api } = await getTenantApiForAuth(req.auth);
      const customer = await resolveTenantPortalCustomer(api, req.auth.user.email);
      if (typeof api.getTenantTickets !== 'function') {
        return res.status(503).json({ error: 'Tenant tickets API is not configured' });
      }
      const tickets = await api.getTenantTickets(customer.name);
      return res.json(tickets || []);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/tenant/tickets', requireAuth({ minRole: 'tenant' }), requireExactRole('tenant'), async (req, res, next) => {
    try {
      const subject = String(req.body?.subject || '').trim();
      const description = String(req.body?.description || '').trim();
      const priority = String(req.body?.priority || 'Medium').trim();
      if (!subject) {
        return res.status(400).json({ error: 'subject is required' });
      }

      const { api } = await getTenantApiForAuth(req.auth);
      const customer = await resolveTenantPortalCustomer(api, req.auth.user.email);
      if (typeof api.createTenantTicket !== 'function') {
        return res.status(503).json({ error: 'Tenant ticket creation API is not configured' });
      }

      const created = await api.createTenantTicket(customer.name, {
        subject,
        description,
        priority,
        raisedBy: req.auth.user.email,
      });
      return res.status(201).json(created || {});
    } catch (err) {
      return next(err);
    }
  });

  router.use((err, _req, res, _next) => {
    logger.error('Platform API error', { error: err.message });
    const statusCode = Number(err.statusCode) || 500;
    res.status(statusCode).json({ error: err.message || 'Internal Server Error' });
  });

  return router;
}

module.exports = {
  makePlatformRouter,
};
