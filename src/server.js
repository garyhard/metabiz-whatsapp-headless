/**
 * Express server for headless WhatsApp automation service
 */

import express from 'express';
import { config } from './config.js';
import { apiKeyAuth } from './middleware/auth.js';
import sessionsRouter from './routes/sessions.js';
import messagesRouter from './routes/messages.js';
import cookiesRouter from './routes/cookies.js';
import sessionJobsRouter from './routes/sessionJobs.js';
import createOperationsRouter from './routes/createOperations.js';
import { destroyAllSessions, restoreSessions, getProgressByCUser } from './services/sessionManager.js';
import {
  startMessageQueueWorker,
  stopMessageQueueWorker,
  getMessageQueueWorkerStatus,
} from './services/messageQueue.js';
import {
  startSessionFlowQueueWorker,
  stopSessionFlowQueueWorker,
  getSessionFlowQueueWorkerStatus,
} from './services/sessionFlowQueue.js';
import {
  startCreateOperationQueueWorker,
  stopCreateOperationQueueWorker,
  getCreateOperationQueueWorkerStatus,
} from './services/createOperationQueue.js';
import { sessionStore, flushSessionStorePersist, getSessionStorePersistStatus } from './services/sessionStore.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getDiskPressureStatus } from './services/systemHealth.js';
import {
  startProfileCleanupWorker,
  stopProfileCleanupWorker,
  getProfileCleanupStatus,
} from './services/profileCleanup.js';
import {
  SessionNotFoundError,
  InvalidInputError,
  AutomationError,
  BrowserCrashError,
  FlowTimeoutError,
} from './errors.js';
import { readRequestLog } from './services/automation.js';
import { buildJsonErrorBody } from './utils/apiErrors.js';

function getAutomationErrorCode(error) {
  const message = String(error?.message || '').toLowerCase();
  const type = String(error?.details?.type || '').toLowerCase();
  if (type === 'account_restricted' || message.includes('account restricted')) return 'account_restricted';
  if (type === 'captcha_required' || message.includes('captcha checkpoint')) return 'captcha_required';
  if (type === 'need_new_cookies' || message.includes('need new cookies')) return 'need_new_cookies';
  return 'automation_error';
}

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEBUG_DIR = path.join(__dirname, '../profiles/debug');

function resolveHttpRequestId(req) {
  const explicit =
    String(
      req.body?.requestId ||
      req.query?.requestId ||
      req.headers['x-request-id'] ||
      req.headers['x-correlation-id'] ||
      ''
    ).trim();

  if (explicit) return explicit;
  return `http-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildHttpJsonErrorBody(req, error, fallback, extra = {}) {
  const details = {
    requestId: req.requestId || null,
    method: req.method,
    path: req.originalUrl || req.url || null,
    ...(extra.details && typeof extra.details === 'object' ? extra.details : {}),
  };

  return buildJsonErrorBody(error, fallback, {
    ...extra,
    details,
  });
}

// Middleware
app.disable('x-powered-by');
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use((req, res, next) => {
  req.requestId = resolveHttpRequestId(req);
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// Health check endpoint (no auth required)
app.get('/health', async (req, res) => {
  const now = Date.now();
  const messageQueue = getMessageQueueWorkerStatus(now);
  const sessionFlowQueue = getSessionFlowQueueWorkerStatus(now);
  const createOperationQueue = getCreateOperationQueueWorkerStatus(now);
  const persist = getSessionStorePersistStatus(now);
  const disk = await getDiskPressureStatus();
  const profileCleanup = getProfileCleanupStatus(now);
  const messageJobCounts = sessionStore.messageJobStatusCounts();
  const queueHealthy = !messageQueue.stalled && !sessionFlowQueue.stalled && !createOperationQueue.stalled && !disk.pressured;

  res.status(queueHealthy ? 200 : 503).json({
    ok: queueHealthy,
    status: queueHealthy ? 'healthy' : 'degraded',
    messageJobs: {
      queued: Number(messageJobCounts.queued || 0),
      processing: Number(messageJobCounts.processing || 0),
      sent: Number(messageJobCounts.sent || 0),
      error: Number(messageJobCounts.error || 0),
    },
    workers: {
      messageQueue,
      sessionFlowQueue,
      createOperationQueue,
    },
    store: {
      persist,
      disk,
      cleanup: {
        profiles: profileCleanup,
      },
    },
  });
});

// API routes with authentication
// Mount sessions router first (handles GET /, GET /:sessionId, POST /, DELETE /:sessionId)
app.use('/api/sessions', apiKeyAuth, sessionsRouter);
// Mount messages router (handles POST /:sessionId/send-message)
app.use('/api/sessions', apiKeyAuth, messagesRouter);
// Cookies validation
app.use('/api/cookies', apiKeyAuth, cookiesRouter);
// Async session jobs
app.use('/api/session-jobs', apiKeyAuth, sessionJobsRouter);
// Operation-based create preflight
app.use('/api/create-operations', apiKeyAuth, createOperationsRouter);
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

  if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid JSON request body',
      errorCode: 'invalid_json',
      details: {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl || req.url || null,
      },
    });
  }

  if (err instanceof SessionNotFoundError) {
    return res.status(404).json(buildHttpJsonErrorBody(req, err, 'Session not found', {
      errorCode: 'session_not_found',
    }));
  }

  if (err instanceof InvalidInputError) {
    return res.status(400).json(buildHttpJsonErrorBody(req, err, 'Invalid input', {
      errorCode: 'invalid_input',
    }));
  }

  if (err instanceof AutomationError) {
    return res.status(500).json(
      buildHttpJsonErrorBody(req, err, 'Automation failed', {
        errorCode: getAutomationErrorCode(err),
        details: err.details,
      })
    );
  }

  if (err instanceof BrowserCrashError) {
    return res.status(500).json(buildHttpJsonErrorBody(req, err, 'Browser crashed', {
      errorCode: 'browser_crashed',
    }));
  }

  if (err instanceof FlowTimeoutError) {
    return res.status(504).json(buildHttpJsonErrorBody(req, err, 'Flow timed out', {
      errorCode: 'flow_timeout',
    }));
  }

  // Generic error handler
  const errorBody = buildHttpJsonErrorBody(req, err, 'Internal server error', {
    errorCode: 'internal_server_error',
  });
  res.status(500).json({
    ...errorBody,
    message: errorBody.error,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not found',
    errorCode: 'not_found',
    details: {
      requestId: req.requestId || null,
      method: req.method,
      path: req.originalUrl || req.url || null,
    },
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
  stopSessionFlowQueueWorker();
  stopCreateOperationQueueWorker();
  stopProfileCleanupWorker();
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

  try {
    await flushSessionStorePersist({ forceSync: true });
  } catch (error) {
    console.error('[Server] Error flushing session store:', error);
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
  startSessionFlowQueueWorker();
  startCreateOperationQueueWorker();
  if (config.devMode) {
    console.log(`[Server] 🛠️  Dev mode: Sessions will be preserved across restarts`);
  } else {
    console.log('[Server] Restoring sessions from session store...');
  }
  await restoreSessions();
  startProfileCleanupWorker().catch((error) => {
    console.error('[ProfileCleanup] Failed to start periodic cleanup:', error);
  });
});
