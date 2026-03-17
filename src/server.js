/**
 * Express server for headless WhatsApp automation service
 */

import express from 'express';
import { config } from './config.js';
import { apiKeyAuth } from './middleware/auth.js';
import sessionsRouter from './routes/sessions.js';
import messagesRouter from './routes/messages.js';
import cookiesRouter from './routes/cookies.js';
import { destroyAllSessions, restoreSessions, getProgressByCUser } from './services/sessionManager.js';
import { startMessageQueueWorker, stopMessageQueueWorker } from './services/messageQueue.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import {
  SessionNotFoundError,
  InvalidInputError,
  AutomationError,
  BrowserCrashError,
} from './errors.js';
import { readRequestLog } from './services/automation.js';

function getAutomationErrorCode(error) {
  const message = String(error?.message || '').toLowerCase();
  const type = String(error?.details?.type || '').toLowerCase();
  if (message.includes('account restricted')) return 'account_restricted';
  if (type === 'captcha_required' || message.includes('captcha checkpoint')) return 'captcha_required';
  if (type === 'need_new_cookies' || message.includes('need new cookies')) return 'need_new_cookies';
  return 'automation_error';
}

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEBUG_DIR = path.join(__dirname, '../profiles/debug');

// Middleware
app.use(express.json());

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

// API routes with authentication
// Mount sessions router first (handles GET /, GET /:sessionId, POST /, DELETE /:sessionId)
app.use('/api/sessions', apiKeyAuth, sessionsRouter);
// Mount messages router (handles POST /:sessionId/send-message)
app.use('/api/sessions', apiKeyAuth, messagesRouter);
// Cookies validation
app.use('/api/cookies', apiKeyAuth, cookiesRouter);
// Debug screenshot download
app.get('/api/debug/screenshot', apiKeyAuth, async (req, res) => {
  try {
    const filename = String(req.query.filename || '').trim();
    if (!filename) {
      return res.status(400).json({ ok: false, error: 'filename is required' });
    }
    const safeName = path.basename(filename);
    const filePath = path.join(DEBUG_DIR, safeName);
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ ok: false, error: 'Screenshot not found' });
  }
});
app.get('/api/debug/request-log', apiKeyAuth, async (req, res) => {
  const requestId = String(req.query.requestId || '').trim();
  if (!requestId) {
    return res.status(400).json({ ok: false, error: 'requestId is required' });
  }

  const payload = await readRequestLog(requestId);
  if (!payload) {
    return res.status(404).json({ ok: false, error: 'Request log not found' });
  }

  return res.json({ ok: true, requestId, payload });
});
// Progress polling (by c_user)
app.get('/api/progress', apiKeyAuth, (req, res) => {
  const cUser = req.query.c_user || req.query.cUser;
  const progress = getProgressByCUser(cUser);
  if (!progress) {
    return res.status(404).json({ ok: false, error: 'Progress not found' });
  }
  res.json({ ok: true, progress });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err);
  // Also log the stack trace for debugging
  if (err.stack) {
    console.error('[Server] Stack trace:', err.stack);
  }

  if (err instanceof SessionNotFoundError) {
    return res.status(404).json({
      ok: false,
      error: err.message,
    });
  }

  if (err instanceof InvalidInputError) {
    return res.status(400).json({
      ok: false,
      error: err.message,
    });
  }

  if (err instanceof AutomationError) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      errorCode: getAutomationErrorCode(err),
      details: err.details,
    });
  }

  if (err instanceof BrowserCrashError) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }

  // Generic error handler
  res.status(500).json({
    ok: false,
    error: 'Internal server error',
    message: err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not found',
  });
});

// Graceful shutdown handler
let server = null;
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`[Server] Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  console.log(`\n[Server] Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new requests
  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed');
    });
  }

  // Close all browser sessions (skip in dev mode to preserve sessions across restarts)
  stopMessageQueueWorker();
  if (config.devMode) {
    console.log('[Server] Dev mode: Preserving browser sessions across restart');
    console.log('[Server] Sessions will remain active. Use DELETE /api/sessions/:id to manually destroy them.');
  } else {
    try {
      console.log('[Server] Closing all browser sessions (preserving session store)...');
      await destroyAllSessions({ preserveStore: true });
      console.log('[Server] All sessions closed');
    } catch (error) {
      console.error('[Server] Error closing sessions:', error);
    }
  }

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
server = app.listen(config.port, async () => {
  console.log(`[Server] Listening on port ${config.port}`);
  console.log(`[Server] API key authentication enabled`);
  console.log(`[Server] Health check: http://localhost:${config.port}/health`);
  startMessageQueueWorker();
  if (config.devMode) {
    console.log(`[Server] 🛠️  Dev mode: Sessions will be preserved across restarts`);
  } else {
    console.log('[Server] Restoring sessions from session store...');
  }
  await restoreSessions();
});
