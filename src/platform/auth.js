'use strict';

const crypto = require('crypto');
const logger = require('../logger');
const { getStore } = require('./index');
const { getDefaultTenantContext } = require('./runtime');

const ROLE_ORDER = [
  'tenant',
  'company_user',
  'company_admin',
  'saas_admin',
];

const ROLE_ALIASES = {
  tenant_viewer: 'company_user',
  tenant_operator: 'company_user',
  tenant_admin: 'company_admin',
  tenant_owner: 'company_admin',
  platform_owner: 'saas_admin',
};

function normalizeRole(role) {
  const raw = String(role || '').trim().toLowerCase();
  const resolved = ROLE_ALIASES[raw] || raw;
  if (ROLE_ORDER.includes(resolved)) return resolved;
  return 'tenant';
}

function normalizeMembershipRole(role) {
  const normalized = normalizeRole(role);
  // Memberships are company-scoped; global admin comes from isPlatformOwner.
  return normalized === 'saas_admin' ? 'company_admin' : normalized;
}

function roleAtLeast(actual, required) {
  const a = ROLE_ORDER.indexOf(normalizeRole(actual));
  const b = ROLE_ORDER.indexOf(normalizeRole(required));
  return a >= b;
}

function normalizeAssignableRole(role) {
  const normalized = normalizeRole(role);
  if (normalized === 'saas_admin') {
    throw new Error('saas_admin cannot be assigned as a company membership role');
  }
  return normalizeMembershipRole(normalized);
}

function randomOtp() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function parseHash(value) {
  const [algo, salt, hash] = String(value || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return null;
  return { salt, hash };
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password) {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const parsed = parseHash(storedHash);
  if (!parsed) return false;

  const key = await scryptAsync(password, parsed.salt);
  const stored = Buffer.from(parsed.hash, 'hex');

  if (key.length !== stored.length) return false;
  return crypto.timingSafeEqual(key, stored);
}

async function bootstrapPlatformOwner() {
  const ownerEmail = String(process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  const ownerPassword = String(process.env.PLATFORM_OWNER_PASSWORD || '');

  if (!ownerEmail || !ownerPassword) return;

  const store = await getStore();
  let user = await store.getUserByEmail(ownerEmail);

  if (!user) {
    user = await store.createUser({
      email: ownerEmail,
      passwordHash: await hashPassword(ownerPassword),
      isPlatformOwner: true,
      status: 'active',
    });
    logger.info('Bootstrapped platform owner account', { email: ownerEmail, userId: user.id });
  }

  // Ensure platform owner belongs to the default tenant for initial admin access.
  const defaultCtx = await getDefaultTenantContext();
  if (defaultCtx) {
    const existingMembership = await store.getMembership(user.id, defaultCtx.tenantId);
    if (!existingMembership) {
      await store.createMembership({
        userId: user.id,
        tenantId: defaultCtx.tenantId,
        role: 'company_admin',
        status: 'active',
      });
    }
  }
}

async function beginLogin({ email, password, tenantId, tenantSlug }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedTenantSlug = String(tenantSlug || '').trim().toLowerCase();
  if (!normalizedEmail || !password || (!tenantId && !normalizedTenantSlug)) {
    throw new Error('email, password, and tenantId or tenantSlug are required');
  }

  const store = await getStore();
  const user = await store.getUserByEmail(normalizedEmail);
  if (!user || user.status !== 'active') {
    throw new Error('Invalid credentials');
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  let resolvedTenantId = tenantId;
  if (!resolvedTenantId && normalizedTenantSlug) {
    const tenant = await store.getTenantBySlug(normalizedTenantSlug);
    resolvedTenantId = tenant?.id || '';
  }

  const membership = await store.getMembership(user.id, resolvedTenantId);
  if (!membership || membership.status !== 'active') {
    throw new Error('User is not a member of this company');
  }

  const code = randomOtp();
  const challenge = await store.createOtpChallenge({
    userId: user.id,
    tenantId: resolvedTenantId,
    code,
    ttlSeconds: 600,
  });

  // In production this should be delivered by email/SMS provider.
  logger.info('OTP challenge generated', {
    email: normalizedEmail,
    tenantId: resolvedTenantId,
    challengeId: challenge.id,
    otp: code,
  });

  return {
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt,
    // Temporary fallback until OTP delivery is wired to SMS/email.
    delivery: 'preview',
    otpPreview: code,
  };
}

async function verifyOtpAndCreateSession({ challengeId, code }) {
  const store = await getStore();

  const challenge = await store.consumeOtpChallenge({ challengeId, code });
  if (!challenge) {
    throw new Error('Invalid or expired OTP code');
  }

  const [user, tenant, membership] = await Promise.all([
    store.getUserById(challenge.userId),
    store.getTenantById(challenge.tenantId),
    store.getMembership(challenge.userId, challenge.tenantId),
  ]);

  if (!user || user.status !== 'active') throw new Error('User is inactive');
  if (!tenant || tenant.status !== 'active') throw new Error('Tenant is inactive');
  if (!membership || membership.status !== 'active') throw new Error('Membership is inactive');

  const session = await store.createSession({
    userId: user.id,
    tenantId: tenant.id,
    ttlSeconds: 7 * 24 * 3600,
  });

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      email: user.email,
      isPlatformOwner: !!user.isPlatformOwner,
      role: user.isPlatformOwner ? 'saas_admin' : normalizeMembershipRole(membership.role),
    },
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
      locale: tenant.locale,
      currency: tenant.currency,
    },
  };
}

async function getAuthContextFromToken(bearerToken) {
  const token = String(bearerToken || '').trim();
  if (!token) return null;

  const store = await getStore();
  const session = await store.getSession(token);
  if (!session) return null;

  const [user, tenant, membership] = await Promise.all([
    store.getUserById(session.userId),
    store.getTenantById(session.tenantId),
    store.getMembership(session.userId, session.tenantId),
  ]);

  if (!user || user.status !== 'active') return null;
  if (!tenant || tenant.status !== 'active') return null;
  if (!membership || membership.status !== 'active') return null;

  const effectiveRole = user.isPlatformOwner ? 'saas_admin' : normalizeMembershipRole(membership.role);

  return {
    token,
    user,
    tenant,
    membership,
    role: effectiveRole,
  };
}

function parseBearer(req) {
  const raw = req.headers.authorization || '';
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  return raw.slice(7).trim();
}

function requireAuth({ minRole = 'tenant', platformOwnerOnly = false } = {}) {
  return async function (req, res, next) {
    try {
      const token = parseBearer(req);
      const auth = await getAuthContextFromToken(token);
      if (!auth) return res.status(401).json({ error: 'Unauthorized' });

      if (platformOwnerOnly && !auth.user.isPlatformOwner) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (!platformOwnerOnly && !roleAtLeast(auth.role, minRole)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      req.auth = auth;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

async function inviteOrCreateTenantUser({ tenantId, email, role = 'company_user', password }) {
  const store = await getStore();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedRole = normalizeAssignableRole(role);
  if (!tenantId || !normalizedEmail) throw new Error('tenantId and email are required');

  let user = await store.getUserByEmail(normalizedEmail);
  if (!user) {
    const pass = password || crypto.randomBytes(8).toString('hex');
    user = await store.createUser({
      email: normalizedEmail,
      passwordHash: await hashPassword(pass),
      status: 'active',
      isPlatformOwner: false,
    });

    logger.info('Created tenant user', {
      tenantId,
      userId: user.id,
      email: normalizedEmail,
      temporaryPassword: process.env.NODE_ENV === 'production' ? '(hidden)' : pass,
    });
  }

  await store.createMembership({
    userId: user.id,
    tenantId,
    role: normalizedRole,
    status: 'active',
  });

  return {
    userId: user.id,
    email: user.email,
    role: normalizedRole,
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  bootstrapPlatformOwner,
  beginLogin,
  verifyOtpAndCreateSession,
  getAuthContextFromToken,
  requireAuth,
  inviteOrCreateTenantUser,
  roleAtLeast,
  normalizeRole,
};
