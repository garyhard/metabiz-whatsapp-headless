/**
 * Persistent session-flow queue worker backed by sessionStore (SQLite).
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sessionStore } from './sessionStore.js';
import {
  checkSessionForSession,
  createSession,
  destroySession,
  updateSessionCookies,
  updateSessionProxy,
  validateCookies,
} from './sessionManager.js';
import { config } from '../config.js';
import {
  AutomationError,
  BrowserCrashError,
  FlowTimeoutError,
  InvalidInputError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from '../errors.js';

let workerStarted = false;
let stopRequested = false;
let pumping = false;
let timerRef = null;
let lastPumpStartedAt = null;
let lastPumpFinishedAt = null;
let lastPumpError = null;

function normalizeContext(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizePriority(value, fallback = 'normal') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'normal' || normalized === 'low') {
    return normalized;
  }
  return fallback;
}

function contextFlow(payload) {
  return String(normalizeContext(payload?.context)?.flow || '').trim().toLowerCase();
}

function contextWhatsappSessionId(payload) {
  return String(normalizeContext(payload?.context)?.whatsapp_session_id || '').trim();
}

function inferPriority(jobType, payload = {}, explicitPriority = null) {
  const explicit = normalizePriority(explicitPriority || payload.priority || '', '');
  const type = String(jobType || '').trim();
  const flow = contextFlow(payload);
  if (explicit === 'high' || explicit === 'low') return explicit;
  if (type === 'create_session' || flow === 'create_meta' || flow === 'test_flow' || flow === 'test_flow_retry') {
    return 'high';
  }
  if (
    flow === 'refresh_meta' ||
    flow === 'update_cookies' ||
    flow === 'bulk_refresh' ||
    flow === 'reconcile_missing' ||
    flow === 'auto_link_meta' ||
    flow === 'periodic_check'
  ) {
    return 'low';
  }
  if (explicit === 'normal') return explicit;
  return 'normal';
}

function inferCoalesceKey(jobType, targetSessionId, cUser, payload = {}, priority = 'normal') {
  const type = String(jobType || '').trim();
  const target = String(targetSessionId || '').trim();
  const contextSessionId = contextWhatsappSessionId(payload);
  const flow = contextFlow(payload);
  if (type === 'validate_cookies' && contextSessionId && priority !== 'high') {
    return `${type}:whatsapp_session:${contextSessionId}`;
  }
  if (type === 'validate_cookies' && cUser && priority === 'low') {
    return `${type}:c_user:${String(cUser).trim()}`;
  }
  if (['update_session_cookies', 'update_session_proxy', 'check_session', 'resume_check', 'destroy_session'].includes(type) && target) {
    return `${type}:target:${target}`;
  }
  if (type === 'create_session' && contextSessionId && flow !== 'create_meta') {
    return `${type}:whatsapp_session:${contextSessionId}`;
  }
  return null;
}

function webhookEnabled() {
  return String(config.sessionQueue.webhookUrl || '').trim().length > 0;
}

function resolveWebhookUrl(job) {
  return String(job?.webhookUrl || config.sessionQueue.webhookUrl || '').trim();
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
    pumpSessionFlowQueue().catch((error) => {
      console.error('[SessionFlowQueue] Pump failed:', error?.message || String(error));
      if (!stopRequested) {
        schedulePump(config.sessionQueue.pollIntervalMs);
      }
    });
  }, Math.max(0, Number(delayMs) || 0));
}

function workerStallThresholdMs() {
  return Math.max(
    Number(config.sessionQueue.processingTimeoutMs) || 0,
    (Number(config.sessionQueue.pollIntervalMs) || 0) * 4,
    30000
  );
}

function sessionFlowJobTimeoutMs(job) {
  const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {};
  const requested = Number(payload.jobTimeoutMs || payload.flowTimeoutMs || payload.validateTimeoutMs);
  if (Number.isFinite(requested) && requested > 0) {
    return requested;
  }

  if (job?.jobType === 'validate_cookies') {
    return Math.max(
      Number(config.createQueue.validateTimeoutMs) || 0,
      Number(config.sessionQueue.pollIntervalMs) || 0,
      30000
    );
  }

  return Math.max(
    Number(config.sessionQueue.processingTimeoutMs) || 0,
    (Number(config.sessionQueue.pollIntervalMs) || 0) * 4,
    30000
  );
}

function withSessionFlowJobTimeout(promise, timeoutMs, job) {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const type = job?.jobType || 'unknown';
      const id = job?.id || 'unknown';
      reject(new FlowTimeoutError(`Session flow job ${type} timed out after ${timeoutMs}ms (id=${id})`));
    }, timeoutMs);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

function backoffMs(attempt, baseMs, maxMs) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const exp = baseMs * (2 ** (safeAttempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(baseMs, 5000));
  return Math.min(exp + jitter, maxMs);
}

function deriveErrorCode(error, message) {
  const detailsType = String(error?.details?.type || '').trim().toLowerCase();
  if (detailsType) {
    if (detailsType === 'need_new_cookies') return 'need_new_cookies';
    if (detailsType === 'captcha_required') return 'captcha_required';
    if (detailsType === 'account_restricted') return 'account_restricted';
  }

  if (error instanceof InvalidInputError) {
    const lowered = String(message || '').toLowerCase();
    if (
      lowered.includes('session not authenticated') ||
      lowered.includes('redirected to auth') ||
      lowered.includes('loginpage') ||
      lowered.includes('checkpoint') ||
      lowered.includes('need new cookies')
    ) {
      return 'need_new_cookies';
    }
    return 'invalid_input';
  }
  if (error instanceof SessionNotFoundError) return 'session_not_found';
  if (error instanceof SessionAlreadyExistsError) return 'session_exists';
  if (error instanceof FlowTimeoutError) return 'flow_timeout';
  if (error instanceof BrowserCrashError) return 'browser_crash';
  if (error instanceof AutomationError) {
    const lowered = String(message || '').toLowerCase();
    if (lowered.includes('account restricted')) return 'account_restricted';
    if (lowered.includes('captcha checkpoint') || lowered.includes('captcha')) return 'captcha_required';
    if (lowered.includes('need new cookies')) return 'need_new_cookies';
    return 'automation_error';
  }
  return null;
}

function buildErrorResult(error, partialResult = null, fallbackMessage = null) {
  const message = fallbackMessage || (error?.message ? String(error.message) : String(error || 'Unknown error'));
  const details = (error?.details && typeof error.details === 'object' && !Array.isArray(error.details))
    ? error.details
    : null;

  return {
    ok: false,
    error: message,
    errorCode: deriveErrorCode(error, message),
    name: error?.name ? String(error.name) : null,
    details,
    result: partialResult || null,
  };
}

function isRetryableSessionFlowError(errorResult) {
  const code = String(errorResult?.errorCode || '').toLowerCase();
  return ![
    'invalid_input',
    'need_new_cookies',
    'captcha_required',
    'account_restricted',
    'session_not_found',
    'session_exists',
  ].includes(code);
}

async function executeJob(job) {
  const payload = job.payload || {};
  switch (job.jobType) {
    case 'validate_cookies': {
      const validationResult = await validateCookies(payload.cookies, payload.proxy || null, {
        persist: payload.persist === true,
        freshBrowser: payload.freshBrowser === true,
        twofaSecret: payload.twofaSecret || null,
        validateTimeoutMs: Number(payload.validateTimeoutMs) > 0
          ? Number(payload.validateTimeoutMs)
          : config.createQueue.validateTimeoutMs,
        twofaInputTimeoutMs: Number(payload.twofaInputTimeoutMs) > 0
          ? Number(payload.twofaInputTimeoutMs)
          : config.createQueue.validateTwofaInputTimeoutMs,
      });

      if (payload.checkAfterSuccess === true && validationResult?.sessionId) {
        try {
          const checkResult = await checkSessionForSession(validationResult.sessionId, {
            requestId: job.requestId || null,
          });
          return {
            ...validationResult,
            check: { ok: true, ...(checkResult || {}) },
          };
        } catch (error) {
          error.partialResult = validationResult;
          throw error;
        }
      }

      return validationResult;
    }
    case 'create_session':
      return createSession(payload.cookies, null, null, payload.proxy || null, {
        twofaSecret: payload.twofaSecret || null,
      });
    case 'check_session': {
      const result = await checkSessionForSession(job.targetSessionId, {
        requestId: job.requestId || null,
        priority: job.payload?.priority || 'normal',
        browserPoolOptions: { lane: job.payload?.browserPoolLane || 'default' },
      });
      return {
        ok: true,
        sessionId: job.targetSessionId,
        ...(result || {}),
      };
    }
    case 'resume_check': {
      const result = await checkSessionForSession(job.targetSessionId, {
        requestId: job.requestId || null,
        priority: job.payload?.priority || 'normal',
        browserPoolOptions: { lane: job.payload?.browserPoolLane || 'default' },
      });
      return {
        ok: true,
        sessionId: job.targetSessionId,
        ...(result || {}),
      };
    }
    case 'update_session_cookies':
      try {
        await updateSessionCookies(job.targetSessionId, payload.cookies, {
          twofaSecret: payload.twofaSecret || null,
          proxy: payload.proxy || null,
        });
        return {
          ok: true,
          sessionId: job.targetSessionId,
          cUser: payload.cUser || null,
        };
      } catch (error) {
        if (!(error instanceof SessionNotFoundError) || payload.fallbackCreateOnNotFound !== true) {
          throw error;
        }

        return {
          ...(await createSession(payload.cookies, null, null, payload.proxy || null, {
            twofaSecret: payload.twofaSecret || null,
          })),
          recreated: true,
        };
      }
    case 'update_session_proxy': {
      const result = await updateSessionProxy(job.targetSessionId, payload.proxy || null);
      return {
        ok: true,
        sessionId: result?.sessionId || job.targetSessionId,
        ...(result || {}),
      };
    }
    case 'destroy_session':
      await destroySession(job.targetSessionId);
      return {
        ok: true,
        sessionId: job.targetSessionId,
        destroyed: true,
      };
    default:
      throw new InvalidInputError(`Unsupported session flow job type: ${job.jobType}`);
  }
}

async function processJob(job) {
  try {
    const timeoutMs = sessionFlowJobTimeoutMs(job);
    const result = await withSessionFlowJobTimeout(executeJob(job), timeoutMs, job);
    const updatedJob = sessionStore.markSessionFlowJobCompleted(job.id, result || {});
    if (updatedJob?.status !== 'completed') {
      console.warn(
        `[SessionFlowQueue] job completion ignored id=${job.id} type=${job.jobType} current_status=${updatedJob?.status || 'missing'}`
      );
      return;
    }
    console.log(`[SessionFlowQueue] job completed id=${job.id} type=${job.jobType} attempts=${job.attempts}`);
    return;
  } catch (error) {
    const partialResult = error?.partialResult || null;
    const errorResult = buildErrorResult(error, partialResult);
    const message = errorResult.error;
    const maxAttempts = Math.max(1, Number(job.maxAttempts) || config.sessionQueue.maxAttempts);
    const attempts = Math.max(1, Number(job.attempts) || 1);
    const retryable =
      isRetryableSessionFlowError(errorResult) &&
      !(job.jobType === 'create_session' && errorResult.errorCode === 'flow_timeout');

    if (!retryable || attempts >= maxAttempts) {
      const updatedJob = sessionStore.markSessionFlowJobError(job.id, message, errorResult.errorCode, errorResult);
      if (updatedJob?.status !== 'error') {
        console.warn(
          `[SessionFlowQueue] job error transition ignored id=${job.id} type=${job.jobType} current_status=${updatedJob?.status || 'missing'}`
        );
        return;
      }
      console.warn(
        `[SessionFlowQueue] job failed id=${job.id} type=${job.jobType} attempts=${attempts}/${maxAttempts} retryable=${retryable}`
      );
      return;
    }

    const retryDelay = backoffMs(attempts, config.sessionQueue.retryBaseMs, config.sessionQueue.retryMaxMs);
    const retryAt = Date.now() + retryDelay;
    const updatedJob = sessionStore.markSessionFlowJobRetry(job.id, message, errorResult.errorCode, retryAt, errorResult);
    if (updatedJob?.status !== 'queued') {
      console.warn(
        `[SessionFlowQueue] job retry transition ignored id=${job.id} type=${job.jobType} current_status=${updatedJob?.status || 'missing'}`
      );
      return;
    }
    console.warn(
      `[SessionFlowQueue] job retry id=${job.id} type=${job.jobType} attempts=${attempts}/${maxAttempts} retry_in_ms=${retryDelay}`
    );
  }
}

function buildWebhookPayload(job) {
  const result = job.result || null;
  const cUser = job.cUser || result?.cUser || null;
  return {
    source: 'metabiz-whatsapp-headless',
    event: `meta_session.${job.jobType}.${job.status}`,
    occurred_at: new Date().toISOString(),
    job: {
      id: job.id,
      request_id: job.requestId || null,
      type: job.jobType,
      target_session_id: job.targetSessionId || null,
      c_user: cUser || null,
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.maxAttempts,
      error_message: job.errorMessage || null,
      error_code: job.errorCode || null,
      result,
      context: normalizeContext(job.payload?.context),
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
  const url = resolveWebhookUrl(job);
  if (!url) {
    return { ok: false, error: 'webhook_url_not_set', retryable: false, statusCode: null };
  }

  const payload = buildWebhookPayload(job);
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sessionQueue.webhookTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-MetaSession-Signature': signature } : {}),
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
    sessionStore.markSessionFlowWebhookDelivered(job.id);
    console.log(`[SessionFlowQueue] webhook delivered job=${job.id} status=${job.status}`);
    return;
  }

  if (webhookResult.retryable === false) {
    sessionStore.markSessionFlowWebhookStopped(job.id, webhookResult.error);
    console.warn(
      `[SessionFlowQueue] webhook stopped job=${job.id} status=${job.status} error=${webhookResult.error}`
    );
    return;
  }

  const delay = backoffMs(
    Math.max(1, Number(job.webhookAttempts) || 1),
    config.sessionQueue.webhookRetryBaseMs,
    config.sessionQueue.webhookRetryMaxMs
  );
  sessionStore.markSessionFlowWebhookRetry(job.id, webhookResult.error, Date.now() + delay);
  console.warn(
    `[SessionFlowQueue] webhook retry job=${job.id} status=${job.status} in_ms=${delay} error=${webhookResult.error}`
  );
}

async function flushWebhookQueue(maxBatch) {
  const requireWebhookUrl = !webhookEnabled();
  if (!sessionStore.hasPendingSessionFlowWebhook(Date.now(), requireWebhookUrl)) {
    return 0;
  }

  let delivered = 0;
  for (let i = 0; i < maxBatch; i += 1) {
    const pending = sessionStore.claimPendingSessionFlowWebhook(Date.now(), requireWebhookUrl);
    if (!pending) break;
    await deliverWebhook(pending);
    delivered += 1;
  }
  return delivered;
}

export async function pumpSessionFlowQueue() {
  if (stopRequested) return;
  if (pumping) return;

  pumping = true;
  lastPumpStartedAt = Date.now();
  lastPumpError = null;
  try {
    const reconcileSummary = sessionStore.reconcileInvalidSessionFlowJobs({
      defaultValidateTimeoutMs: config.createQueue.validateTimeoutMs,
      defaultTwofaInputTimeoutMs: config.createQueue.validateTwofaInputTimeoutMs,
    });
    if (reconcileSummary.convertedPendingTarget > 0 || reconcileSummary.skippedPendingTarget > 0) {
      console.warn(
        `[SessionFlowQueue] reconciled invalid jobs converted_pending=${reconcileSummary.convertedPendingTarget} skipped_pending=${reconcileSummary.skippedPendingTarget}`
      );
    }
    sessionStore.requeueStaleProcessingSessionFlowJobs(config.sessionQueue.processingTimeoutMs);
    const jobs = [];
    const maxConcurrency = Math.max(
      1,
      Number(config.sessionQueue.concurrency) ||
        Number(config.sessionQueue.batchSize) ||
        1
    );
    while (!stopRequested && jobs.length < maxConcurrency) {
      const job = sessionStore.claimNextSessionFlowJob(Date.now());
      if (!job) break;
      jobs.push(job);
    }
    if (jobs.length > 0) {
      await Promise.all(jobs.map((job) => processJob(job)));
    }
    await flushWebhookQueue(maxConcurrency);
  } catch (error) {
    lastPumpError = error?.message || String(error);
    throw error;
  } finally {
    pumping = false;
    lastPumpFinishedAt = Date.now();
  }

  if (stopRequested) return;
  if (
    sessionStore.hasRunnableSessionFlowJob(Date.now()) ||
    sessionStore.hasPendingSessionFlowWebhook(Date.now(), !webhookEnabled())
  ) {
    schedulePump(0);
  } else {
    schedulePump(config.sessionQueue.pollIntervalMs);
  }
}

export function startSessionFlowQueueWorker() {
  if (workerStarted) return;
  workerStarted = true;
  stopRequested = false;
  console.log('[SessionFlowQueue] worker started');
  schedulePump(0);
}

export function stopSessionFlowQueueWorker() {
  stopRequested = true;
  clearWorkerTimer();
  console.log('[SessionFlowQueue] worker stopped');
}

export function getSessionFlowQueueWorkerStatus(now = Date.now()) {
  const counts = sessionStore.sessionFlowJobStatusCounts(now);
  const stalled = pumping &&
    !!lastPumpStartedAt &&
    now - lastPumpStartedAt > workerStallThresholdMs();

  return {
    workerStarted,
    stopRequested,
    pumping,
    stalled,
    pollIntervalMs: Math.max(1, Number(config.sessionQueue.pollIntervalMs) || 1),
    batchSize: Math.max(1, Number(config.sessionQueue.batchSize) || 1),
    concurrency: Math.max(1, Number(config.sessionQueue.concurrency) || Number(config.sessionQueue.batchSize) || 1),
    queuedCount: Number(counts.queued || 0),
    runnableCount: Number(counts.runnable || 0),
    processingCount: Number(counts.processing || 0),
    errorCount: Number(counts.error || 0),
    completedCount: Number(counts.completed || 0),
    oldestRunnableAgeMs: counts.oldestRunnableAgeMs,
    oldestProcessingAgeMs: counts.oldestProcessingAgeMs,
    lastPumpStartedAt,
    lastPumpFinishedAt,
    lastPumpAgeMs: lastPumpStartedAt ? Math.max(0, now - lastPumpStartedAt) : null,
    lastPumpError,
  };
}

export function serializeSessionFlowJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    requestId: job.requestId,
    type: job.jobType,
    priority: job.priority || 'normal',
    coalesceKey: job.coalesceKey || null,
    targetSessionId: job.targetSessionId || null,
    cUser: job.cUser || null,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorMessage: job.errorMessage || null,
    errorCode: job.errorCode || null,
    nextRetryAt: job.nextRetryAt || null,
    result: job.result || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    webhookNotified: job.webhookNotified === true,
    webhookAttempts: job.webhookAttempts || 0,
    webhookNextRetryAt: job.webhookNextRetryAt || null,
    webhookLastError: job.webhookLastError || null,
  };
}

export function enqueueSessionFlowJob({
  requestId = null,
  jobType,
  targetSessionId = null,
  cUser = null,
  payload = {},
  webhookUrl = null,
  maxAttempts = null,
  priority = null,
  coalesceKey = null,
}) {
  const normalizedRequestId = requestId ? String(requestId).trim() : null;
  if (normalizedRequestId) {
    const existing = sessionStore.getSessionFlowJobByRequestId(normalizedRequestId);
    if (existing) {
      return { job: existing, created: false };
    }
  }

  const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const normalizedJobType = String(jobType || '').trim();
  const normalizedTargetSessionId = targetSessionId ? String(targetSessionId).trim() : null;
  const normalizedCUser = cUser ? String(cUser).trim() : null;
  const normalizedPriority = inferPriority(normalizedJobType, normalizedPayload, priority);
  const normalizedCoalesceKey = String(coalesceKey || '').trim() ||
    inferCoalesceKey(normalizedJobType, normalizedTargetSessionId, normalizedCUser, normalizedPayload, normalizedPriority);

  if (normalizedCoalesceKey) {
    const existing = sessionStore.getActiveSessionFlowJobByCoalesceKey(normalizedCoalesceKey);
    if (existing) {
      if (existing.status === 'queued') {
        const updated = sessionStore.coalesceQueuedSessionFlowJob(existing.id, {
          requestId: normalizedRequestId,
          priority: normalizedPriority,
          targetSessionId: normalizedTargetSessionId,
          cUser: normalizedCUser,
          payload: normalizedPayload,
          webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
          maxAttempts: Math.max(1, Number(maxAttempts) || config.sessionQueue.maxAttempts),
        });
        schedulePump(0);
        return { job: updated || existing, created: false, coalesced: true };
      }
      return { job: existing, created: false, coalesced: true };
    }
  }

  const job = sessionStore.enqueueSessionFlowJob({
    id: uuidv4(),
    requestId: normalizedRequestId,
    jobType: normalizedJobType,
    priority: normalizedPriority,
    coalesceKey: normalizedCoalesceKey,
    targetSessionId: normalizedTargetSessionId,
    cUser: normalizedCUser,
    payload: normalizedPayload,
    webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
    maxAttempts: Math.max(1, Number(maxAttempts) || config.sessionQueue.maxAttempts),
  });
  schedulePump(0);
  return { job, created: true };
}

export function getSessionFlowJob(jobId) {
  return sessionStore.getSessionFlowJob(String(jobId || ''));
}
