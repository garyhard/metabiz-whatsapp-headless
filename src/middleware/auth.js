/**
 * API key authentication middleware
 */

import { config } from '../config.js';

/**
 * Middleware to validate X-API-Key header
 */
export function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== config.apiKey) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid or missing API key',
    });
  }

  next();
}

