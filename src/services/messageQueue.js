/**
 * Persistent message queue worker backed by sessionStore (SQLite).
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sessionStore } from './sessionStore.js';
import { sendMessageForSession } from './sessionManager.js';
import { config } from '../config.js';

let workerStarted = false;
let stopRequested = false;
let pumping = false;
let timerRef = null;

function webhookEnabled() {
  return String(config.queue.webhookUrl || '').trim().length > 0;
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

  return {
    ok: false,
    error: message,
    errorCode: error?.errorCode ? String(error.errorCode) : null,
    name: error?.name ? String(error.name) : null,
    details,
  };
}

async function processJob(job) {
  try {
    const result = await sendMessageForSession(job.sessionId, {
      extension: job.extension,
      phoneNumber: job.phoneNumber,
      message: job.message,
      useReplyFlow: job.useReplyFlow,
      includeSuccessScreenshot: job.includeSuccessScreenshot,
    });
    sessionStore.markMessageJobSent(job.id, result || {});
    console.log(`[MessageQueue] job sent id=${job.id} attempts=${job.attempts}`);
    return;
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    const maxAttempts = Math.max(1, Number(job.maxAttempts) || config.queue.maxAttempts);
    const attempts = Math.max(1, Number(job.attempts) || 1);
    if (attempts >= maxAttempts) {
      sessionStore.markMessageJobError(job.id, message, buildErrorResult(error, message));
      console.warn(`[MessageQueue] job failed id=${job.id} attempts=${attempts}/${maxAttempts}`);
      return;
    }

    const retryDelay = backoffMs(attempts, config.queue.retryBaseMs, config.queue.retryMaxMs);
    const retryAt = Date.now() + retryDelay;
    sessionStore.markMessageJobRetry(job.id, message, retryAt);
    console.warn(`[MessageQueue] job retry id=${job.id} attempts=${attempts}/${maxAttempts} retry_in_ms=${retryDelay}`);
  }
}

function buildWebhookPayload(job) {
  return {
    source: 'metabiz-whatsapp-headless',
    event: `meta_blast_message.${job.status}`,
    occurred_at: new Date().toISOString(),
    job: {
      id: job.id,
      request_id: job.requestId || null,
      meta_blast_message_id: job.metaBlastMessageId || null,
      session_id: job.sessionId,
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

async function postWebhook(job) {
  const url = config.queue.webhookUrl;
  if (!url) {
    return { ok: false, error: 'webhook_url_not_set', retryable: false };
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
      return { ok: false, error: `HTTP ${response.status} ${text}`.trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
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

export async function pumpQueue() {
  if (stopRequested) return;
  if (pumping) return;

  pumping = true;
  try {
    sessionStore.requeueStaleProcessingMessageJobs(config.queue.processingTimeoutMs);
    let processed = 0;
    const maxBatch = Math.max(1, Number(config.queue.batchSize) || 1);
    const batchPromises = [];
    while (!stopRequested && processed < maxBatch) {
      const job = sessionStore.claimNextMessageJob(Date.now());
      if (!job) break;
      batchPromises.push(processJob(job));
      processed += 1;
    }
    if (batchPromises.length > 0) {
      await Promise.allSettled(batchPromises);
    }
    await flushWebhookQueue(maxBatch);
  } finally {
    pumping = false;
  }

  if (stopRequested) return;
  if (
    sessionStore.hasRunnableMessageJob(Date.now()) ||
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

export function enqueueMessageJob({
  requestId = null,
  metaBlastMessageId = null,
  sessionId,
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
