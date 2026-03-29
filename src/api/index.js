'use strict';

const ERPNextClient = require('./erpnext');

const cache = new Map();
const defaultClient = new ERPNextClient();

function makeKey(erpnext = {}) {
  return [erpnext.baseUrl || '', erpnext.apiKey || '', erpnext.apiSecret || ''].join('|');
}

function forTenant(tenantContext) {
  const cfg = tenantContext?.integrations?.erpnext;
  if (!cfg) return defaultClient;

  const key = makeKey(cfg);
  if (!key || key === '||') return defaultClient;

  if (cache.has(key)) return cache.get(key);

  const client = new ERPNextClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
  });

  cache.set(key, client);
  return client;
}

module.exports = defaultClient;
module.exports.forTenant = forTenant;
module.exports.ERPNextClient = ERPNextClient;
