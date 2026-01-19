/**
 * Express server for headless WhatsApp automation service
 */

import express from 'express';
import { config } from './config.js';
import { apiKeyAuth } from './middleware/auth.js';
import sessionsRouter from './routes/sessions.js';
import messagesRouter from './routes/messages.js';
import { destroyAllSessions, restoreSessions } from './services/sessionManager.js';
import {
  SessionNotFoundError,
  InvalidInputError,
  AutomationError,
  BrowserCrashError,
} from './errors.js';

const app = express();

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
  if (config.devMode) {
    console.log('[Server] Dev mode: Preserving browser sessions across restart');
    console.log('[Server] Sessions will remain active. Use DELETE /api/sessions/:id to manually destroy them.');
  } else {
    try {
      console.log('[Server] Closing all browser sessions...');
      await destroyAllSessions();
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
  if (config.devMode) {
    console.log(`[Server] 🛠️  Dev mode: Sessions will be preserved across restarts`);
    // Restore sessions from disk
    await restoreSessions();
  }
});

