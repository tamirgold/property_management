'use strict';

const { validate, config } = require('./config');
const logger = require('./logger');
const { bootstrapDefaults } = require('./platform');
const { bootstrapPlatformOwner } = require('./platform/auth');
const { createServer } = require('./webhook/server');
const { createBot, stopBot } = require('./telegram/bot');
const { startScheduler } = require('./automation/cron');
const { runJobById } = require('./automation/job-runner');

function getAppMode() {
  return (process.env.APP_MODE || 'all').trim().toLowerCase();
}

async function bootstrapPlatform() {
  await bootstrapDefaults();
  await bootstrapPlatformOwner();
}

async function runWebMode() {
  await bootstrapPlatform();
  const app = createServer();
  const port = config.webhook.port;
  const httpServer = app.listen(port, () => {
    logger.info('HTTP webhook server started', { port });
  });

  logger.info('Runtime mode started', {
    appMode: 'web',
    webhookPort: port,
    adminUi: `http://localhost:${port}/admin`,
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal} – shutting down web runtime`);
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function runTelegramMode() {
  await bootstrapPlatform();
  createBot();

  logger.info('Runtime mode started', { appMode: 'telegram' });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal} – shutting down telegram runtime`);
    await stopBot();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function runSchedulerMode() {
  await bootstrapPlatform();
  startScheduler();

  logger.info('Runtime mode started', { appMode: 'scheduler' });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal} – shutting down scheduler runtime`);
    await stopBot();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function runAllMode() {
  await bootstrapPlatform();

  const app = createServer();
  const port = config.webhook.port;
  const httpServer = app.listen(port, () => {
    logger.info('HTTP webhook server started', { port });
  });

  createBot();
  startScheduler();

  logger.info('Unified Landlord Center started', {
    appMode: 'all',
    webhookPort: port,
    adminUi: `http://localhost:${port}/admin`,
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal} – shutting down`);
    await stopBot();
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function runJobMode() {
  await bootstrapPlatform();
  const jobId = (process.env.JOB_ID || '').trim();
  if (!jobId) {
    throw new Error('JOB_ID is required when APP_MODE=job');
  }

  logger.info('Running one-shot automation job', { jobId });
  await runJobById(jobId);
  logger.info('One-shot automation job completed', { jobId });
}

async function main() {
  try {
    validate();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const appMode = getAppMode();

  if (appMode === 'web') return runWebMode();
  if (appMode === 'telegram') return runTelegramMode();
  if (appMode === 'scheduler') return runSchedulerMode();
  if (appMode === 'job') return runJobMode();
  return runAllMode();
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
