/**
 * Configuration for the headless WhatsApp automation service
 */

import dotenv from 'dotenv';

// The PM2 process manager can keep stale env values across reloads.
// Production .env is the source of truth for runtime tuning.
dotenv.config({ override: true });

const API_KEY = process.env.API_KEY;
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';
const FLOW_TIMEOUT_MS = parseInt(process.env.FLOW_TIMEOUT_MS || '60000', 10);
const IDLE_TIMEOUT_MINUTES = parseInt(process.env.IDLE_TIMEOUT_MINUTES || '0', 10);
const POST_FLOW_IDLE_TIMEOUT_MS = parseInt(process.env.POST_FLOW_IDLE_TIMEOUT_MS || '30000', 10);
const SEND_RELOAD_IDLE_MINUTES = parseInt(process.env.SEND_RELOAD_IDLE_MINUTES || '10', 10);
const BROWSER_POOL_WAIT_MS = parseInt(process.env.BROWSER_POOL_WAIT_MS || '30000', 10);
const JSON_BODY_LIMIT = String(process.env.JSON_BODY_LIMIT || '8mb').trim() || '8mb';

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseHour(value, fallback) {
  const parsed = parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
}

function parseConcurrency(value, fallback) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'all' || raw === 'unlimited') return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function capConcurrency(configured, hardLimit) {
  const safeConfigured = Number(configured);
  const safeHardLimit = Number(hardLimit);
  if (!Number.isFinite(safeHardLimit) || safeHardLimit <= 0) return safeConfigured;
  if (!Number.isFinite(safeConfigured) || safeConfigured <= 0) return safeHardLimit;
  return Math.min(safeConfigured, safeHardLimit);
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
  jsonBodyLimit: JSON_BODY_LIMIT,
  flowTimeoutMs: Number.isFinite(FLOW_TIMEOUT_MS) && FLOW_TIMEOUT_MS > 0 ? FLOW_TIMEOUT_MS : 60000,
  flowRecoverableRetryAttempts: parseNonNegativeInt(process.env.FLOW_RECOVERABLE_RETRY_ATTEMPTS, 2),
  flowRecoverableRetryDelayMs: parsePositiveInt(process.env.FLOW_RECOVERABLE_RETRY_DELAY_MS, 1500),
  maxActiveBrowsers: capConcurrency(
    parseNonNegativeInt(process.env.MAX_ACTIVE_BROWSERS, 16),
    parseNonNegativeInt(process.env.MAX_ACTIVE_BROWSERS_HARD_LIMIT, 24)
  ),
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
  sendConcurrencyConfigured: parseConcurrency(process.env.SEND_CONCURRENCY, 1),
  sendConcurrencyMax: parsePositiveInt(process.env.SEND_CONCURRENCY_MAX, 8),
  sendConcurrencyMaxDuringCreate: parsePositiveInt(process.env.SEND_CONCURRENCY_MAX_DURING_CREATE, 2),
  sessionLockWaitTimeoutMs: parseNonNegativeInt(process.env.SESSION_LOCK_WAIT_TIMEOUT_MS, 90000),
  storePersistDebounceMs: parseNonNegativeInt(process.env.SESSION_STORE_PERSIST_DEBOUNCE_MS, 50),
  diskPressureWarnPercent: parsePositiveInt(process.env.DISK_PRESSURE_WARN_PERCENT, 90),
  diskPressureBlockPercent: parsePositiveInt(process.env.DISK_PRESSURE_BLOCK_PERCENT, 95),
  profileCleanup: {
    enabled: parseBoolean(process.env.PROFILE_CLEANUP_ENABLED, true),
    intervalMs: parsePositiveInt(process.env.PROFILE_CLEANUP_INTERVAL_MINUTES, 30) * 60 * 1000,
    startupDelayMs: parseNonNegativeInt(process.env.PROFILE_CLEANUP_STARTUP_DELAY_MINUTES, 5) * 60 * 1000,
    orphanMinAgeMs: parsePositiveInt(process.env.PROFILE_CLEANUP_ORPHAN_MIN_AGE_HOURS, 24) * 60 * 60 * 1000,
    maxDeletePerRun: parsePositiveInt(process.env.PROFILE_CLEANUP_MAX_DELETE_PER_RUN, 1000),
    debugMaxAgeMs: parsePositiveInt(process.env.PROFILE_CLEANUP_DEBUG_MAX_AGE_DAYS, 3) * 24 * 60 * 60 * 1000,
    debugMaxDeletePerRun: parsePositiveInt(process.env.PROFILE_CLEANUP_DEBUG_MAX_DELETE_PER_RUN, 5000),
  },
  priorityHighStreakLimit: parsePositiveInt(process.env.MESSAGE_PRIORITY_HIGH_STREAK_LIMIT, 3),
  queue: {
    pollIntervalMs: parsePositiveInt(process.env.MESSAGE_QUEUE_POLL_INTERVAL_MS, 1500),
    batchSize: parsePositiveInt(process.env.MESSAGE_QUEUE_BATCH_SIZE, 5),
    sessionBurstSize: parsePositiveInt(process.env.MESSAGE_QUEUE_SESSION_BURST_SIZE, 5),
    sessionPrewarmEnabled: parseBoolean(process.env.MESSAGE_QUEUE_SESSION_PREWARM_ENABLED, true),
    sessionPrewarmLimit: parsePositiveInt(process.env.MESSAGE_QUEUE_SESSION_PREWARM_LIMIT, 2),
    sessionPrewarmIdleTimeoutMs: parseNonNegativeInt(process.env.MESSAGE_QUEUE_SESSION_PREWARM_IDLE_TIMEOUT_MS, 45000),
    createReservedBrowserSlots: parseNonNegativeInt(process.env.MESSAGE_QUEUE_CREATE_RESERVED_BROWSER_SLOTS, 8),
    createSlotBorrowTimezone: String(process.env.MESSAGE_QUEUE_CREATE_SLOT_BORROW_TIMEZONE || 'Asia/Jakarta').trim(),
    createSlotBorrowStartHour: parseHour(process.env.MESSAGE_QUEUE_CREATE_SLOT_BORROW_START_HOUR, null),
    createSlotBorrowEndHour: parseHour(process.env.MESSAGE_QUEUE_CREATE_SLOT_BORROW_END_HOUR, null),
    prewarmDuringCreate: parseBoolean(process.env.MESSAGE_QUEUE_PREWARM_DURING_CREATE, false),
    unhealthySessionCooldownMs: parseNonNegativeInt(process.env.MESSAGE_QUEUE_UNHEALTHY_SESSION_COOLDOWN_MS, 600000),
    coldSessionClaimLimit: parseNonNegativeInt(process.env.MESSAGE_QUEUE_COLD_SESSION_CLAIM_LIMIT, 2),
    backpressureSweepEnabled: parseBoolean(process.env.MESSAGE_QUEUE_BACKPRESSURE_SWEEP_ENABLED, true),
    backpressureSweepIntervalMs: parsePositiveInt(process.env.MESSAGE_QUEUE_BACKPRESSURE_SWEEP_INTERVAL_MS, 5000),
    backpressureSweepSessionLimit: parsePositiveInt(process.env.MESSAGE_QUEUE_BACKPRESSURE_SWEEP_SESSION_LIMIT, 150),
    backpressureDeferMs: parsePositiveInt(process.env.MESSAGE_QUEUE_BACKPRESSURE_DEFER_MS, 3600000),
    suspendedQueuedAgeMs: parsePositiveInt(process.env.MESSAGE_QUEUE_SUSPENDED_QUEUED_AGE_MS, 300000),
    maxRunnableQueuedPerSession: parsePositiveInt(process.env.MESSAGE_QUEUE_MAX_RUNNABLE_PER_SESSION, 25),
    managerRerouteMaxPerSession: parsePositiveInt(process.env.MESSAGE_QUEUE_MANAGER_REROUTE_MAX_PER_SESSION, 25),
    backpressureGlobalQueuedThreshold: parsePositiveInt(process.env.MESSAGE_QUEUE_BACKPRESSURE_GLOBAL_QUEUED_THRESHOLD, 25000),
    backpressureMaxRunnableSessions: parsePositiveInt(process.env.MESSAGE_QUEUE_BACKPRESSURE_MAX_RUNNABLE_SESSIONS, 15),
    archiveDelayedEnabled: parseBoolean(process.env.MESSAGE_QUEUE_ARCHIVE_DELAYED_ENABLED, true),
    archiveDelayedQueuedThreshold: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_DELAYED_QUEUED_THRESHOLD, 10000),
    archiveDelayedTerminalThreshold: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_DELAYED_TERMINAL_THRESHOLD, 1000),
    archiveDelayedMinAgeMs: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_DELAYED_MIN_AGE_MS, 300000),
    archiveDelayedMaxJobs: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_DELAYED_MAX_JOBS, 10000),
    archiveDelayedMaxSessions: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_DELAYED_MAX_SESSIONS, 150),
    archiveTerminalQueuedEnabled: parseBoolean(process.env.MESSAGE_QUEUE_ARCHIVE_TERMINAL_QUEUED_ENABLED, true),
    archiveTerminalQueuedMinAgeMs: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_TERMINAL_QUEUED_MIN_AGE_MS, 300000),
    archiveTerminalQueuedMaxJobs: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_TERMINAL_QUEUED_MAX_JOBS, 500),
    archiveTerminalQueuedMaxSessions: parsePositiveInt(process.env.MESSAGE_QUEUE_ARCHIVE_TERMINAL_QUEUED_MAX_SESSIONS, 50),
    maxAttempts: parsePositiveInt(process.env.MESSAGE_QUEUE_MAX_ATTEMPTS, 5),
    retryBaseMs: parsePositiveInt(process.env.MESSAGE_QUEUE_RETRY_BASE_MS, 30000),
    retryMaxMs: parsePositiveInt(process.env.MESSAGE_QUEUE_RETRY_MAX_MS, 300000),
    processingTimeoutMs: parsePositiveInt(process.env.MESSAGE_QUEUE_PROCESSING_TIMEOUT_MS, 180000),
    webhookUrl: String(process.env.META_BLAST_WEBHOOK_PRIVATE_URL || process.env.META_BLAST_WEBHOOK_URL || '').trim(),
    webhookTimeoutMs: parsePositiveInt(process.env.META_BLAST_WEBHOOK_TIMEOUT_MS, 15000),
    webhookMaxAttempts: parsePositiveInt(process.env.META_BLAST_WEBHOOK_MAX_ATTEMPTS, 8),
    webhookRetryBaseMs: parsePositiveInt(process.env.META_BLAST_WEBHOOK_RETRY_BASE_MS, 10000),
    webhookRetryMaxMs: parsePositiveInt(process.env.META_BLAST_WEBHOOK_RETRY_MAX_MS, 300000),
  },
  sessionQueue: {
    pollIntervalMs: parsePositiveInt(process.env.META_SESSION_QUEUE_POLL_INTERVAL_MS, 1500),
    batchSize: parsePositiveInt(process.env.META_SESSION_QUEUE_BATCH_SIZE, 4),
    concurrency: parsePositiveInt(
      process.env.META_SESSION_QUEUE_CONCURRENCY,
      parsePositiveInt(process.env.META_SESSION_QUEUE_BATCH_SIZE, 4)
    ),
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
    batchSize: parsePositiveInt(process.env.META_CREATE_QUEUE_BATCH_SIZE, 4),
    concurrency: parsePositiveInt(process.env.META_CREATE_QUEUE_CONCURRENCY, 4),
    maxConcurrency: parsePositiveInt(process.env.META_CREATE_QUEUE_MAX_CONCURRENCY, 4),
    maxAttempts: parsePositiveInt(process.env.META_CREATE_QUEUE_MAX_ATTEMPTS, 5),
    retryBaseMs: parsePositiveInt(process.env.META_CREATE_QUEUE_RETRY_BASE_MS, 5000),
    retryMaxMs: parsePositiveInt(process.env.META_CREATE_QUEUE_RETRY_MAX_MS, 30000),
    flowTimeoutMs: parsePositiveInt(process.env.META_CREATE_FLOW_TIMEOUT_MS, 120000),
    validateTimeoutMs: parsePositiveInt(process.env.META_CREATE_VALIDATE_TIMEOUT_MS, 90000),
    validateTwofaInputTimeoutMs: parsePositiveInt(process.env.META_CREATE_VALIDATE_TWOFA_INPUT_TIMEOUT_MS, 10000),
    checkFlowTimeoutMs: parsePositiveInt(process.env.META_CREATE_CHECK_FLOW_TIMEOUT_MS, 30000),
    checkFlowAttempts: parsePositiveInt(process.env.META_CREATE_CHECK_FLOW_ATTEMPTS, 1),
    checkReloadTimeoutMs: parsePositiveInt(process.env.META_CREATE_CHECK_RELOAD_TIMEOUT_MS, 20000),
    checkSpinnerTimeoutMs: parsePositiveInt(process.env.META_CREATE_CHECK_SPINNER_TIMEOUT_MS, 10000),
    checkIndicatorTimeoutMs: parsePositiveInt(process.env.META_CREATE_CHECK_INDICATOR_TIMEOUT_MS, 7000),
    checkRecoverableRetryAttempts: parseNonNegativeInt(process.env.META_CREATE_CHECK_RECOVERABLE_RETRY_ATTEMPTS, 0),
    allowDeferredCheckOnInboxTimeout: parseBoolean(process.env.META_CREATE_ALLOW_DEFERRED_CHECK_ON_INBOX_TIMEOUT, true),
    processingTimeoutMs: parsePositiveInt(process.env.META_CREATE_QUEUE_PROCESSING_TIMEOUT_MS, 900000),
    browserExtraCapacity: parseNonNegativeInt(process.env.META_CREATE_BROWSER_EXTRA_CAPACITY, 2),
    browserPoolWaitMs: parseNonNegativeInt(process.env.META_CREATE_BROWSER_POOL_WAIT_MS, 90000),
    rejectWhenStalled: parseBoolean(process.env.META_CREATE_QUEUE_REJECT_WHEN_STALLED, false),
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
    launchTimeoutMs: parsePositiveInt(process.env.BROWSER_LAUNCH_TIMEOUT_MS, 60000),
    newPageTimeoutMs: parsePositiveInt(process.env.BROWSER_NEW_PAGE_TIMEOUT_MS, 30000),
    rendererProcessLimit: parseNonNegativeInt(process.env.BROWSER_RENDERER_PROCESS_LIMIT, 3),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-popup-blocking',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-features=AcceptCHFrame,AutoDeElevate,GlobalMediaControls,IsolateOrigins,LensOverlay,MediaRouter,OptimizationHints,PaintHolding,site-per-process,Translate',
    ],
  },
};
