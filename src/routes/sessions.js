/**
 * Session management routes
 */

import express from 'express';
import fs from 'fs/promises';
import {
  createSession,
  destroySession,
  getAllSessionIds,
  getSessionInfo,
  checkSessionForSession,
  updateSessionCookies,
  updateSessionProxy,
  cleanupSessions,
  clearAllSessions,
  getSessionCaptchaImageInfo,
} from '../services/sessionManager.js';
import { buildAutomationErrorBody, enrichAutomationDetails } from '../services/debugArtifacts.js';
import { normalizeRequestId } from '../services/automation.js';
import { enqueueSessionFlowJob, serializeSessionFlowJob } from '../services/sessionFlowQueue.js';
import { InvalidInputError, SessionNotFoundError, AutomationError } from '../errors.js';
import { buildJsonErrorBody } from '../utils/apiErrors.js';

function getAutomationErrorCode(error) {
  const message = String(error?.message || '').toLowerCase();
  const type = String(error?.details?.type || '').toLowerCase();
  if (type === 'account_restricted' || message.includes('account restricted')) return 'account_restricted';
  if (type === 'captcha_required' || message.includes('captcha checkpoint')) return 'captcha_required';
  if (type === 'need_new_cookies' || message.includes('need new cookies')) return 'need_new_cookies';
  return 'automation_error';
}

const router = express.Router();

function toBoolean(value) {
  if (value === true) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

async function buildInvalidInputErrorBody(error, fallbackRequestId = null) {
  const details = await enrichAutomationDetails(error?.details, fallbackRequestId);
  return buildJsonErrorBody(error, 'Invalid input', {
    errorCode: 'invalid_input',
    ...(details ? { details } : {}),
  });
}

/**
 * GET /api/sessions
 * List all active sessions
 */
router.get('/', async (req, res, next) => {
  try {
    const sessionIds = getAllSessionIds();
    const sessions = sessionIds.map((id) => getSessionInfo(id)).filter(Boolean);

    res.json({
      ok: true,
      sessions,
      count: sessions.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/sessions/:sessionId
 * Get session details
 */
router.get('/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const session = getSessionInfo(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    res.json({
      ok: true,
      ...session,
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json(buildJsonErrorBody(error, 'Session not found'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:sessionId/captcha-image
 * Return latest captcha crop image for the session
 */
router.get('/:sessionId/captcha-image', async (req, res, next) => {
  const { sessionId } = req.params;
  try {
    const session = getSessionInfo(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    const image = getSessionCaptchaImageInfo(sessionId);
    if (!image?.path) {
      return res.status(404).json({
        ok: false,
        error: 'Captcha image not found',
        errorCode: 'captcha_image_not_found',
        sessionId,
      });
    }

    await fs.access(image.path);
    res.setHeader('x-session-id', sessionId);
    res.setHeader('x-session-status', image.status || session.status || 'needs_manual_action');
    return res.sendFile(image.path);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json(
        buildJsonErrorBody(error, 'Session not found', {
          errorCode: 'session_not_found',
          sessionId,
        })
      );
    }
    if (String(error?.code || '') === 'ENOENT') {
      return res.status(404).json({
        ok: false,
        error: 'Captcha image file not found',
        errorCode: 'captcha_image_not_found',
        sessionId,
      });
    }
    next(error);
  }
});

/**
 * POST /api/sessions
 * Create a new session
 */
router.post('/', async (req, res, next) => {
  let normalizedRequestId = null;
  try {
    const { cookies, proxy, twofaSecret, async, requestId, context, webhookUrl } = req.body || {};

    const cookiesIsString = typeof cookies === 'string';
    const cookiesIsArray = Array.isArray(cookies);
    if (!cookies || (!cookiesIsString && !cookiesIsArray)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid cookies format. Expected a string or array.',
      });
    }

    // Validate proxy if provided
    let proxyConfig = null;
    if (proxy) {
      if (typeof proxy !== 'object' || !proxy.server) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid proxy format. Expected {server: string, username?: string, password?: string}.',
        });
      }
      proxyConfig = {
        server: proxy.server,
        username: proxy.username || undefined,
        password: proxy.password || undefined,
      };
      console.log(
        `[Routes] createSession proxy config: ${proxyConfig.server} (auth: ${proxyConfig.username ? 'yes' : 'no'})`
      );
    }

    const asyncMode = toBoolean(req.query?.async) || toBoolean(async);
    normalizedRequestId = normalizeRequestId('create-session', requestId);
    if (asyncMode) {
      const { job, created } = enqueueSessionFlowJob({
        requestId: normalizedRequestId,
        jobType: 'create_session',
        payload: {
          cookies,
          proxy: proxyConfig,
          twofaSecret,
          context: context && typeof context === 'object' && !Array.isArray(context) ? context : null,
        },
        webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeSessionFlowJob(job),
      });
    }

    const result = await createSession(cookies, null, null, proxyConfig, { twofaSecret });

    res.status(201).json({
      sessionId: result.sessionId,
      ipAddress: result.ipAddress,
      status: 'active',
      cUser: result.cUser || null,
      fingerprint: result.fingerprint || null,
    });
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return res.status(400).json(await buildInvalidInputErrorBody(error, normalizedRequestId));
    }
    if (error instanceof AutomationError) {
      return res.status(500).json(await buildAutomationErrorBody(error, getAutomationErrorCode));
    }
    next(error);
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * Destroy a session
 */
router.delete('/:sessionId', async (req, res, next) => {
  const { sessionId } = req.params;
  const requestId = normalizeRequestId(sessionId, req.body?.requestId || req.query?.requestId);
  try {
    const asyncMode = toBoolean(req.query?.async) || toBoolean(req.body?.async);
    if (asyncMode) {
      const { job, created } = enqueueSessionFlowJob({
        requestId,
        jobType: 'destroy_session',
        targetSessionId: sessionId,
        payload: {
          context: req.body?.context && typeof req.body.context === 'object' && !Array.isArray(req.body.context)
            ? req.body.context
            : null,
        },
        webhookUrl: req.body?.webhookUrl ? String(req.body.webhookUrl).trim() : null,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeSessionFlowJob(job),
      });
    }

    await destroySession(sessionId);

    res.json({
      ok: true,
      message: 'Session destroyed',
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json(
        buildJsonErrorBody(error, 'Session not found', {
          errorCode: 'session_not_found',
          sessionId,
        })
      );
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:sessionId/check
 * Validate session can run WhatsApp flow (no message sent)
 */
router.post('/:sessionId/check', async (req, res, next) => {
  const { sessionId } = req.params;
  const requestId = normalizeRequestId(sessionId, req.body?.requestId);
  try {
    const asyncMode = toBoolean(req.query?.async) || toBoolean(req.body?.async);
    if (asyncMode) {
      const { job, created } = enqueueSessionFlowJob({
        requestId,
        jobType: 'check_session',
        targetSessionId: sessionId,
        payload: {
          context: req.body?.context && typeof req.body.context === 'object' && !Array.isArray(req.body.context)
            ? req.body.context
            : null,
        },
        webhookUrl: req.body?.webhookUrl ? String(req.body.webhookUrl).trim() : null,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeSessionFlowJob(job),
      });
    }

    const result = await checkSessionForSession(sessionId, {
      requestId,
      flowTimeoutMs: req.body?.flowTimeoutMs,
      recoverableRetryAttempts: req.body?.recoverableRetryAttempts,
    });
    res.json({
      ok: true,
      message: 'Session check ok',
      requestId: result?.requestId || requestId,
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json(
        buildJsonErrorBody(error, 'Session not found', {
          errorCode: 'session_not_found',
          sessionId,
        })
      );
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json(await buildInvalidInputErrorBody(error, requestId));
    }
    if (error instanceof AutomationError) {
      return res.status(500).json(await buildAutomationErrorBody(error, getAutomationErrorCode, requestId));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:sessionId/resume-check
 * Re-run check flow after manual action on an existing browser session
 */
router.post('/:sessionId/resume-check', async (req, res, next) => {
  const { sessionId } = req.params;
  const requestId = normalizeRequestId(sessionId, req.body?.requestId);
  try {
    const asyncMode = toBoolean(req.query?.async) || toBoolean(req.body?.async);
    if (asyncMode) {
      const { job, created } = enqueueSessionFlowJob({
        requestId,
        jobType: 'resume_check',
        targetSessionId: sessionId,
        payload: {
          context: req.body?.context && typeof req.body.context === 'object' && !Array.isArray(req.body.context)
            ? req.body.context
            : null,
        },
        webhookUrl: req.body?.webhookUrl ? String(req.body.webhookUrl).trim() : null,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeSessionFlowJob(job),
      });
    }

    const result = await checkSessionForSession(sessionId, {
      requestId,
      flowTimeoutMs: req.body?.flowTimeoutMs,
      recoverableRetryAttempts: req.body?.recoverableRetryAttempts,
    });
    const session = getSessionInfo(sessionId);
    res.json({
      ok: true,
      message: 'Session resumed and check ok',
      retried: result?.retried === true,
      requestId: result?.requestId || requestId,
      session,
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json(
        buildJsonErrorBody(error, 'Session not found', {
          errorCode: 'session_not_found',
          sessionId,
        })
      );
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json(await buildInvalidInputErrorBody(error, requestId));
    }
    if (error instanceof AutomationError) {
      return res.status(500).json(await buildAutomationErrorBody(error, getAutomationErrorCode, requestId));
    }
    next(error);
  }
});

/**
 * PUT /api/sessions/:sessionId/cookies
 * Update cookies for an existing session
 */
router.put('/:sessionId/cookies', async (req, res, next) => {
  const { sessionId } = req.params;
  try {
    const {
      cookies,
      twofaSecret,
      proxy,
      async,
      requestId,
      context,
      webhookUrl,
      fallbackCreateOnNotFound,
    } = req.body || {};
    const cookiesIsString = typeof cookies === 'string';
    const cookiesIsArray = Array.isArray(cookies);
    if (!cookies || (!cookiesIsString && !cookiesIsArray)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid cookies format. Expected a string or array.',
      });
    }

    let proxyConfig = null;
    if (proxy) {
      if (typeof proxy !== 'object' || !proxy.server) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid proxy format. Expected {server: string, username?: string, password?: string}.',
        });
      }
      proxyConfig = {
        server: proxy.server,
        username: proxy.username || undefined,
        password: proxy.password || undefined,
      };
    }

    const asyncMode = toBoolean(req.query?.async) || toBoolean(async);
    const normalizedRequestId = normalizeRequestId(sessionId, requestId);
    if (asyncMode) {
      const { job, created } = enqueueSessionFlowJob({
        requestId: normalizedRequestId,
        jobType: 'update_session_cookies',
        targetSessionId: sessionId,
        payload: {
          cookies,
          twofaSecret,
          proxy: proxyConfig,
          fallbackCreateOnNotFound: toBoolean(fallbackCreateOnNotFound),
          context: context && typeof context === 'object' && !Array.isArray(context) ? context : null,
        },
        webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeSessionFlowJob(job),
      });
    }

    await updateSessionCookies(sessionId, cookies, { twofaSecret, proxy: proxyConfig });
    res.json({
      ok: true,
      message: 'Cookies updated',
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json(
        buildJsonErrorBody(error, 'Session not found', {
          errorCode: 'session_not_found',
          sessionId,
        })
      );
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json(await buildInvalidInputErrorBody(error));
    }
    if (error instanceof AutomationError) {
      return res.status(500).json(await buildAutomationErrorBody(error, getAutomationErrorCode));
    }
    next(error);
  }
});

/**
 * PUT /api/sessions/:sessionId/proxy
 * Update proxy for an existing session (managed internally by headless)
 */
router.put('/:sessionId/proxy', async (req, res, next) => {
  const { sessionId } = req.params;
  try {
    const { proxy, async, requestId, context, webhookUrl } = req.body || {};
    if (!proxy || typeof proxy !== 'object' || !proxy.server) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid proxy format. Expected {server: string, username?: string, password?: string}.',
      });
    }

    const proxyConfig = {
      server: proxy.server,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    };

    const asyncMode = toBoolean(req.query?.async) || toBoolean(async);
    const normalizedRequestId = normalizeRequestId(sessionId, requestId);
    if (asyncMode) {
      const { job, created } = enqueueSessionFlowJob({
        requestId: normalizedRequestId,
        jobType: 'update_session_proxy',
        targetSessionId: sessionId,
        payload: {
          proxy: proxyConfig,
          context: context && typeof context === 'object' && !Array.isArray(context) ? context : null,
        },
        webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        created,
        job: serializeSessionFlowJob(job),
      });
    }

    const result = await updateSessionProxy(sessionId, proxyConfig);
    res.json({
      ok: true,
      message: 'Proxy updated',
      sessionId: result.sessionId,
      ipAddress: result.ipAddress || null,
      cUser: result.cUser || null,
      fingerprint: result.fingerprint || null,
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json(
        buildJsonErrorBody(error, 'Session not found', {
          errorCode: 'session_not_found',
          sessionId,
        })
      );
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json(await buildInvalidInputErrorBody(error));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/cleanup
 * Destroy all sessions except those listed in keep
 */
router.post('/cleanup', async (req, res, next) => {
  try {
    const keep = Array.isArray(req.body?.keep) ? req.body.keep : [];
    const result = await cleanupSessions(keep);
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/sessions/clear-all
 * Destroy all sessions and clear persistent store
 */
router.post('/clear-all', async (req, res, next) => {
  try {
    const result = await clearAllSessions();
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
