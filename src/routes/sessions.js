/**
 * Session management routes
 */

import express from 'express';
import { createSession, destroySession, getAllSessionIds, getSession } from '../services/sessionManager.js';
import { InvalidInputError, SessionNotFoundError } from '../errors.js';

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
          status: 'active',
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

    if (!cookies || typeof cookies !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Invalid cookies format. Expected a string.',
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

export default router;

