/**
 * Session management routes
 */

import express from 'express';
import {
  createSession,
  destroySession,
  getAllSessionIds,
  getSession,
  checkSessionForSession,
  updateSessionCookies,
  cleanupSessions,
} from '../services/sessionManager.js';
import { InvalidInputError, SessionNotFoundError, SessionAlreadyExistsError } from '../errors.js';

const router = express.Router();

/**
 * GET /api/sessions
 * List all active sessions
 */
router.get('/', async (req, res, next) => {
  try {
    const sessionIds = getAllSessionIds();
    const sessions = sessionIds.map(id => {
      try {
        const session = getSession(id);
        return {
          sessionId: id,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          ipAddress: session.ipAddress || null,
          status: session.page && session.context && session.browser ? 'active' : 'suspended',
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

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
    const session = getSession(sessionId);

    res.json({
      ok: true,
      sessionId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      ipAddress: session.ipAddress || null,
      status: 'active',
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json({
        ok: false,
        error: error.message,
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
  try {
    const { cookies, proxy } = req.body;

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
    }

    const result = await createSession(cookies, null, null, proxyConfig);

    res.status(201).json({
      sessionId: result.sessionId,
      ipAddress: result.ipAddress,
      status: 'active',
    });
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
    if (error instanceof SessionAlreadyExistsError) {
      return res.status(409).json({
        ok: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * Destroy a session
 */
router.delete('/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    await destroySession(sessionId);

    res.json({
      ok: true,
      message: 'Session destroyed',
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json({
        ok: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:sessionId/check
 * Validate session can run WhatsApp flow (no message sent)
 */
router.post('/:sessionId/check', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    await checkSessionForSession(sessionId);
    res.json({
      ok: true,
      message: 'Session check ok',
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json({
        ok: false,
        error: error.message,
      });
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * PUT /api/sessions/:sessionId/cookies
 * Update cookies for an existing session
 */
router.put('/:sessionId/cookies', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { cookies } = req.body || {};
    const cookiesIsString = typeof cookies === 'string';
    const cookiesIsArray = Array.isArray(cookies);
    if (!cookies || (!cookiesIsString && !cookiesIsArray)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid cookies format. Expected a string or array.',
      });
    }

    await updateSessionCookies(sessionId, cookies);
    res.json({
      ok: true,
      message: 'Cookies updated',
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return res.status(404).json({
        ok: false,
        error: error.message,
      });
    }
    if (error instanceof InvalidInputError) {
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
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

export default router;
