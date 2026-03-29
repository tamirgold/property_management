'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encryptJson, decryptJson } = require('./crypto');
const logger = require('../logger');

const { randomUUID } = crypto;

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

class PlatformStore {
  constructor({ storagePath } = {}) {
    this.storagePath = storagePath || path.resolve(process.cwd(), 'platform-store.json');
    this.backend = null;
    this.pg = null;
    this.state = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    const databaseUrl = process.env.DATABASE_URL || '';

    if (databaseUrl) {
      try {
        // Optional dependency: installed in production deployments.
        const { Pool } = require('pg');
        this.pg = new Pool({ connectionString: databaseUrl, max: 10 });
        await this._initPostgresSchema();
        this.backend = 'postgres';
        this.initialized = true;
        logger.info('Platform store initialised', { backend: this.backend });
        return;
      } catch (err) {
        logger.warn('DATABASE_URL set but postgres adapter unavailable, falling back to file store', {
          error: err.message,
        });
      }
    }

    this.backend = 'file';
    this._initFileStore();
    this.initialized = true;
    logger.info('Platform store initialised', { backend: this.backend, storagePath: this.storagePath });
  }

  async close() {
    if (this.pg) {
      await this.pg.end();
      this.pg = null;
    }
  }

  _initFileStore() {
    if (!fs.existsSync(this.storagePath)) {
      this.state = {
        tenants: [],
        users: [],
        memberships: [],
        integrations: [],
        tenantSettings: [],
        automationSettings: [],
        otpChallenges: [],
        sessions: [],
      };
      this._saveFile();
      return;
    }

    const raw = fs.readFileSync(this.storagePath, 'utf8');
    this.state = JSON.parse(raw || '{}');
    this.state.tenants ||= [];
    this.state.users ||= [];
    this.state.memberships ||= [];
    this.state.integrations ||= [];
    this.state.tenantSettings ||= [];
    this.state.automationSettings ||= [];
    this.state.otpChallenges ||= [];
    this.state.sessions ||= [];
  }

  _saveFile() {
    fs.writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  async _initPostgresSchema() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS platform_tenants (
        id UUID PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        timezone TEXT NOT NULL,
        locale TEXT NOT NULL,
        currency TEXT NOT NULL,
        webhook_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_platform_owner BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_memberships (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (user_id, tenant_id)
      );

      CREATE TABLE IF NOT EXISTS platform_integrations (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        config_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (tenant_id, provider)
      );

      CREATE TABLE IF NOT EXISTS platform_tenant_settings (
        tenant_id UUID PRIMARY KEY REFERENCES platform_tenants(id) ON DELETE CASCADE,
        settings_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_automation_settings (
        tenant_id UUID PRIMARY KEY REFERENCES platform_tenants(id) ON DELETE CASCADE,
        settings_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_otp_challenges (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_sessions (
        token TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_platform_otp_user_created
        ON platform_otp_challenges(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_platform_sessions_user
        ON platform_sessions(user_id);
    `);
  }

  _makeTenantRecord(input) {
    const ts = nowIso();
    return {
      id: input.id || randomUUID(),
      slug: String(input.slug || '').trim().toLowerCase(),
      name: String(input.name || '').trim(),
      status: input.status || 'active',
      timezone: input.timezone || 'UTC',
      locale: input.locale || 'en-US',
      currency: input.currency || 'USD',
      webhookKey: input.webhookKey || crypto.randomBytes(24).toString('hex'),
      createdAt: input.createdAt || ts,
      updatedAt: ts,
    };
  }

  async createTenant(input) {
    await this.init();

    const record = this._makeTenantRecord(input || {});

    if (!record.name) throw new Error('Tenant name is required');
    if (!record.slug) throw new Error('Tenant slug is required');

    if (this.backend === 'file') {
      if (this.state.tenants.some(t => t.slug === record.slug)) {
        throw new Error(`Tenant slug already exists: ${record.slug}`);
      }

      this.state.tenants.push(record);
      this._saveFile();
      return clone(record);
    }

    await this.pg.query(
      `INSERT INTO platform_tenants
         (id, slug, name, status, timezone, locale, currency, webhook_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [record.id, record.slug, record.name, record.status, record.timezone, record.locale, record.currency, record.webhookKey, record.createdAt, record.updatedAt]
    );

    return clone(record);
  }

  async listTenants() {
    await this.init();

    if (this.backend === 'file') {
      return clone(this.state.tenants);
    }

    const { rows } = await this.pg.query(
      `SELECT id, slug, name, status, timezone, locale, currency, webhook_key AS "webhookKey",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_tenants
       ORDER BY created_at ASC`
    );
    return rows;
  }

  async listActiveTenants() {
    const tenants = await this.listTenants();
    return tenants.filter(t => t.status === 'active');
  }

  async getTenantById(id) {
    await this.init();
    if (!id) return null;

    if (this.backend === 'file') {
      return clone(this.state.tenants.find(t => t.id === id) || null);
    }

    const { rows } = await this.pg.query(
      `SELECT id, slug, name, status, timezone, locale, currency, webhook_key AS "webhookKey",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_tenants
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async getTenantBySlug(slug) {
    await this.init();
    const normalized = String(slug || '').trim().toLowerCase();
    if (!normalized) return null;

    if (this.backend === 'file') {
      return clone(this.state.tenants.find(t => t.slug === normalized) || null);
    }

    const { rows } = await this.pg.query(
      `SELECT id, slug, name, status, timezone, locale, currency, webhook_key AS "webhookKey",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_tenants
       WHERE slug = $1
       LIMIT 1`,
      [normalized]
    );
    return rows[0] || null;
  }

  async getTenantByWebhookKey(webhookKey) {
    await this.init();
    const key = String(webhookKey || '').trim();
    if (!key) return null;

    if (this.backend === 'file') {
      return clone(this.state.tenants.find(t => t.webhookKey === key) || null);
    }

    const { rows } = await this.pg.query(
      `SELECT id, slug, name, status, timezone, locale, currency, webhook_key AS "webhookKey",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_tenants
       WHERE webhook_key = $1
       LIMIT 1`,
      [key]
    );
    return rows[0] || null;
  }

  async updateTenant(tenantId, patch) {
    await this.init();
    if (!tenantId) throw new Error('tenantId is required');

    if (this.backend === 'file') {
      const idx = this.state.tenants.findIndex(t => t.id === tenantId);
      if (idx === -1) return null;
      const next = {
        ...this.state.tenants[idx],
        ...patch,
        updatedAt: nowIso(),
      };
      this.state.tenants[idx] = next;
      this._saveFile();
      return clone(next);
    }

    const current = await this.getTenantById(tenantId);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
    };

    await this.pg.query(
      `UPDATE platform_tenants
       SET slug=$2, name=$3, status=$4, timezone=$5, locale=$6, currency=$7, webhook_key=$8, updated_at=$9
       WHERE id=$1`,
      [tenantId, next.slug, next.name, next.status, next.timezone, next.locale, next.currency, next.webhookKey, next.updatedAt]
    );

    return next;
  }

  async saveTenantSettings(tenantId, settings) {
    await this.init();
    if (!tenantId) throw new Error('tenantId is required');
    const payload = settings || {};

    if (this.backend === 'file') {
      const idx = this.state.tenantSettings.findIndex(s => s.tenantId === tenantId);
      const record = { tenantId, settings: payload, updatedAt: nowIso() };
      if (idx === -1) this.state.tenantSettings.push(record);
      else this.state.tenantSettings[idx] = record;
      this._saveFile();
      return clone(record.settings);
    }

    await this.pg.query(
      `INSERT INTO platform_tenant_settings (tenant_id, settings_json, updated_at)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (tenant_id)
       DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at`,
      [tenantId, JSON.stringify(payload), nowIso()]
    );

    return clone(payload);
  }

  async getTenantSettings(tenantId) {
    await this.init();
    if (!tenantId) return {};

    if (this.backend === 'file') {
      const record = this.state.tenantSettings.find(s => s.tenantId === tenantId);
      return clone(record?.settings || {});
    }

    const { rows } = await this.pg.query(
      `SELECT settings_json AS settings FROM platform_tenant_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );

    return rows[0]?.settings || {};
  }

  async saveAutomationSettings(tenantId, settings) {
    await this.init();
    if (!tenantId) throw new Error('tenantId is required');
    const payload = settings || {};

    if (this.backend === 'file') {
      const idx = this.state.automationSettings.findIndex(s => s.tenantId === tenantId);
      const record = { tenantId, settings: payload, updatedAt: nowIso() };
      if (idx === -1) this.state.automationSettings.push(record);
      else this.state.automationSettings[idx] = record;
      this._saveFile();
      return clone(record.settings);
    }

    await this.pg.query(
      `INSERT INTO platform_automation_settings (tenant_id, settings_json, updated_at)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (tenant_id)
       DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at`,
      [tenantId, JSON.stringify(payload), nowIso()]
    );

    return clone(payload);
  }

  async getAutomationSettings(tenantId) {
    await this.init();
    if (!tenantId) return {};

    if (this.backend === 'file') {
      const record = this.state.automationSettings.find(s => s.tenantId === tenantId);
      return clone(record?.settings || {});
    }

    const { rows } = await this.pg.query(
      `SELECT settings_json AS settings FROM platform_automation_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );

    return rows[0]?.settings || {};
  }

  async setIntegrationConfig(tenantId, provider, configObj) {
    await this.init();
    if (!tenantId) throw new Error('tenantId is required');
    const p = String(provider || '').trim().toLowerCase();
    if (!p) throw new Error('provider is required');

    const payload = encryptJson(configObj || {});
    const ts = nowIso();

    if (this.backend === 'file') {
      const idx = this.state.integrations.findIndex(i => i.tenantId === tenantId && i.provider === p);
      const next = {
        id: idx === -1 ? randomUUID() : this.state.integrations[idx].id,
        tenantId,
        provider: p,
        configJson: payload,
        createdAt: idx === -1 ? ts : this.state.integrations[idx].createdAt,
        updatedAt: ts,
      };
      if (idx === -1) this.state.integrations.push(next);
      else this.state.integrations[idx] = next;
      this._saveFile();
      return clone(configObj || {});
    }

    const existing = await this.pg.query(
      `SELECT id, created_at AS "createdAt" FROM platform_integrations WHERE tenant_id=$1 AND provider=$2 LIMIT 1`,
      [tenantId, p]
    );

    if (existing.rows[0]) {
      await this.pg.query(
        `UPDATE platform_integrations
         SET config_json = $3::jsonb, updated_at = $4
         WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, p, JSON.stringify(payload), ts]
      );
    } else {
      await this.pg.query(
        `INSERT INTO platform_integrations (id, tenant_id, provider, config_json, created_at, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [randomUUID(), tenantId, p, JSON.stringify(payload), ts, ts]
      );
    }

    return clone(configObj || {});
  }

  async getIntegrationConfig(tenantId, provider) {
    await this.init();
    if (!tenantId) return null;

    const p = String(provider || '').trim().toLowerCase();
    if (!p) return null;

    let raw;

    if (this.backend === 'file') {
      raw = this.state.integrations.find(i => i.tenantId === tenantId && i.provider === p)?.configJson;
    } else {
      const { rows } = await this.pg.query(
        `SELECT config_json AS "configJson"
         FROM platform_integrations
         WHERE tenant_id = $1 AND provider = $2
         LIMIT 1`,
        [tenantId, p]
      );
      raw = rows[0]?.configJson;
    }

    if (!raw) return null;

    try {
      return decryptJson(raw);
    } catch (err) {
      logger.error('Could not decrypt tenant integration config', { tenantId, provider: p, error: err.message });
      return null;
    }
  }

  async listIntegrationConfigs(tenantId) {
    await this.init();
    if (!tenantId) return {};

    let rows;
    if (this.backend === 'file') {
      rows = this.state.integrations.filter(i => i.tenantId === tenantId);
    } else {
      const result = await this.pg.query(
        `SELECT provider, config_json AS "configJson"
         FROM platform_integrations
         WHERE tenant_id = $1`,
        [tenantId]
      );
      rows = result.rows;
    }

    const configs = {};
    for (const row of rows) {
      const provider = row.provider;
      try {
        configs[provider] = decryptJson(row.configJson);
      } catch (err) {
        logger.error('Skipping undecryptable integration config', { tenantId, provider, error: err.message });
      }
    }

    return configs;
  }

  async createUser(input) {
    await this.init();

    const email = normalizeEmail(input.email);
    if (!email) throw new Error('email is required');
    if (!input.passwordHash) throw new Error('passwordHash is required');

    const record = {
      id: input.id || randomUUID(),
      email,
      passwordHash: input.passwordHash,
      isPlatformOwner: !!input.isPlatformOwner,
      status: input.status || 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    if (this.backend === 'file') {
      if (this.state.users.some(u => u.email === email)) throw new Error('Email already exists');
      this.state.users.push(record);
      this._saveFile();
      return clone(record);
    }

    await this.pg.query(
      `INSERT INTO platform_users
         (id, email, password_hash, is_platform_owner, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [record.id, record.email, record.passwordHash, record.isPlatformOwner, record.status, record.createdAt, record.updatedAt]
    );

    return clone(record);
  }

  async getUserByEmail(email) {
    await this.init();
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    if (this.backend === 'file') {
      return clone(this.state.users.find(u => u.email === normalized) || null);
    }

    const { rows } = await this.pg.query(
      `SELECT id, email, password_hash AS "passwordHash", is_platform_owner AS "isPlatformOwner",
              status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_users
       WHERE email=$1
       LIMIT 1`,
      [normalized]
    );

    return rows[0] || null;
  }

  async getUserById(id) {
    await this.init();
    if (!id) return null;

    if (this.backend === 'file') {
      return clone(this.state.users.find(u => u.id === id) || null);
    }

    const { rows } = await this.pg.query(
      `SELECT id, email, password_hash AS "passwordHash", is_platform_owner AS "isPlatformOwner",
              status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_users
       WHERE id=$1
       LIMIT 1`,
      [id]
    );

    return rows[0] || null;
  }

  async updateUserPassword(userId, passwordHash) {
    await this.init();
    if (!userId) throw new Error('userId is required');
    if (!passwordHash) throw new Error('passwordHash is required');

    if (this.backend === 'file') {
      const idx = this.state.users.findIndex(u => u.id === userId);
      if (idx === -1) return null;
      this.state.users[idx].passwordHash = passwordHash;
      this.state.users[idx].updatedAt = nowIso();
      this._saveFile();
      return clone(this.state.users[idx]);
    }

    await this.pg.query(
      `UPDATE platform_users SET password_hash = $2, updated_at = $3 WHERE id = $1`,
      [userId, passwordHash, nowIso()]
    );

    return this.getUserById(userId);
  }

  async createMembership(input) {
    await this.init();

    const record = {
      id: input.id || randomUUID(),
      userId: input.userId,
      tenantId: input.tenantId,
      role: input.role || 'company_user',
      status: input.status || 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    if (!record.userId || !record.tenantId) {
      throw new Error('userId and tenantId are required');
    }

    if (this.backend === 'file') {
      const idx = this.state.memberships.findIndex(m => m.userId === record.userId && m.tenantId === record.tenantId);
      if (idx === -1) this.state.memberships.push(record);
      else this.state.memberships[idx] = { ...this.state.memberships[idx], ...record };
      this._saveFile();
      return clone(idx === -1 ? record : this.state.memberships[idx]);
    }

    await this.pg.query(
      `INSERT INTO platform_memberships
         (id, user_id, tenant_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, tenant_id)
       DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [record.id, record.userId, record.tenantId, record.role, record.status, record.createdAt, record.updatedAt]
    );

    return this.getMembership(record.userId, record.tenantId);
  }

  async getMembership(userId, tenantId) {
    await this.init();
    if (!userId || !tenantId) return null;

    if (this.backend === 'file') {
      return clone(this.state.memberships.find(m => m.userId === userId && m.tenantId === tenantId) || null);
    }

    const { rows } = await this.pg.query(
      `SELECT id, user_id AS "userId", tenant_id AS "tenantId", role, status,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_memberships
       WHERE user_id = $1 AND tenant_id = $2
       LIMIT 1`,
      [userId, tenantId]
    );

    return rows[0] || null;
  }

  async listMembershipsForUser(userId) {
    await this.init();
    if (!userId) return [];

    if (this.backend === 'file') {
      return clone(this.state.memberships.filter(m => m.userId === userId));
    }

    const { rows } = await this.pg.query(
      `SELECT id, user_id AS "userId", tenant_id AS "tenantId", role, status,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_memberships
       WHERE user_id = $1`,
      [userId]
    );

    return rows;
  }

  async listMembershipsForTenant(tenantId) {
    await this.init();
    if (!tenantId) return [];

    if (this.backend === 'file') {
      return clone(this.state.memberships.filter(m => m.tenantId === tenantId));
    }

    const { rows } = await this.pg.query(
      `SELECT id, user_id AS "userId", tenant_id AS "tenantId", role, status,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM platform_memberships
       WHERE tenant_id = $1`,
      [tenantId]
    );

    return rows;
  }

  async createOtpChallenge({ userId, tenantId, code, ttlSeconds = 600 }) {
    await this.init();
    if (!userId || !tenantId || !code) throw new Error('userId, tenantId, and code are required');

    const id = randomUUID();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    if (this.backend === 'file') {
      this.state.otpChallenges.push({ id, userId, tenantId, code, createdAt, expiresAt, consumedAt: null });
      this._saveFile();
      return { id, userId, tenantId, createdAt, expiresAt };
    }

    await this.pg.query(
      `INSERT INTO platform_otp_challenges (id, user_id, tenant_id, code, expires_at, consumed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, userId, tenantId, code, expiresAt, null, createdAt]
    );

    return { id, userId, tenantId, createdAt, expiresAt };
  }

  async consumeOtpChallenge({ challengeId, code }) {
    await this.init();
    if (!challengeId || !code) return null;

    const now = Date.now();

    if (this.backend === 'file') {
      const idx = this.state.otpChallenges.findIndex(c => c.id === challengeId);
      if (idx === -1) return null;

      const item = this.state.otpChallenges[idx];
      if (item.consumedAt) return null;
      if (item.code !== code) return null;
      if (new Date(item.expiresAt).getTime() < now) return null;

      this.state.otpChallenges[idx].consumedAt = nowIso();
      this._saveFile();
      return clone(item);
    }

    const { rows } = await this.pg.query(
      `SELECT id, user_id AS "userId", tenant_id AS "tenantId", code,
              expires_at AS "expiresAt", consumed_at AS "consumedAt", created_at AS "createdAt"
       FROM platform_otp_challenges
       WHERE id = $1
       LIMIT 1`,
      [challengeId]
    );

    const row = rows[0];
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.code !== code) return null;
    if (new Date(row.expiresAt).getTime() < now) return null;

    await this.pg.query(
      `UPDATE platform_otp_challenges SET consumed_at = $2 WHERE id = $1`,
      [challengeId, nowIso()]
    );

    return row;
  }

  async createSession({ userId, tenantId, ttlSeconds = 7 * 24 * 3600 }) {
    await this.init();
    if (!userId || !tenantId) throw new Error('userId and tenantId are required');

    const token = crypto.randomBytes(40).toString('hex');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    if (this.backend === 'file') {
      this.state.sessions.push({ token, userId, tenantId, createdAt, expiresAt });
      this._saveFile();
      return { token, userId, tenantId, expiresAt, createdAt };
    }

    await this.pg.query(
      `INSERT INTO platform_sessions (token, user_id, tenant_id, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [token, userId, tenantId, expiresAt, createdAt]
    );

    return { token, userId, tenantId, expiresAt, createdAt };
  }

  async getSession(token) {
    await this.init();
    if (!token) return null;

    let row;
    if (this.backend === 'file') {
      row = this.state.sessions.find(s => s.token === token) || null;
    } else {
      const { rows } = await this.pg.query(
        `SELECT token, user_id AS "userId", tenant_id AS "tenantId", expires_at AS "expiresAt", created_at AS "createdAt"
         FROM platform_sessions
         WHERE token = $1
         LIMIT 1`,
        [token]
      );
      row = rows[0] || null;
    }

    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      await this.deleteSession(token);
      return null;
    }

    return row;
  }

  async deleteSession(token) {
    await this.init();
    if (!token) return;

    if (this.backend === 'file') {
      this.state.sessions = this.state.sessions.filter(s => s.token !== token);
      this._saveFile();
      return;
    }

    await this.pg.query('DELETE FROM platform_sessions WHERE token = $1', [token]);
  }

  async findTenantByTelegramPrincipal({ userId, chatId }) {
    await this.init();
    const activeTenants = await this.listActiveTenants();

    for (const tenant of activeTenants) {
      const tg = await this.getIntegrationConfig(tenant.id, 'telegram');
      if (!tg) continue;

      const userIds = new Set((tg.allowedUserIds || []).map(Number));
      const groupIds = new Set((tg.allowedGroupIds || []).map(Number));

      if (userIds.has(Number(userId)) || groupIds.has(Number(chatId))) {
        return tenant;
      }
    }

    return null;
  }
}

module.exports = PlatformStore;
