/**
 * Message sending routes
 */

import express from 'express';
import {
  getAllSessionIds,
  getBrowserPoolStatus,
  getQueuedWorkSessionBlock,
  getSessionInfo,
  sendMessageForSession,
  restoreSessionFromStore,
} from '../services/sessionManager.js';
import { enqueueMessageJob, getMessageJob, getMessageQueueWorkerStatus } from '../services/messageQueue.js';
import { sessionStore } from '../services/sessionStore.js';
import {
  buildAutomationErrorBody,
  buildScreenshotDataUrl,
} from '../services/debugArtifacts.js';
import { normalizeRequestId } from '../services/automation.js';
import {
  InvalidInputError,
  SessionNotFoundError,
  AutomationError,
} from '../errors.js';
import { buildJsonErrorBody } from '../utils/apiErrors.js';

const router = express.Router();

function getAutomationErrorCode(error) {
  const message = String(error?.message || '').toLowerCase();
  const type = String(error?.details?.type || '').toLowerCase();
  if (type === 'account_restricted' || message.includes('account restricted')) return 'account_restricted';
  if (type === 'captcha_required' || message.includes('captcha checkpoint')) return 'captcha_required';
  if (type === 'need_new_cookies' || message.includes('need new cookies')) return 'need_new_cookies';
  return 'automation_error';
}

function toBoolean(value) {
  if (value === true) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    requestId: job.requestId,
    metaBlastMessageId: job.metaBlastMessageId || null,
    sessionId: job.sessionId,
    useReplyFlow: job.useReplyFlow === true,
    priority: job.priority || 'normal',
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorMessage: job.errorMessage,
    nextRetryAt: job.nextRetryAt || null,
    result: job.result || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    originalStatus: job.originalStatus || null,
    archivedAt: job.archivedAt || null,
    archiveReason: job.archiveReason || null,
    archiveSource: job.archiveSource || null,
    webhookNotified: job.webhookNotified === true,
    webhookAttempts: job.webhookAttempts || 0,
    webhookNextRetryAt: job.webhookNextRetryAt || null,
    webhookLastError: job.webhookLastError || null,
  };
}

function normalizeLimit(value, fallback = 100, max = 500) {
  const parsed = parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function safeString(value) {
  return String(value ?? '').replace(/[\uD800-\uDFFF]/g, '');
}

function previewString(value, maxCodePoints = 160) {
  return Array.from(safeString(value).replace(/\s+/g, ' ').trim())
    .slice(0, maxCodePoints)
    .join('');
}

function sendJson(res, payload) {
  return res
    .type('application/json')
    .send(`${JSON.stringify(payload)}\n`);
}

function buildSessionSummary(sessions) {
  return (Array.isArray(sessions) ? sessions : []).reduce((memo, session) => {
    const status = String(session?.status || '').trim().toLowerCase();
    memo.total += 1;
    if (session?.liveBrowser) memo.liveBrowser += 1;
    if (status === 'active') memo.active += 1;
    if (status === 'suspended') memo.suspended += 1;
    if (status === 'restricted') memo.restricted += 1;
    if (status === 'needs_manual_action') memo.needsManualAction += 1;
    return memo;
  }, {
    total: 0,
    liveBrowser: 0,
    active: 0,
    suspended: 0,
    restricted: 0,
    needsManualAction: 0,
  });
}

function decorateJobWithSession(job, sessionMap) {
  const row = serializeJob(job);
  const sessionId = row?.sessionId;
  const session = sessionId ? sessionMap.get(sessionId) || null : null;
  return {
    ...row,
    session: session ? {
      sessionId: session.sessionId,
      cUser: session.cUser || null,
      status: session.status || null,
      liveBrowser: session.liveBrowser === true,
      lastActivity: session.lastActivity || null,
    } : null,
    messagePreview: previewString(job?.message, 160),
  };
}

function buildMonitorSessionSnapshot(sessionId, loadedSession, storedSession) {
  const effectiveStatus = loadedSession?.status || storedSession?.status || null;
  return {
    sessionId,
    cUser: loadedSession?.cUser || storedSession?.cUser || null,
    status: effectiveStatus,
    liveBrowser: loadedSession?.liveBrowser === true,
    lastActivity: loadedSession?.lastActivity ?? storedSession?.lastActivity ?? null,
    suspendedAt: loadedSession?.suspendedAt ?? (effectiveStatus === 'suspended' ? storedSession?.updatedAt || null : null),
    manualAction: loadedSession?.manualAction || null,
    restricted: storedSession?.restricted === true || effectiveStatus === 'restricted',
    restrictionDetectedAt: storedSession?.restrictionDetectedAt || null,
    loaded: !!loadedSession,
    stored: !!storedSession,
  };
}

function buildQueueWarmupState(group, sessionSnapshot, remainingSlots) {
  if (!sessionSnapshot?.loaded && !sessionSnapshot?.stored) {
    return { eligible: false, reason: 'session_not_found' };
  }
  if (Number(group?.runnableQueuedCount || 0) <= 0) {
    return { eligible: false, reason: 'delayed_only' };
  }
  if (Number(group?.processingCount || 0) > 0) {
    return { eligible: false, reason: 'processing_in_progress' };
  }
  const queueBlock = getQueuedWorkSessionBlock(group?.sessionId);
  if (queueBlock) {
    return {
      eligible: false,
      reason: 'queue_cooldown',
      blockedUntil: queueBlock.blockedUntil,
      remainingMs: queueBlock.remainingMs,
      blockReason: queueBlock.reason,
    };
  }
  if (sessionSnapshot?.liveBrowser) {
    return { eligible: false, reason: 'already_live_browser' };
  }
  if (sessionSnapshot?.restricted) {
    return { eligible: false, reason: 'restricted' };
  }
  if (sessionSnapshot?.status === 'needs_manual_action') {
    return { eligible: false, reason: 'needs_manual_action' };
  }
  if (remainingSlots != null && remainingSlots <= 0) {
    return { eligible: false, reason: 'no_available_slots' };
  }
  return { eligible: true, reason: 'available_slot' };
}

function compactLoadedSession(session) {
  return {
    sessionId: session.sessionId,
    cUser: session.cUser || null,
    status: session.status || null,
    liveBrowser: session.liveBrowser === true,
    lastActivity: session.lastActivity || null,
    suspendedAt: session.suspendedAt || null,
    manualAction: session.manualAction || null,
  };
}

/**
 * GET /api/sessions/jobs/monitor
 * Get MetaBiz queue/session monitoring snapshot
 */
router.get('/jobs/monitor', async (req, res) => {
  const now = Date.now();
  const queuedLimit = normalizeLimit(req.query?.queuedLimit, 100, 200);
  const processingLimit = normalizeLimit(req.query?.processingLimit, 100, 200);
  const sessionLimit = normalizeLimit(req.query?.sessionLimit, 25, 100);
  const loadedLimit = normalizeLimit(req.query?.loadedLimit, 50, 200);

  const loadedSessions = getAllSessionIds().map((id) => getSessionInfo(id)).filter(Boolean);
  const loadedSessionMap = new Map(loadedSessions.map((session) => [session.sessionId, session]));
  const queueCounts = sessionStore.messageJobStatusCounts();
  const queuedJobs = sessionStore.listQueuedMessageJobs(queuedLimit);
  const processingJobs = sessionStore.listProcessingMessageJobs(processingLimit);
  const queueSessions = sessionStore.listMessageJobSessions(sessionLimit, now);
  const browserPool = getBrowserPoolStatus();
  const worker = getMessageQueueWorkerStatus(now);

  const processingSessionIds = [...new Set(processingJobs.map((job) => String(job.sessionId || '')).filter(Boolean))];
  const queuedSessionIds = [...new Set(queuedJobs.map((job) => String(job.sessionId || '')).filter(Boolean))];
  let remainingWarmupSlots = browserPool.availableSlots;
  const groupedSessions = queueSessions.map((group) => {
    const sessionId = String(group.sessionId || '').trim();
    const loadedSession = sessionId ? loadedSessionMap.get(sessionId) || null : null;
    const storedSession = sessionId ? sessionStore.getBySessionId(sessionId) : null;
    const session = buildMonitorSessionSnapshot(sessionId, loadedSession, storedSession);
    const warmup = buildQueueWarmupState(group, session, remainingWarmupSlots);
    if (warmup.eligible && remainingWarmupSlots != null) {
      remainingWarmupSlots = Math.max(0, remainingWarmupSlots - 1);
    }
    return {
      ...group,
      session,
      warmup,
    };
  });

  return sendJson(res, {
    ok: true,
    generatedAt: new Date().toISOString(),
    worker,
    queue: {
      counts: {
        queued: Number(queueCounts.queued || 0),
        processing: Number(queueCounts.processing || 0),
        sent: Number(queueCounts.sent || 0),
        error: Number(queueCounts.error || 0),
      },
      processingSessionCount: processingSessionIds.length,
      queuedSessionCount: queuedSessionIds.length,
      sessions: groupedSessions,
      processingJobs: processingJobs.map((job) => decorateJobWithSession(job, loadedSessionMap)),
      queuedJobs: queuedJobs.map((job) => decorateJobWithSession(job, loadedSessionMap)),
    },
    sessions: {
      summary: buildSessionSummary(loadedSessions),
      browserPool,
      loaded: loadedSessions.slice(0, loadedLimit).map(compactLoadedSession),
    },
  });
});

/**
 * GET /api/sessions/jobs/:jobId
 * Get async message job status
 */
router.get('/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = getMessageJob(jobId);
  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Job not found',
      errorCode: 'job_not_found',
    });
  }

  return res.json({
    ok: true,
    job: serializeJob(job),
  });
});

/**
 * POST /api/sessions/jobs/cancel
 * Cancel queued async message jobs by session or job IDs
 */
router.post('/jobs/cancel', async (req, res) => {
  const { sessionId, jobIds, reason, suppressWebhook } = req.body || {};
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedJobIds = Array.isArray(jobIds)
    ? jobIds.map((value) => String(value || '').trim()).filter((value) => value.length > 0)
    : [];

  if (!normalizedSessionId && normalizedJobIds.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'sessionId or jobIds is required',
      errorCode: 'cancel_filter_required',
    });
  }

  const summaryBefore = sessionStore.summarizeMessageJobs({
    sessionId: normalizedSessionId,
    jobIds: normalizedJobIds,
  });

  const canceled = sessionStore.cancelQueuedMessageJobs({
    sessionId: normalizedSessionId,
    jobIds: normalizedJobIds,
    errorMessage: String(reason || 'canceled'),
    result: {
      ok: false,
      error: String(reason || 'canceled'),
      errorCode: 'canceled',
      details: {
        sessionId: normalizedSessionId || null,
        requestedJobIds: normalizedJobIds,
      },
    },
    suppressWebhook: suppressWebhook !== false,
  });

  return res.json({
    ok: true,
    summary: {
      matched: summaryBefore.matched,
      canceled,
      claimed: summaryBefore.processing,
      queued: summaryBefore.queued,
    },
  });
});

/**
 * POST /api/sessions/:sessionId/send-message
 * Send a WhatsApp message
 */
router.post('/:sessionId/send-message', async (req, res, next) => {
  const { sessionId } = req.params;
  const { extension, phoneNumber, message, includeSuccessScreenshot, requestId, async } = req.body || {};
  const normalizedRequestId = normalizeRequestId(sessionId, requestId);
  const normalizedPriority = 'high';
  try {
    console.log(`[Routes] send-message request session=${sessionId}`);

    // Validate input
    if (!extension || !phoneNumber || !message) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: extension, phoneNumber, message',
      });
    }

    if (typeof extension !== 'string' || typeof phoneNumber !== 'string' || typeof message !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'All fields must be strings',
      });
    }

    const asyncMode = toBoolean(req.query?.async) || toBoolean(async);
    if (asyncMode) {
      const { job, created } = enqueueMessageJob({
        requestId: normalizedRequestId,
        sessionId,
        priority: normalizedPriority,
        extension,
        phoneNumber,
        message,
        useReplyFlow: true,
        includeSuccessScreenshot: includeSuccessScreenshot === true,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeJob(job),
      });
    }

    const result = await sendMessageForSession(sessionId, {
      extension,
      phoneNumber,
      message,
      useReplyFlow: true,
      includeSuccessScreenshot: includeSuccessScreenshot === true,
      requestId: normalizedRequestId,
      priority: normalizedPriority,
    });
    const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);

    res.json({
      ok: true,
      message: 'Message sent successfully',
      screenshot: result?.screenshot || null,
      screenshotFilename: result?.screenshot?.filename || null,
      screenshotDataUrl,
      requestId: result?.requestId || normalizedRequestId,
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      try {
        await restoreSessionFromStore(sessionId);
        const result = await sendMessageForSession(sessionId, {
          extension,
          phoneNumber,
          message,
          useReplyFlow: true,
          includeSuccessScreenshot: includeSuccessScreenshot === true,
          requestId: normalizedRequestId,
          priority: normalizedPriority,
        });
        const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);
        return res.json({
          ok: true,
          message: 'Message sent successfully',
          screenshot: result?.screenshot || null,
          screenshotFilename: result?.screenshot?.filename || null,
          screenshotDataUrl,
          requestId: result?.requestId || normalizedRequestId,
        });
      } catch (restoreError) {
        if (restoreError instanceof InvalidInputError) {
          return res.status(400).json(
            buildJsonErrorBody(restoreError, 'Invalid input', {
              errorCode: 'invalid_input',
            })
          );
        }
        if (restoreError instanceof AutomationError) {
          return res.status(500).json(await buildAutomationErrorBody(restoreError, getAutomationErrorCode, normalizedRequestId));
        }
        if (restoreError instanceof SessionNotFoundError) {
          return res.status(404).json(
            buildJsonErrorBody(restoreError, 'Session not found', {
              errorCode: 'session_not_found',
              sessionId,
            })
          );
        }
        throw restoreError;
      }
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json(
        buildJsonErrorBody(error, 'Invalid input', {
          errorCode: 'invalid_input',
        })
      );
    }
    if (error instanceof AutomationError) {
      return res.status(500).json(await buildAutomationErrorBody(error, getAutomationErrorCode, normalizedRequestId));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:sessionId/send-message-blast
 * Send a WhatsApp message without reply-flow optimization
 */
router.post('/:sessionId/send-message-blast', async (req, res, next) => {
  const { sessionId } = req.params;
  const { extension, phoneNumber, message, includeSuccessScreenshot, requestId, metaBlastMessageId, async } = req.body || {};
  const normalizedRequestId = normalizeRequestId(sessionId, requestId);
  const normalizedPriority = 'normal';
  try {
    console.log(`[Routes] send-message-blast request session=${sessionId}`);

    if (!extension || !phoneNumber || !message) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: extension, phoneNumber, message',
      });
    }

    if (typeof extension !== 'string' || typeof phoneNumber !== 'string' || typeof message !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'All fields must be strings',
      });
    }

    const asyncMode = toBoolean(req.query?.async) || toBoolean(async);
    if (asyncMode) {
      const { job, created } = enqueueMessageJob({
        requestId: normalizedRequestId,
        metaBlastMessageId,
        sessionId,
        priority: normalizedPriority,
        extension,
        phoneNumber,
        message,
        useReplyFlow: false,
        includeSuccessScreenshot: includeSuccessScreenshot === true,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeJob(job),
      });
    }

    const result = await sendMessageForSession(sessionId, {
      extension,
      phoneNumber,
      message,
      useReplyFlow: false,
      includeSuccessScreenshot: includeSuccessScreenshot === true,
      requestId: normalizedRequestId,
      priority: normalizedPriority,
    });
    const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);

    res.json({
      ok: true,
      message: 'Message sent successfully',
      screenshot: result?.screenshot || null,
      screenshotFilename: result?.screenshot?.filename || null,
      screenshotDataUrl,
      requestId: result?.requestId || normalizedRequestId,
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      try {
        await restoreSessionFromStore(sessionId);
        const result = await sendMessageForSession(sessionId, {
          extension,
          phoneNumber,
          message,
          useReplyFlow: false,
          includeSuccessScreenshot: includeSuccessScreenshot === true,
          requestId: normalizedRequestId,
          priority: normalizedPriority,
        });
        const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);
        return res.json({
          ok: true,
          message: 'Message sent successfully',
          screenshot: result?.screenshot || null,
          screenshotFilename: result?.screenshot?.filename || null,
          screenshotDataUrl,
          requestId: result?.requestId || normalizedRequestId,
        });
      } catch (restoreError) {
        if (restoreError instanceof InvalidInputError) {
          return res.status(400).json(
            buildJsonErrorBody(restoreError, 'Invalid input', {
              errorCode: 'invalid_input',
            })
          );
        }
        if (restoreError instanceof AutomationError) {
          return res.status(500).json(await buildAutomationErrorBody(restoreError, getAutomationErrorCode, normalizedRequestId));
        }
        if (restoreError instanceof SessionNotFoundError) {
          return res.status(404).json(
            buildJsonErrorBody(restoreError, 'Session not found', {
              errorCode: 'session_not_found',
              sessionId,
            })
          );
        }
        throw restoreError;
      }
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json(
        buildJsonErrorBody(error, 'Invalid input', {
          errorCode: 'invalid_input',
        })
      );
    }
    if (error instanceof AutomationError) {
      return res.status(500).json(await buildAutomationErrorBody(error, getAutomationErrorCode, normalizedRequestId));
    }
    next(error);
  }
});

export default router;
