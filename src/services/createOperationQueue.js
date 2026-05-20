/**
 * Dedicated queue worker for Meta create-preflight operations.
 */

import { v4 as uuidv4 } from 'uuid';
import { sessionStore } from './sessionStore.js';
import { validateCookies, validateProxy, checkSessionForSession, destroySession } from './sessionManager.js';
import { config } from '../config.js';
import {
  AutomationError,
  BrowserCrashError,
  FlowTimeoutError,
  InvalidInputError,
  SessionNotFoundError,
} from '../errors.js';

let workerStarted = false;
let stopRequested = false;
let pumping = false;
let timerRef = null;
const activeOperations = new Map();
let lastPumpStartedAt = null;
let lastPumpFinishedAt = null;
let lastPumpError = null;

function clearWorkerTimer() {
  if (!timerRef) return;
  clearTimeout(timerRef);
  timerRef = null;
}

function schedulePump(delayMs = 0) {
  if (stopRequested) return;
  clearWorkerTimer();
  timerRef = setTimeout(() => {
    pumpCreateOperationQueue().catch((error) => {
      console.error('[CreateOperationQueue] Pump failed:', error?.message || String(error));
      if (!stopRequested) {
        schedulePump(config.createQueue.pollIntervalMs);
      }
    });
  }, Math.max(0, Number(delayMs) || 0));
}

function workerStallThresholdMs() {
  return Math.max(
    Number(config.createQueue.processingTimeoutMs) || 0,
    (Number(config.createQueue.pollIntervalMs) || 0) * 4,
    30000
  );
}

function pruneStaleActiveOperations(now = Date.now()) {
  const thresholdMs = workerStallThresholdMs();
  for (const [task, meta] of activeOperations.entries()) {
    const ageMs = meta?.startedAt ? Math.max(0, now - meta.startedAt) : null;
    if (ageMs == null || ageMs <= thresholdMs) {
      continue;
    }
    activeOperations.delete(task);
    console.warn(
      `[CreateOperationQueue] detached stale active slot operation=${meta?.id || 'unknown'} age_ms=${ageMs}`
    );
  }
}

function getCreateQueueConcurrency() {
  const configuredConcurrency = Math.max(1, Number(config.createQueue?.concurrency) || 1);
  const configuredBatchSize = Math.max(1, Number(config.createQueue?.batchSize) || 1);
  const configured = Math.max(configuredConcurrency, configuredBatchSize);
  const maxConcurrency = Math.max(1, Number(config.createQueue?.maxConcurrency) || 1);
  return Math.min(configured, maxConcurrency);
}

function resolveCreateFlowTimeoutMs(requestedTimeoutMs = null) {
  const configuredTimeoutMs = Math.max(1, Number(config.createQueue?.flowTimeoutMs) || config.flowTimeoutMs);
  const requested = Number(requestedTimeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) {
    return configuredTimeoutMs;
  }
  return Math.min(requested, configuredTimeoutMs);
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

  if (error instanceof InvalidInputError) return 'invalid_input';
  if (error instanceof SessionNotFoundError) return 'session_not_found';
  if (error instanceof FlowTimeoutError) return 'flow_timeout';
  if (error instanceof BrowserCrashError) return 'browser_crash';
  if (error instanceof AutomationError) return 'automation_error';

  const lowered = String(message || '').toLowerCase();
  if (lowered.includes('account restricted')) return 'account_restricted';
  if (lowered.includes('captcha')) return 'captcha_required';
  if (lowered.includes('need new cookies')) return 'need_new_cookies';
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

function isRetryableCreateError(errorResult) {
  const code = String(errorResult?.errorCode || '').toLowerCase();
  return ![
    'invalid_input',
    'need_new_cookies',
    'captcha_required',
    'account_restricted',
    'session_not_found',
    'flow_timeout',
  ].includes(code);
}

function serializeCreateOperation(operation) {
  if (!operation) return null;
  return {
    id: operation.id,
    requestId: operation.requestId || null,
    cUser: operation.cUser || null,
    status: operation.status,
    step: operation.step || null,
    message: operation.message || null,
    attempts: operation.attempts,
    maxAttempts: operation.maxAttempts,
    errorMessage: operation.errorMessage || null,
    errorCode: operation.errorCode || null,
    nextRetryAt: operation.nextRetryAt || 0,
    result: operation.result || null,
    debug: operation.debug || null,
    startedAt: operation.startedAt || null,
    finishedAt: operation.finishedAt || null,
    createdAt: operation.createdAt || null,
    updatedAt: operation.updatedAt || null,
  };
}

async function executeOperation(operation) {
  const payload = operation.payload || {};
  const flowTimeoutMs = resolveCreateFlowTimeoutMs(payload.flowTimeoutMs);
  const recoverableRetryAttempts =
    Number.isFinite(Number(payload.recoverableRetryAttempts)) && Number(payload.recoverableRetryAttempts) >= 0
      ? Number(payload.recoverableRetryAttempts)
      : null;
  const partialResult = {};
  let createdSessionId = null;

  try {
    if (payload.proxy && payload.validateProxyFirst !== false) {
      sessionStore.markCreateOperationProgress(operation.id, 'create.proxy_validate', 'Validating proxy.');
      await validateProxy(payload.proxy, { browserPoolLane: 'create' });
    }

    sessionStore.markCreateOperationProgress(operation.id, 'create.validate_cookies', 'Validating cookies.');
    const validationResult = await validateCookies(payload.cookies, payload.proxy || null, {
      persist: true,
      freshBrowser: true,
      twofaSecret: payload.twofaSecret || null,
      skipProxyValidation: payload.proxy && payload.validateProxyFirst !== false,
      navigationRetries: 0,
      browserPoolLane: 'create',
    });
    partialResult.validation = validationResult;
    createdSessionId = validationResult?.sessionId ? String(validationResult.sessionId) : null;

    if (!validationResult?.sessionId) {
      throw new InvalidInputError('Meta create operation did not return session ID');
    }

    sessionStore.markCreateOperationProgress(
      operation.id,
      'create.check_session',
      'Checking session flow.',
      {
        sessionId: validationResult.sessionId,
        cUser: validationResult.cUser || null,
      }
    );

    const checkResult = await checkSessionForSession(validationResult.sessionId, {
      requestId: payload.requestId || operation.requestId || null,
      flowTimeoutMs,
      recoverableRetryAttempts,
      flowMaxAttempts: 1,
      priority: 'high',
      browserPoolOptions: { lane: 'create' },
    });
    partialResult.check = checkResult;

    return {
      ok: true,
      sessionId: validationResult.sessionId,
      cUser: validationResult.cUser || null,
      fingerprint: validationResult.fingerprint || null,
      validation: validationResult,
      check: checkResult || {},
    };
  } catch (error) {
    if (createdSessionId) {
      try {
        await destroySession(createdSessionId);
      } catch (cleanupError) {
        console.warn(
          `[CreateOperationQueue] cleanup failed session=${createdSessionId} error=${cleanupError?.message || String(cleanupError)}`
        );
      }
    }
    throw error;
  }
}

async function processOperation(operation) {
  try {
    const result = await executeOperation(operation);
    const updated = sessionStore.markCreateOperationCompleted(
      operation.id,
      result,
      'Meta create preflight completed.'
    );
    if (updated?.status !== 'completed') {
      console.warn(
        `[CreateOperationQueue] completion ignored id=${operation.id} current_status=${updated?.status || 'missing'}`
      );
      return;
    }
    console.log(`[CreateOperationQueue] completed id=${operation.id} attempts=${operation.attempts}`);
    return;
  } catch (error) {
    const partialResult = error?.partialResult || null;
    const errorResult = buildErrorResult(error, partialResult);
    const message = errorResult.error;
    const maxAttempts = Math.max(1, Number(operation.maxAttempts) || config.createQueue.maxAttempts);
    const attempts = Math.max(1, Number(operation.attempts) || 1);
    const retryable = isRetryableCreateError(errorResult);

    if (!retryable || attempts >= maxAttempts) {
      const updated = sessionStore.markCreateOperationError(
        operation.id,
        message,
        errorResult.errorCode,
        errorResult,
        errorResult.result
      );
      if (updated?.status !== 'error') {
        console.warn(
          `[CreateOperationQueue] error ignored id=${operation.id} current_status=${updated?.status || 'missing'}`
        );
        return;
      }
      console.warn(
        `[CreateOperationQueue] failed id=${operation.id} attempts=${attempts}/${maxAttempts} retryable=${retryable}`
      );
      return;
    }

    const retryDelay = backoffMs(attempts, config.createQueue.retryBaseMs, config.createQueue.retryMaxMs);
    const retryAt = Date.now() + retryDelay;
    const updated = sessionStore.markCreateOperationRetry(
      operation.id,
      message,
      errorResult.errorCode,
      retryAt,
      errorResult,
      errorResult.result
    );
    if (updated?.status !== 'queued') {
      console.warn(
        `[CreateOperationQueue] retry ignored id=${operation.id} current_status=${updated?.status || 'missing'}`
      );
      return;
    }
    console.warn(
      `[CreateOperationQueue] retry id=${operation.id} attempts=${attempts}/${maxAttempts} retry_in_ms=${retryDelay}`
    );
  }
}

export async function pumpCreateOperationQueue() {
  if (stopRequested) return;
  if (pumping) return;

  pruneStaleActiveOperations();
  pumping = true;
  lastPumpStartedAt = Date.now();
  lastPumpError = null;
  try {
    sessionStore.requeueStaleProcessingCreateOperations(config.createQueue.processingTimeoutMs);
    let claimed = 0;
    const maxBatch = Math.max(1, Number(config.createQueue.batchSize) || 1);
    const maxConcurrency = getCreateQueueConcurrency();
    const availableSlots = Math.max(0, maxConcurrency - activeOperations.size);
    const claimLimit = Math.min(maxBatch, availableSlots);

    while (!stopRequested && claimed < claimLimit) {
      const operation = sessionStore.claimNextCreateOperation(Date.now());
      if (!operation) break;
      const task = processOperation(operation)
        .catch((error) => {
          console.error(
            `[CreateOperationQueue] unhandled process error id=${operation?.id || 'unknown'} error=${error?.message || String(error)}`
          );
        })
        .finally(() => {
          activeOperations.delete(task);
          if (!stopRequested) {
            schedulePump(0);
          }
        });
      activeOperations.set(task, {
        id: operation.id,
        startedAt: Date.now(),
      });
      claimed += 1;
    }
  } catch (error) {
    lastPumpError = error?.message || String(error);
    throw error;
  } finally {
    pumping = false;
    lastPumpFinishedAt = Date.now();
  }

  if (stopRequested) return;
  if (activeOperations.size >= getCreateQueueConcurrency()) {
    return;
  }
  if (sessionStore.hasRunnableCreateOperation(Date.now())) {
    schedulePump(0);
  } else {
    schedulePump(config.createQueue.pollIntervalMs);
  }
}

export function startCreateOperationQueueWorker() {
  if (workerStarted) return;
  workerStarted = true;
  stopRequested = false;
  console.log('[CreateOperationQueue] worker started');
  schedulePump(0);
}

export function stopCreateOperationQueueWorker() {
  stopRequested = true;
  clearWorkerTimer();
  console.log('[CreateOperationQueue] worker stopped');
}

export function getCreateOperationQueueWorkerStatus(now = Date.now()) {
  pruneStaleActiveOperations(now);
  let oldestActiveAgeMs = null;
  for (const meta of activeOperations.values()) {
    const ageMs = meta?.startedAt ? Math.max(0, now - meta.startedAt) : null;
    if (ageMs == null) continue;
    if (oldestActiveAgeMs == null || ageMs > oldestActiveAgeMs) {
      oldestActiveAgeMs = ageMs;
    }
  }

  const stalled = (
    (pumping && !!lastPumpStartedAt && now - lastPumpStartedAt > workerStallThresholdMs()) ||
    (oldestActiveAgeMs != null && oldestActiveAgeMs > workerStallThresholdMs())
  );

  return {
    workerStarted,
    stopRequested,
    pumping,
    stalled,
    activeOperations: activeOperations.size,
    pollIntervalMs: Math.max(1, Number(config.createQueue.pollIntervalMs) || 1),
    batchSize: Math.max(1, Number(config.createQueue.batchSize) || 1),
    configuredConcurrency: Math.max(1, Number(config.createQueue?.concurrency) || 1),
    maxConcurrency: Math.max(1, Number(config.createQueue?.maxConcurrency) || 1),
    concurrency: getCreateQueueConcurrency(),
    flowTimeoutMs: resolveCreateFlowTimeoutMs(),
    oldestActiveAgeMs,
    lastPumpStartedAt,
    lastPumpFinishedAt,
    lastPumpAgeMs: lastPumpStartedAt ? Math.max(0, now - lastPumpStartedAt) : null,
    lastPumpError,
  };
}

export function enqueueCreateOperation({
  requestId = null,
  cUser = null,
  payload = {},
  maxAttempts = null,
}) {
  const normalizedRequestId = requestId ? String(requestId).trim() : null;
  if (normalizedRequestId) {
    const existing = sessionStore.getCreateOperationByRequestId(normalizedRequestId);
    if (existing) {
      return { operation: existing, created: false };
    }
  }

  const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const operation = sessionStore.enqueueCreateOperation({
    id: uuidv4(),
    requestId: normalizedRequestId,
    cUser: cUser ? String(cUser).trim() : null,
    payload: normalizedPayload,
    maxAttempts: Math.max(1, Number(maxAttempts) || config.createQueue.maxAttempts),
  });
  schedulePump(0);
  return { operation, created: true };
}

export function getCreateOperation(operationId) {
  return sessionStore.getCreateOperation(String(operationId || ''));
}

export function getCreateOperationByRequestId(requestId) {
  return sessionStore.getCreateOperationByRequestId(String(requestId || ''));
}

export function serializeCreateOperationResponse(operation) {
  return serializeCreateOperation(operation);
}
