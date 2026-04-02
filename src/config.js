/**
 * Configuration for the headless WhatsApp automation service
 */

import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const API_KEY = process.env.API_KEY;
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';
const FLOW_TIMEOUT_MS = parseInt(process.env.FLOW_TIMEOUT_MS || '60000', 10);
const IDLE_TIMEOUT_MINUTES = parseInt(process.env.IDLE_TIMEOUT_MINUTES || '0', 10);
const POST_FLOW_IDLE_TIMEOUT_MS = parseInt(process.env.POST_FLOW_IDLE_TIMEOUT_MS || '30000', 10);
const SEND_RELOAD_IDLE_MINUTES = parseInt(process.env.SEND_RELOAD_IDLE_MINUTES || '10', 10);
const BROWSER_POOL_WAIT_MS = parseInt(process.env.BROWSER_POOL_WAIT_MS || '30000', 10);

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseConcurrency(value, fallback) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'all' || raw === 'unlimited') return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseEnvList(value, fallback = []) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

if (!API_KEY) {
  throw new Error('API_KEY environment variable is required');
}

// Proxy configuration from environment variables
let defaultProxy = null;
if (process.env.PROXY_SERVER) {
  defaultProxy = {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME || undefined,
    password: process.env.PROXY_PASSWORD || undefined,
  };
}

export const config = {
  apiKey: API_KEY,
  port: PORT,
  devMode: DEV_MODE,
  flowTimeoutMs: Number.isFinite(FLOW_TIMEOUT_MS) && FLOW_TIMEOUT_MS > 0 ? FLOW_TIMEOUT_MS : 60000,
  flowRecoverableRetryAttempts: parseNonNegativeInt(process.env.FLOW_RECOVERABLE_RETRY_ATTEMPTS, 2),
  flowRecoverableRetryDelayMs: parsePositiveInt(process.env.FLOW_RECOVERABLE_RETRY_DELAY_MS, 1500),
  maxActiveBrowsers: parseNonNegativeInt(process.env.MAX_ACTIVE_BROWSERS, 0),
  browserPoolWaitMs: Number.isFinite(BROWSER_POOL_WAIT_MS) && BROWSER_POOL_WAIT_MS >= 0
    ? BROWSER_POOL_WAIT_MS
    : 30000,
  idleTimeoutMs: Number.isFinite(IDLE_TIMEOUT_MINUTES) && IDLE_TIMEOUT_MINUTES > 0
    ? IDLE_TIMEOUT_MINUTES * 60 * 1000
    : 0,
  postFlowIdleTimeoutMs: Number.isFinite(POST_FLOW_IDLE_TIMEOUT_MS) && POST_FLOW_IDLE_TIMEOUT_MS >= 0
    ? POST_FLOW_IDLE_TIMEOUT_MS
    : 30000,
  sendReloadIdleMs: Number.isFinite(SEND_RELOAD_IDLE_MINUTES) && SEND_RELOAD_IDLE_MINUTES > 0
    ? SEND_RELOAD_IDLE_MINUTES * 60 * 1000
    : 0,
  sendConcurrency: parseConcurrency(process.env.SEND_CONCURRENCY, 1),
  sessionLockWaitTimeoutMs: parseNonNegativeInt(process.env.SESSION_LOCK_WAIT_TIMEOUT_MS, 90000),
  storePersistDebounceMs: parseNonNegativeInt(process.env.SESSION_STORE_PERSIST_DEBOUNCE_MS, 50),
  priorityHighStreakLimit: parsePositiveInt(process.env.MESSAGE_PRIORITY_HIGH_STREAK_LIMIT, 3),
  queue: {
    pollIntervalMs: parsePositiveInt(process.env.MESSAGE_QUEUE_POLL_INTERVAL_MS, 1500),
    batchSize: parsePositiveInt(process.env.MESSAGE_QUEUE_BATCH_SIZE, 5),
    sessionBurstSize: parsePositiveInt(process.env.MESSAGE_QUEUE_SESSION_BURST_SIZE, 5),
    sessionPrewarmEnabled: parseBoolean(process.env.MESSAGE_QUEUE_SESSION_PREWARM_ENABLED, true),
    sessionPrewarmLimit: parsePositiveInt(process.env.MESSAGE_QUEUE_SESSION_PREWARM_LIMIT, 5),
    sessionPrewarmIdleTimeoutMs: parseNonNegativeInt(process.env.MESSAGE_QUEUE_SESSION_PREWARM_IDLE_TIMEOUT_MS, 90000),
    maxAttempts: parsePositiveInt(process.env.MESSAGE_QUEUE_MAX_ATTEMPTS, 5),
    retryBaseMs: parsePositiveInt(process.env.MESSAGE_QUEUE_RETRY_BASE_MS, 30000),
    retryMaxMs: parsePositiveInt(process.env.MESSAGE_QUEUE_RETRY_MAX_MS, 300000),
    processingTimeoutMs: parsePositiveInt(process.env.MESSAGE_QUEUE_PROCESSING_TIMEOUT_MS, 180000),
    webhookUrl: String(process.env.META_BLAST_WEBHOOK_PRIVATE_URL || process.env.META_BLAST_WEBHOOK_URL || '').trim(),
    webhookTimeoutMs: parsePositiveInt(process.env.META_BLAST_WEBHOOK_TIMEOUT_MS, 15000),
    webhookRetryBaseMs: parsePositiveInt(process.env.META_BLAST_WEBHOOK_RETRY_BASE_MS, 10000),
    webhookRetryMaxMs: parsePositiveInt(process.env.META_BLAST_WEBHOOK_RETRY_MAX_MS, 300000),
  },
  sessionQueue: {
    pollIntervalMs: parsePositiveInt(process.env.META_SESSION_QUEUE_POLL_INTERVAL_MS, 1500),
    batchSize: parsePositiveInt(process.env.META_SESSION_QUEUE_BATCH_SIZE, 1),
    maxAttempts: parsePositiveInt(process.env.META_SESSION_QUEUE_MAX_ATTEMPTS, 3),
    retryBaseMs: parsePositiveInt(process.env.META_SESSION_QUEUE_RETRY_BASE_MS, 30000),
    retryMaxMs: parsePositiveInt(process.env.META_SESSION_QUEUE_RETRY_MAX_MS, 300000),
    processingTimeoutMs: parsePositiveInt(process.env.META_SESSION_QUEUE_PROCESSING_TIMEOUT_MS, 240000),
    webhookUrl: String(process.env.META_SESSION_WEBHOOK_URL || '').trim(),
    webhookTimeoutMs: parsePositiveInt(process.env.META_SESSION_WEBHOOK_TIMEOUT_MS, 15000),
    webhookRetryBaseMs: parsePositiveInt(process.env.META_SESSION_WEBHOOK_RETRY_BASE_MS, 10000),
    webhookRetryMaxMs: parsePositiveInt(process.env.META_SESSION_WEBHOOK_RETRY_MAX_MS, 300000),
  },
  createQueue: {
    pollIntervalMs: parsePositiveInt(process.env.META_CREATE_QUEUE_POLL_INTERVAL_MS, 1500),
    batchSize: parsePositiveInt(process.env.META_CREATE_QUEUE_BATCH_SIZE, 1),
    concurrency: parsePositiveInt(process.env.META_CREATE_QUEUE_CONCURRENCY, 1),
    maxAttempts: parsePositiveInt(process.env.META_CREATE_QUEUE_MAX_ATTEMPTS, 3),
    retryBaseMs: parsePositiveInt(process.env.META_CREATE_QUEUE_RETRY_BASE_MS, 30000),
    retryMaxMs: parsePositiveInt(process.env.META_CREATE_QUEUE_RETRY_MAX_MS, 300000),
    processingTimeoutMs: parsePositiveInt(process.env.META_CREATE_QUEUE_PROCESSING_TIMEOUT_MS, 900000),
    browserExtraCapacity: parseNonNegativeInt(process.env.META_CREATE_BROWSER_EXTRA_CAPACITY, 1),
    browserPoolWaitMs: parseNonNegativeInt(process.env.META_CREATE_BROWSER_POOL_WAIT_MS, 15000),
  },
  proxy: defaultProxy,
  texts: {
    openWhatsappModal: parseEnvList(
      process.env.WA_TEXT_OPEN_WHATSAPP_MODAL,
      ['Send a Message on WhatsApp', 'Send message on WhatsApp']
    ),
    newWhatsappNumber: parseEnvList(
      process.env.WA_TEXT_NEW_WHATSAPP_NUMBER,
      ['New WhatsApp number', 'New WhatsApp']
    ),
    sendMessage: parseEnvList(
      process.env.WA_TEXT_SEND_MESSAGE,
      ['Send Message', 'Send message']
    ),
  },
  ocrUrl: String(process.env.OCR_URL || '').trim(),
  ocrApikey: String(process.env.OCR_API_KEY || '').trim(),
  browser: {
    // Allow non-headless mode for debugging (set HEADLESS=false in .env)
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  },
};
