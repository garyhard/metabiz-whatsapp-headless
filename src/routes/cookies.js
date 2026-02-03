/**
 * Cookie validation routes
 */

import express from 'express';
import { validateCookies } from '../services/sessionManager.js';
import { InvalidInputError } from '../errors.js';

const router = express.Router();

/**
 * POST /api/cookies/validate
 * Validate cookies can open Meta Business Suite without creating a session
 */
router.post('/validate', async (req, res, next) => {
  try {
    const { cookies, proxy } = req.body || {};

    const cookiesIsString = typeof cookies === 'string';
    const cookiesIsArray = Array.isArray(cookies);
    if (!cookies || (!cookiesIsString && !cookiesIsArray)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid cookies format. Expected a string or array.',
        errorCode: 'invalid_input',
      });
    }

    // Validate proxy if provided
    let proxyConfig = null;
    if (proxy) {
      if (typeof proxy !== 'object' || !proxy.server) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid proxy format. Expected {server: string, username?: string, password?: string}.',
          errorCode: 'invalid_input',
        });
      }
      proxyConfig = {
        server: proxy.server,
        username: proxy.username || undefined,
        password: proxy.password || undefined,
      };
    }

    const result = await validateCookies(cookies, proxyConfig);

    res.json({
      ok: true,
      cUser: result.cUser,
      status: 'valid',
    });
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return res.status(400).json({
        ok: false,
        error: error.message,
        errorCode: 'invalid_input',
      });
    }
    next(error);
  }
});

export default router;
