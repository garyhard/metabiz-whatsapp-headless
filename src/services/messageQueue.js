/**
 * Persistent message queue worker backed by sessionStore (SQLite).
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sessionStore } from './sessionStore.js';
import { getBrowserPoolStatus, getSessionInfo, sendMessageForSession, warmSessionForQueuedWork } from './sessionManager.js';
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

function webhookEnabled() {
  return String(config.queue.webhookUrl || '').trim().length > 0;
}

function workerConcurrencyLimit() {
  const configured = Number(config.sendConcurrency);
  if (!Number.isFinite(configured) || configured <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, configured);
}

function hasAvailableWorkerCapacity() {
  const limit = workerConcurrencyLimit();
  if (!Number.isFinite(limit)) {
    return true;
  }
  return activeJobs.size < limit;
}

function nextClaimLimit(maxBatch) {
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
    const result = await sendMessageForSession(job.sessionId, {
      extension: job.extension,
      phoneNumber: job.phoneNumber,
      message: job.message,
      useReplyFlow: job.useReplyFlow,
      includeSuccessScreenshot: job.includeSuccessScreenshot,
      priority: job.priority || (job.useReplyFlow ? 'high' : 'normal'),
    });
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
    return { ok: false, error: error?.message || String(error), retryable: true, statusCode: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWebhook(job) {
  const webhookResult = await postWebhook(job);
  if (webhookResult.ok) {
    sessionStore.markWebhookDelivered(job.id);
    console.log(`[MessageQueue] webhook delivered job=${job.id} status=${job.status}`);
    return;
  }

  if (webhookResult.retryable === false) {
    sessionStore.markWebhookStopped(job.id, webhookResult.error);
    console.warn(
      `[MessageQueue] webhook stopped job=${job.id} status=${job.status} error=${webhookResult.error}`
    );
    return;
  }

  const delay = backoffMs(
    Math.max(1, Number(job.webhookAttempts) || 1),
    config.queue.webhookRetryBaseMs,
    config.queue.webhookRetryMaxMs
  );
  sessionStore.markWebhookRetry(job.id, webhookResult.error, Date.now() + delay);
  console.warn(
    `[MessageQueue] webhook retry job=${job.id} status=${job.status} in_ms=${delay} error=${webhookResult.error}`
  );
}

async function flushWebhookQueue(maxBatch) {
  if (!webhookEnabled()) {
    return 0;
  }

  let delivered = 0;
  for (let i = 0; i < maxBatch; i += 1) {
    const pending = sessionStore.claimPendingWebhook(Date.now());
    if (!pending) break;
    await deliverWebhook(pending);
    delivered += 1;
  }
  return delivered;
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

  const browserPool = getBrowserPoolStatus();
  const activeBrowserDemand = countActiveSessionsAwaitingBrowser();
  const availableSlots = browserPool.availableSlots == null
    ? null
    : Math.max(0, Number(browserPool.availableSlots || 0) - activeBrowserDemand);
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

    while (!stopRequested && jobs.length < claimLimit) {
      const now = Date.now();
      let job = null;

      while (!job && preferredSessionIndex < preferredSessionIds.length) {
        const preferredSessionId = preferredSessionIds[preferredSessionIndex];
        preferredSessionIndex += 1;
        job = sessionStore.claimNextMessageJob(now, preferredSessionId, true);
      }

      if (!job) {
        job = sessionStore.claimNextMessageJob(now);
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
  if (
    (hasAvailableWorkerCapacity() && sessionStore.hasRunnableMessageJob(Date.now())) ||
    (webhookEnabled() && sessionStore.hasPendingWebhook(Date.now()))
  ) {
    schedulePump(0);
  } else {
    schedulePump(config.queue.pollIntervalMs);
  }
}

export function startMessageQueueWorker() {
  if (workerStarted) return;
  workerStarted = true;
  stopRequested = false;
  console.log('[MessageQueue] worker started');
  schedulePump(0);
}

export function stopMessageQueueWorker() {
  stopRequested = true;
  clearWorkerTimer();
  console.log('[MessageQueue] worker stopped');
}

export function getMessageQueueWorkerStatus(now = Date.now()) {
  const concurrencyLimit = workerConcurrencyLimit();
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
    prewarmingSessions: warmingSessions.size,
    prewarmingSessionIds: Array.from(warmingSessions.values()),
    oldestActiveJobAgeMs,
    concurrencyLimit: Number.isFinite(concurrencyLimit) ? concurrencyLimit : null,
    pollIntervalMs: Math.max(1, Number(config.queue.pollIntervalMs) || 1),
    batchSize: Math.max(1, Number(config.queue.batchSize) || 1),
    lastPumpStartedAt,
    lastPumpFinishedAt,
    lastPumpAgeMs: lastPumpStartedAt ? Math.max(0, now - lastPumpStartedAt) : null,
    lastJobStartedAt,
    lastJobFinishedAt,
    lastPumpError,
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
