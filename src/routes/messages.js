/**
 * Message sending routes
 */

import express from 'express';
import { sendMessageForSession, restoreSessionFromStore } from '../services/sessionManager.js';
import { enqueueMessageJob, getMessageJob } from '../services/messageQueue.js';
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

const router = express.Router();

function getAutomationErrorCode(error) {
  const message = String(error?.message || '').toLowerCase();
  const type = String(error?.details?.type || '').toLowerCase();
  if (message.includes('account restricted')) return 'account_restricted';
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
    webhookNotified: job.webhookNotified === true,
    webhookAttempts: job.webhookAttempts || 0,
    webhookNextRetryAt: job.webhookNextRetryAt || null,
    webhookLastError: job.webhookLastError || null,
  };
}

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
 * POST /api/sessions/:sessionId/send-message
 * Send a WhatsApp message
 */
router.post('/:sessionId/send-message', async (req, res, next) => {
  const { sessionId } = req.params;
  const { extension, phoneNumber, message, includeSuccessScreenshot, requestId } = req.body || {};
  const normalizedRequestId = normalizeRequestId(sessionId, requestId);
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

    const result = await sendMessageForSession(sessionId, {
      extension,
      phoneNumber,
      message,
      useReplyFlow: true,
      includeSuccessScreenshot: includeSuccessScreenshot === true,
      requestId: normalizedRequestId,
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
          includeSuccessScreenshot: includeSuccessScreenshot === true,
          requestId: normalizedRequestId,
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
          return res.status(400).json({
            ok: false,
            error: restoreError.message,
            errorCode: 'invalid_input',
          });
        }
        if (restoreError instanceof AutomationError) {
          return res.status(500).json(await buildAutomationErrorBody(restoreError, getAutomationErrorCode, normalizedRequestId));
        }
        if (restoreError instanceof SessionNotFoundError) {
          return res.status(404).json({
            ok: false,
            error: restoreError.message,
            errorCode: 'session_not_found',
            sessionId,
          });
        }
        throw restoreError;
      }
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json({
        ok: false,
        error: error.message,
        errorCode: 'invalid_input',
      });
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
          return res.status(400).json({
            ok: false,
            error: restoreError.message,
            errorCode: 'invalid_input',
          });
        }
        if (restoreError instanceof AutomationError) {
          return res.status(500).json(await buildAutomationErrorBody(restoreError, getAutomationErrorCode, normalizedRequestId));
        }
        if (restoreError instanceof SessionNotFoundError) {
          return res.status(404).json({
            ok: false,
            error: restoreError.message,
            errorCode: 'session_not_found',
            sessionId,
          });
        }
        throw restoreError;
      }
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json({
        ok: false,
        error: error.message,
        errorCode: 'invalid_input',
      });
    }
    if (error instanceof AutomationError) {
      return res.status(500).json(await buildAutomationErrorBody(error, getAutomationErrorCode, normalizedRequestId));
    }
    next(error);
  }
});

export default router;
