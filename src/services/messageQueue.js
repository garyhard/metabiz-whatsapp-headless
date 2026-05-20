/**
 * Persistent message queue worker backed by sessionStore (SQLite).
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sessionStore } from './sessionStore.js';
import {
  getBrowserPoolStatus,
  getSessionInfo,
  restoreSessionFromStore,
  sendMessageForSession,
  warmSessionForQueuedWork,
} from './sessionManager.js';
import { SessionNotFoundError } from '../errors.js';
import { config } from '../config.js';

let workerStarted = false;
let stopRequested = false;
let pumping = false;
let timerRef = null;
let burstSessionId = null;
let burstRemaining = 0;
const activeJobs = new Map();
const warmingSessions = new Set();
let lastPumpStartedAt = null;
let lastPumpFinishedAt = null;
let lastPumpError = null;
let lastJobStartedAt = null;
let lastJobFinishedAt = null;
let webhookBlockedUntil = 0;
let lastWebhookFailureAt = null;
let lastWebhookFailureReason = null;

function webhookEnabled() {
  return String(config.queue.webhookUrl || '').trim().length > 0;
}

function webhookBlockRemainingMs(now = Date.now()) {
  const blockedUntil = Math.max(0, Number(webhookBlockedUntil) || 0);
  if (blockedUntil <= now) {
    return 0;
  }
  return blockedUntil - now;
}

function webhookBlocked(now = Date.now()) {
  return webhookBlockRemainingMs(now) > 0;
}

function clearWebhookBlock(now = Date.now()) {
  if ((Number(webhookBlockedUntil) || 0) <= now) {
    webhookBlockedUntil = 0;
  }
}

function blockWebhookDelivery(untilMs, reason, now = Date.now()) {
  webhookBlockedUntil = Math.max(now, Number(untilMs) || 0);
  lastWebhookFailureAt = now;
  lastWebhookFailureReason = reason ? String(reason) : null;
}

function workerConcurrencyLimit() {
  const configured = Number(config.sendConcurrency);
  const maxConcurrency = Math.max(1, Number(config.sendConcurrencyMax) || 1);
  const baseLimit = (!Number.isFinite(configured) || configured <= 0)
    ? maxConcurrency
    : Math.max(1, Math.min(configured, maxConcurrency));
  if (!createDemandActive()) {
    return baseLimit;
  }

  const createLimit = Math.max(1, Number(config.sendConcurrencyMaxDuringCreate) || 1);
  return Math.max(1, Math.min(baseLimit, createLimit));
}

function configuredWorkerConcurrencyLimit() {
  const configured = Number(config.sendConcurrencyConfigured ?? config.sendConcurrency);
  if (!Number.isFinite(configured) || configured <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, configured);
}

function hasAvailableWorkerCapacity() {
  pruneStaleActiveJobs();
  const limit = workerConcurrencyLimit();
  if (!Number.isFinite(limit)) {
    return true;
  }
  return activeJobs.size < limit;
}

function nextClaimLimit(maxBatch) {
  pruneStaleActiveJobs();
  const limit = workerConcurrencyLimit();
  if (!Number.isFinite(limit)) {
    return maxBatch;
  }
  return Math.max(0, Math.min(maxBatch, limit - activeJobs.size));
}

function workerStallThresholdMs() {
  return Math.max(
    Number(config.queue.processingTimeoutMs) || 0,
    (Number(config.queue.pollIntervalMs) || 0) * 4,
    30000
  );
}

function createDemand(now = Date.now()) {
  return sessionStore.createOperationDemand(now);
}

function createDemandActive(now = Date.now()) {
  return createDemand(now).active;
}

function createReservedBrowserSlots() {
  return Math.max(0, Number(config.queue.createReservedBrowserSlots) || 0);
}

function prewarmDuringCreate() {
  return config.queue.prewarmDuringCreate === true;
}

function messageJobNeedsBrowser(sessionId) {
  const session = getSessionInfo(sessionId);
  return !session?.liveBrowser;
}

function sendColdBrowserSlotsRemaining() {
  const browserPool = getBrowserPoolStatus();
  if (browserPool.availableSlots == null) {
    return null;
  }

  const remaining = Number(browserPool.availableSlots || 0)
    - countActiveSessionsAwaitingBrowser()
    - createReservedBrowserSlots();
  return Math.max(0, remaining);
}

function pruneStaleActiveJobs(now = Date.now()) {
  const thresholdMs = workerStallThresholdMs();
  for (const [task, meta] of activeJobs.entries()) {
    const ageMs = meta?.startedAt ? Math.max(0, now - meta.startedAt) : null;
    if (ageMs == null || ageMs <= thresholdMs) {
      continue;
    }
    activeJobs.delete(task);
    console.warn(
      `[MessageQueue] detached stale active slot job=${meta?.id || 'unknown'} session=${meta?.sessionId || 'unknown'} age_ms=${ageMs}`
    );
  }
}

function sessionBurstSize() {
  return Math.max(1, Number(config.queue.sessionBurstSize) || 1);
}

function sessionPrewarmEnabled() {
  return config.queue.sessionPrewarmEnabled !== false;
}

function sessionPrewarmLimit() {
  return Math.max(1, Number(config.queue.sessionPrewarmLimit) || 1);
}

function sessionPrewarmIdleTimeoutMs() {
  return Math.max(0, Number(config.queue.sessionPrewarmIdleTimeoutMs) || 0);
}

function hasActiveBurst() {
  return !!burstSessionId && burstRemaining > 0;
}

function clearBurstSession() {
  burstSessionId = null;
  burstRemaining = 0;
}

function countActiveSessionsAwaitingBrowser() {
  pruneStaleActiveJobs();
  const pendingSessionIds = new Set();
  for (const meta of activeJobs.values()) {
    const sessionId = String(meta?.sessionId || '').trim();
    if (!sessionId || pendingSessionIds.has(sessionId)) {
      continue;
    }
    const session = getSessionInfo(sessionId);
    if (session?.liveBrowser) {
      continue;
    }
    pendingSessionIds.add(sessionId);
  }
  return pendingSessionIds.size;
}

function addPreferredSessionId(target, seen, sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || seen.has(normalizedSessionId)) {
    return;
  }
  seen.add(normalizedSessionId);
  target.push(normalizedSessionId);
}

function buildPreferredClaimSessionIds(now = Date.now(), claimLimit = 1) {
  const preferredSessionIds = [];
  const seen = new Set();
  const targetCount = Math.max(1, Number(claimLimit) || 1);

  if (hasActiveBurst()) {
    addPreferredSessionId(preferredSessionIds, seen, burstSessionId);
  }

  const groups = sessionStore.listMessageJobSessions(Math.max(targetCount * 6, 25), now);
  for (const group of groups) {
    if (preferredSessionIds.length >= targetCount) {
      break;
    }
    if (Number(group?.runnableQueuedCount || 0) <= 0) {
      continue;
    }
    if (Number(group?.processingCount || 0) > 0) {
      continue;
    }
    const sessionInfo = getSessionInfo(group.sessionId);
    if (!sessionInfo?.liveBrowser) {
      continue;
    }
    addPreferredSessionId(preferredSessionIds, seen, group.sessionId);
  }

  return preferredSessionIds;
}

function trackClaimedSession(sessionId) {
  const targetSessionId = String(sessionId || '').trim();
  if (!targetSessionId) {
    clearBurstSession();
    return;
  }

  const burstSize = sessionBurstSize();
  if (burstSize <= 1) {
    clearBurstSession();
    return;
  }

  if (burstSessionId !== targetSessionId) {
    burstSessionId = targetSessionId;
    burstRemaining = Math.max(0, burstSize - 1);
    return;
  }

  burstRemaining = Math.max(0, burstRemaining - 1);
}

function clearWorkerTimer() {
  if (!timerRef) return;
  clearTimeout(timerRef);
  timerRef = null;
}

function schedulePump(delayMs = 0) {
  if (stopRequested) return;
  clearWorkerTimer();
  timerRef = setTimeout(() => {
    pumpQueue().catch((error) => {
      console.error('[MessageQueue] Pump failed:', error?.message || String(error));
      if (!stopRequested) {
        schedulePump(config.queue.pollIntervalMs);
      }
    });
  }, Math.max(0, Number(delayMs) || 0));
}

function backoffMs(attempt, baseMs, maxMs) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const exp = baseMs * (2 ** (safeAttempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(baseMs, 5000));
  return Math.min(exp + jitter, maxMs);
}

function buildErrorResult(error, fallbackMessage) {
  const message = fallbackMessage || (error?.message ? String(error.message) : String(error || 'Unknown error'));
  const details = (error?.details && typeof error.details === 'object' && !Array.isArray(error.details))
    ? error.details
    : null;
  const type = String(details?.type || '').toLowerCase();
  let errorCode = error?.errorCode ? String(error.errorCode) : null;
  if (!errorCode) {
    if (type === 'account_restricted' || message.toLowerCase().includes('account restricted')) {
      errorCode = 'account_restricted';
    } else if (type === 'captcha_required' || message.toLowerCase().includes('captcha checkpoint')) {
      errorCode = 'captcha_required';
    } else if (type === 'need_new_cookies' || message.toLowerCase().includes('need new cookies')) {
      errorCode = 'need_new_cookies';
    }
  }

  return {
    ok: false,
    error: message,
    errorCode,
    name: error?.name ? String(error.name) : null,
    details,
  };
}

function isRetryableMessageJobError(errorResult) {
  const code = String(errorResult?.errorCode || '').toLowerCase();
  return !['account_restricted', 'need_new_cookies', 'captcha_required'].includes(code);
}

async function processJob(job) {
  try {
    const sendPayload = {
      extension: job.extension,
      phoneNumber: job.phoneNumber,
      message: job.message,
      useReplyFlow: job.useReplyFlow,
      includeSuccessScreenshot: job.includeSuccessScreenshot,
      priority: job.priority || (job.useReplyFlow ? 'high' : 'normal'),
    };
    let result;
    try {
      result = await sendMessageForSession(job.sessionId, sendPayload);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) {
        throw error;
      }

      await restoreSessionFromStore(job.sessionId);
      result = await sendMessageForSession(job.sessionId, sendPayload);
    }
    const updatedJob = sessionStore.markMessageJobSent(job.id, result || {});
    if (updatedJob?.status !== 'sent') {
      console.warn(
        `[MessageQueue] job completion ignored id=${job.id} current_status=${updatedJob?.status || 'missing'}`
      );
      return { outcome: 'ignored', sessionId: job.sessionId, jobId: job.id };
    }
    console.log(`[MessageQueue] job sent id=${job.id} attempts=${job.attempts}`);
    return { outcome: 'sent', sessionId: job.sessionId, jobId: job.id };
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    const errorResult = buildErrorResult(error, message);
    const maxAttempts = Math.max(1, Number(job.maxAttempts) || config.queue.maxAttempts);
    const attempts = Math.max(1, Number(job.attempts) || 1);
    const retryable = isRetryableMessageJobError(errorResult);
    if (!retryable || attempts >= maxAttempts) {
      const updatedJob = sessionStore.markMessageJobError(job.id, message, errorResult);
      if (updatedJob?.status !== 'error') {
        console.warn(
          `[MessageQueue] job error transition ignored id=${job.id} current_status=${updatedJob?.status || 'missing'}`
        );
        return { outcome: 'ignored', sessionId: job.sessionId, jobId: job.id };
      }
      console.warn(
        `[MessageQueue] job failed id=${job.id} attempts=${attempts}/${maxAttempts} retryable=${retryable}`
      );
      return { outcome: 'error', sessionId: job.sessionId, jobId: job.id };
    }

    const retryDelay = backoffMs(attempts, config.queue.retryBaseMs, config.queue.retryMaxMs);
    const retryAt = Date.now() + retryDelay;
    const updatedJob = sessionStore.markMessageJobRetry(job.id, message, retryAt);
    if (updatedJob?.status !== 'queued') {
      console.warn(
        `[MessageQueue] job retry transition ignored id=${job.id} current_status=${updatedJob?.status || 'missing'}`
      );
      return { outcome: 'ignored', sessionId: job.sessionId, jobId: job.id };
    }
    console.warn(`[MessageQueue] job retry id=${job.id} attempts=${attempts}/${maxAttempts} retry_in_ms=${retryDelay}`);
    return { outcome: 'retry', sessionId: job.sessionId, jobId: job.id };
  }
}

function startBackgroundJob(job) {
  lastJobStartedAt = Date.now();
  const task = processJob(job)
    .then((result) => {
      if (result?.sessionId && result.outcome !== 'sent' && burstSessionId === String(result.sessionId)) {
        clearBurstSession();
      }
      return result;
    })
    .catch((error) => {
      if (burstSessionId === String(job.sessionId)) {
        clearBurstSession();
      }
      console.error(
        `[MessageQueue] unhandled process error id=${job?.id || 'unknown'} error=${error?.message || String(error)}`
      );
    })
    .finally(() => {
      activeJobs.delete(task);
      lastJobFinishedAt = Date.now();
      if (!stopRequested) {
        schedulePump(0);
      }
    });

  activeJobs.set(task, {
    id: job.id,
    sessionId: job.sessionId,
    startedAt: Date.now(),
  });
  return task;
}

function buildWebhookPayload(job) {
  const eventPrefix = job.metaBlastMessageId ? 'meta_blast_message' : 'meta_outbound_message';
  return {
    source: 'metabiz-whatsapp-headless',
    event: `${eventPrefix}.${job.status}`,
    occurred_at: new Date().toISOString(),
    job: {
      id: job.id,
      request_id: job.requestId || null,
      meta_blast_message_id: job.metaBlastMessageId || null,
      use_reply_flow: job.useReplyFlow === true,
      session_id: job.sessionId,
      priority: job.priority || 'normal',
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.maxAttempts,
      error_message: job.errorMessage || null,
      result: job.result || null,
      created_at: job.createdAt || null,
      updated_at: job.updatedAt || null,
      finished_at: job.finishedAt || null,
    },
  };
}

function signPayload(rawBody) {
  const secret = config.apiKey;
  if (!secret) return null;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

function isRetryableWebhookStatus(statusCode) {
  const code = Number(statusCode) || 0;
  if (code <= 0) return true;
  if (code >= 500) return true;
  return [408, 409, 425, 429].includes(code);
}

async function postWebhook(job) {
  const url = config.queue.webhookUrl;
  if (!url) {
    return { ok: false, error: 'webhook_url_not_set', retryable: false, statusCode: null };
  }

  const payload = buildWebhookPayload(job);
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.queue.webhookTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-MetaBlast-Signature': signature } : {}),
      },
      body: rawBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${response.status} ${text}`.trim(),
        retryable: isRetryableWebhookStatus(response.status),
        statusCode: Number(response.status) || null,
      };
    }
    return { ok: true };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? `timeout after ${config.queue.webhookTimeoutMs}ms`
        : (error?.message || String(error)),
      retryable: true,
      statusCode: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWebhook(job) {
  const now = Date.now();
  const attempts = Math.max(1, Number(job.webhookAttempts) || 1);
  const maxAttempts = Math.max(1, Number(config.queue.webhookMaxAttempts) || 1);
  const webhookResult = await postWebhook(job);
  if (webhookResult.ok) {
    sessionStore.markWebhookDelivered(job.id);
    clearWebhookBlock(now);
    console.log(`[MessageQueue] webhook delivered job=${job.id} status=${job.status}`);
    return { outcome: 'delivered', jobId: job.id };
  }

  if (webhookResult.retryable === false) {
    sessionStore.markWebhookStopped(job.id, webhookResult.error);
    console.warn(
      `[MessageQueue] webhook stopped job=${job.id} status=${job.status} error=${webhookResult.error}`
    );
    return { outcome: 'stopped', jobId: job.id };
  }

  if (attempts >= maxAttempts) {
    const stopError = `${webhookResult.error} (webhook max attempts reached)`;
    sessionStore.markWebhookStopped(job.id, stopError);
    console.warn(
      `[MessageQueue] webhook stopped job=${job.id} status=${job.status} attempts=${attempts}/${maxAttempts} error=${webhookResult.error}`
    );
    return { outcome: 'stopped', jobId: job.id };
  }

  const delay = backoffMs(
    attempts,
    config.queue.webhookRetryBaseMs,
    config.queue.webhookRetryMaxMs
  );
  const retryAt = now + delay;
  sessionStore.markWebhookRetry(job.id, webhookResult.error, retryAt);
  blockWebhookDelivery(retryAt, webhookResult.error, now);
  console.warn(
    `[MessageQueue] webhook retry job=${job.id} status=${job.status} attempts=${attempts}/${maxAttempts} in_ms=${delay} error=${webhookResult.error}`
  );
  return { outcome: 'retry', jobId: job.id, retryAt };
}

async function flushWebhookQueue(maxBatch) {
  if (!webhookEnabled()) {
    return { delivered: 0, stopped: 0, blocked: false };
  }

  const now = Date.now();
  clearWebhookBlock(now);
  if (webhookBlocked(now)) {
    return { delivered: 0, stopped: 0, blocked: true };
  }

  let delivered = 0;
  let stopped = 0;
  for (let i = 0; i < maxBatch; i += 1) {
    clearWebhookBlock();
    if (webhookBlocked()) {
      break;
    }
    const pending = sessionStore.claimPendingWebhook(Date.now());
    if (!pending) break;
    const result = await deliverWebhook(pending);
    if (result?.outcome === 'delivered') {
      delivered += 1;
      continue;
    }
    if (result?.outcome === 'retry') {
      break;
    }
    if (result?.outcome === 'stopped') {
      stopped += 1;
    }
  }
  return { delivered, stopped, blocked: webhookBlocked() };
}

function canPrewarmSessionGroup(group, browserSlotsRemaining) {
  if (!group || !group.sessionId) return false;
  if (Number(group.runnableQueuedCount || 0) <= 0) return false;
  if (Number(group.processingCount || 0) > 0) return false;

  const sessionInfo = getSessionInfo(group.sessionId);
  if (sessionInfo?.liveBrowser) return false;
  if (sessionInfo?.status === 'restricted') return false;
  if (sessionInfo?.status === 'needs_manual_action') return false;
  if (sessionInfo?.manualAction?.type && sessionInfo.manualAction.type !== 'account_restricted') {
    return false;
  }

  const storedSession = sessionStore.getBySessionId(group.sessionId);
  if (!sessionInfo && !storedSession) return false;
  if (storedSession?.restricted || storedSession?.status === 'restricted') return false;
  if (storedSession?.status === 'needs_manual_action') return false;

  if (browserSlotsRemaining != null && browserSlotsRemaining <= 0) return false;
  if (warmingSessions.has(group.sessionId)) return false;
  return true;
}

function scheduleSessionPrewarm(sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || warmingSessions.has(normalizedSessionId)) {
    return false;
  }

  warmingSessions.add(normalizedSessionId);
  void warmSessionForQueuedWork(normalizedSessionId, {
    holdMs: sessionPrewarmIdleTimeoutMs(),
  })
    .then((result) => {
      if (result?.warmed) {
        console.log(`[MessageQueue] prewarmed session=${normalizedSessionId}`);
      }
    })
    .catch((error) => {
      console.warn(
        `[MessageQueue] prewarm failed session=${normalizedSessionId} error=${error?.message || String(error)}`
      );
    })
    .finally(() => {
      warmingSessions.delete(normalizedSessionId);
      if (!stopRequested) {
        schedulePump(0);
      }
    });

  return true;
}

function prewarmQueuedSessions() {
  if (!sessionPrewarmEnabled()) {
    return 0;
  }
  const demand = createDemand();
  if (demand.active && !prewarmDuringCreate()) {
    return 0;
  }

  const browserPool = getBrowserPoolStatus();
  const activeBrowserDemand = countActiveSessionsAwaitingBrowser();
  const reservedForCreate = createReservedBrowserSlots();
  const availableSlots = browserPool.availableSlots == null
    ? null
    : Math.max(0, Number(browserPool.availableSlots || 0) - activeBrowserDemand - reservedForCreate);
  if (availableSlots != null && availableSlots <= 0) {
    return 0;
  }

  const warmupLimit = availableSlots == null
    ? sessionPrewarmLimit()
    : Math.min(sessionPrewarmLimit(), availableSlots);
  if (warmupLimit <= 0) {
    return 0;
  }

  const groups = sessionStore.listMessageJobSessions(Math.max(warmupLimit * 4, warmupLimit), Date.now());
  let scheduled = 0;
  let remainingSlots = availableSlots;

  for (const group of groups) {
    if (scheduled >= warmupLimit) {
      break;
    }
    if (!canPrewarmSessionGroup(group, remainingSlots)) {
      continue;
    }
    const queued = scheduleSessionPrewarm(group.sessionId);
    if (!queued) {
      continue;
    }
    scheduled += 1;
    if (remainingSlots != null) {
      remainingSlots = Math.max(0, remainingSlots - 1);
    }
  }

  return scheduled;
}

export async function pumpQueue() {
  if (stopRequested) return;
  if (pumping) return;

  pruneStaleActiveJobs();
  pumping = true;
  lastPumpStartedAt = Date.now();
  lastPumpError = null;
  try {
    sessionStore.stopInvalidMessageJobWebhooks();
    sessionStore.requeueStaleProcessingMessageJobs(config.queue.processingTimeoutMs);
    const maxBatch = Math.max(1, Number(config.queue.batchSize) || 1);
    const claimLimit = nextClaimLimit(maxBatch);
    const jobs = [];
    const preferredSessionIds = buildPreferredClaimSessionIds(Date.now(), claimLimit);
    let preferredSessionIndex = 0;
    let coldBrowserSlotsRemaining = sendColdBrowserSlotsRemaining();

    while (!stopRequested && jobs.length < claimLimit) {
      const now = Date.now();
      let job = null;

      while (!job && preferredSessionIndex < preferredSessionIds.length) {
        const preferredSessionId = preferredSessionIds[preferredSessionIndex];
        preferredSessionIndex += 1;
        job = sessionStore.claimNextMessageJob(now, preferredSessionId, true);
      }

      if (!job && (coldBrowserSlotsRemaining == null || coldBrowserSlotsRemaining > 0)) {
        job = sessionStore.claimNextMessageJob(now);
        if (job && messageJobNeedsBrowser(job.sessionId) && coldBrowserSlotsRemaining != null) {
          coldBrowserSlotsRemaining = Math.max(0, coldBrowserSlotsRemaining - 1);
        }
      }

      if (!job) {
        if (preferredSessionIndex < preferredSessionIds.length) {
          continue;
        }
        break;
      }

      trackClaimedSession(job.sessionId);
      jobs.push(job);
    }

    if (jobs.length > 0) {
      jobs.forEach((job) => startBackgroundJob(job));
    }
    prewarmQueuedSessions();
    await flushWebhookQueue(maxBatch);
  } catch (error) {
    lastPumpError = error?.message || String(error);
    throw error;
  } finally {
    pumping = false;
    lastPumpFinishedAt = Date.now();
  }

  if (stopRequested) return;
  const now = Date.now();
  clearWebhookBlock(now);
  if (
    (hasAvailableWorkerCapacity() && sessionStore.hasRunnableMessageJob(now)) ||
    (webhookEnabled() && sessionStore.hasPendingWebhook(now) && !webhookBlocked(now))
  ) {
    schedulePump(0);
  } else if (webhookEnabled() && webhookBlocked(now)) {
    schedulePump(webhookBlockRemainingMs(now));
  } else {
    schedulePump(config.queue.pollIntervalMs);
  }
}

export function startMessageQueueWorker() {
  if (workerStarted) return;
  workerStarted = true;
  stopRequested = false;
  webhookBlockedUntil = 0;
  lastWebhookFailureAt = null;
  lastWebhookFailureReason = null;
  sessionStore.requeueStaleProcessingMessageJobs(0);
  console.log('[MessageQueue] worker started');
  schedulePump(0);
}

export function stopMessageQueueWorker() {
  stopRequested = true;
  clearWorkerTimer();
  console.log('[MessageQueue] worker stopped');
}

export function getMessageQueueWorkerStatus(now = Date.now()) {
  pruneStaleActiveJobs(now);
  const concurrencyLimit = workerConcurrencyLimit();
  const configuredConcurrencyLimit = configuredWorkerConcurrencyLimit();
  const demand = createDemand(now);
  const createActive = demand.active;
  const createReservedSlots = createReservedBrowserSlots();
  let oldestActiveJobAgeMs = null;
  for (const meta of activeJobs.values()) {
    const ageMs = meta?.startedAt ? Math.max(0, now - meta.startedAt) : null;
    if (ageMs == null) continue;
    if (oldestActiveJobAgeMs == null || ageMs > oldestActiveJobAgeMs) {
      oldestActiveJobAgeMs = ageMs;
    }
  }

  const stalled = (
    (pumping && !!lastPumpStartedAt && now - lastPumpStartedAt > workerStallThresholdMs()) ||
    (oldestActiveJobAgeMs != null && oldestActiveJobAgeMs > workerStallThresholdMs())
  );

  return {
    workerStarted,
    stopRequested,
    pumping,
    stalled,
    activeJobs: activeJobs.size,
    createDemand: demand,
    createThrottleActive: createActive,
    sendConcurrencyMaxDuringCreate: Math.max(1, Number(config.sendConcurrencyMaxDuringCreate) || 1),
    createReservedBrowserSlots: createReservedSlots,
    prewarmDuringCreate: prewarmDuringCreate(),
    prewarmingSessions: warmingSessions.size,
    prewarmingSessionIds: Array.from(warmingSessions.values()),
    oldestActiveJobAgeMs,
    configuredConcurrencyLimit: Number.isFinite(configuredConcurrencyLimit) ? configuredConcurrencyLimit : null,
    maxConcurrencyLimit: Math.max(1, Number(config.sendConcurrencyMax) || 1),
    concurrencyLimit: Number.isFinite(concurrencyLimit) ? concurrencyLimit : null,
    pollIntervalMs: Math.max(1, Number(config.queue.pollIntervalMs) || 1),
    batchSize: Math.max(1, Number(config.queue.batchSize) || 1),
    lastPumpStartedAt,
    lastPumpFinishedAt,
    lastPumpAgeMs: lastPumpStartedAt ? Math.max(0, now - lastPumpStartedAt) : null,
    lastJobStartedAt,
    lastJobFinishedAt,
    lastPumpError,
    webhookBlockedUntil: webhookBlocked(now) ? webhookBlockedUntil : null,
    webhookBlockedForMs: webhookBlockRemainingMs(now),
    lastWebhookFailureAt,
    lastWebhookFailureReason,
  };
}

export function enqueueMessageJob({
  requestId = null,
  metaBlastMessageId = null,
  sessionId,
  priority = 'normal',
  extension,
  phoneNumber,
  message,
  useReplyFlow = false,
  includeSuccessScreenshot = false,
  maxAttempts = null,
}) {
  const normalizedRequestId = requestId ? String(requestId).trim() : null;
  if (normalizedRequestId) {
    const existing = sessionStore.getMessageJobByRequestId(normalizedRequestId);
    if (existing) {
      return { job: existing, created: false };
    }
  }

  const job = sessionStore.enqueueMessageJob({
    id: uuidv4(),
    requestId: normalizedRequestId,
    metaBlastMessageId: metaBlastMessageId ? String(metaBlastMessageId).trim() : null,
    sessionId: String(sessionId),
    priority,
    extension: String(extension),
    phoneNumber: String(phoneNumber),
    message: String(message),
    useReplyFlow: useReplyFlow === true,
    includeSuccessScreenshot: includeSuccessScreenshot === true,
    maxAttempts: Math.max(1, Number(maxAttempts) || config.queue.maxAttempts),
  });
  schedulePump(0);
  return { job, created: true };
}

export function getMessageJob(jobId) {
  return sessionStore.getMessageJob(String(jobId || ''));
}
