'use strict';

const scheduler = require('./scheduler');
const { getStore } = require('../platform');
const { buildTenantContext } = require('../platform/runtime');

async function runAcrossTenants(jobFn) {
  const multiTenant = process.env.PLATFORM_MULTI_TENANT === '1';
  if (!multiTenant) {
    await jobFn({ tenantContext: null });
    return;
  }

  const store = await getStore();
  const tenants = await store.listActiveTenants();
  if (!tenants.length) return;

  for (const tenant of tenants) {
    const tenantContext = await buildTenantContext(tenant);
    await jobFn({ tenantContext });
  }
}

const JOB_FN = {
  overdue_rent: () => runAcrossTenants((ctx) => scheduler.runOverdueRentCheck(ctx)),
  lease_renewal: () => runAcrossTenants((ctx) => scheduler.runLeaseRenewalCheck(ctx)),
  late_fees: () => runAcrossTenants((ctx) => scheduler.runLateFeeCheck(ctx)),
  stale_work_orders: () => runAcrossTenants((ctx) => scheduler.runStaleWorkOrderCheck(ctx)),
  weekly_report: () => runAcrossTenants((ctx) => scheduler.runWeeklyReport(ctx)),
};

function getJobIds() {
  return Object.keys(JOB_FN);
}

async function runJobById(id) {
  if (!JOB_FN[id]) throw new Error(`Unknown job id: ${id}`);
  await JOB_FN[id]();
}

module.exports = {
  JOB_FN,
  getJobIds,
  runJobById,
};
