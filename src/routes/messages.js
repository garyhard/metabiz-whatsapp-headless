/**
 * Message sending routes
 */

import express from 'express';
import fs from 'fs/promises';
import { sendMessageForSession, restoreSessionFromStore } from '../services/sessionManager.js';
import {
  InvalidInputError,
  SessionNotFoundError,
  AutomationError,
} from '../errors.js';

const router = express.Router();

async function buildScreenshotDataUrl(screenshot) {
  try {
    const filePath = screenshot?.path ? String(screenshot.path) : '';
    if (!filePath) return null;
    const buffer = await fs.readFile(filePath);
    if (!buffer || buffer.length === 0) return null;
    const ext = filePath.toLowerCase().endsWith('.png') ? 'png' : 'png';
    return `data:image/${ext};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * POST /api/sessions/:sessionId/send-message
 * Send a WhatsApp message
 */
router.post('/:sessionId/send-message', async (req, res, next) => {
  const { sessionId } = req.params;
  const { extension, phoneNumber, message, includeSuccessScreenshot } = req.body || {};
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
    });
    const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);

    res.json({
      ok: true,
      message: 'Message sent successfully',
      screenshot: result?.screenshot || null,
      screenshotFilename: result?.screenshot?.filename || null,
      screenshotDataUrl,
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
        });
        const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);
        return res.json({
          ok: true,
          message: 'Message sent successfully',
          screenshot: result?.screenshot || null,
          screenshotFilename: result?.screenshot?.filename || null,
          screenshotDataUrl,
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
          const isRestricted = String(restoreError.message || '').toLowerCase().includes('account restricted');
          return res.status(500).json({
            ok: false,
            error: restoreError.message,
            errorCode: isRestricted ? 'account_restricted' : 'automation_error',
            details: restoreError.details,
          });
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
      const isRestricted = String(error.message || '').toLowerCase().includes('account restricted');
      return res.status(500).json({
        ok: false,
        error: error.message,
        errorCode: isRestricted ? 'account_restricted' : 'automation_error',
        details: error.details,
      });
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
  const { extension, phoneNumber, message, includeSuccessScreenshot } = req.body || {};
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

    const result = await sendMessageForSession(sessionId, {
      extension,
      phoneNumber,
      message,
      useReplyFlow: false,
      includeSuccessScreenshot: includeSuccessScreenshot === true,
    });
    const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);

    res.json({
      ok: true,
      message: 'Message sent successfully',
      screenshot: result?.screenshot || null,
      screenshotFilename: result?.screenshot?.filename || null,
      screenshotDataUrl,
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
        });
        const screenshotDataUrl = await buildScreenshotDataUrl(result?.screenshot || null);
        return res.json({
          ok: true,
          message: 'Message sent successfully',
          screenshot: result?.screenshot || null,
          screenshotFilename: result?.screenshot?.filename || null,
          screenshotDataUrl,
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
          const isRestricted = String(restoreError.message || '').toLowerCase().includes('account restricted');
          return res.status(500).json({
            ok: false,
            error: restoreError.message,
            errorCode: isRestricted ? 'account_restricted' : 'automation_error',
            details: restoreError.details,
          });
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
      const isRestricted = String(error.message || '').toLowerCase().includes('account restricted');
      return res.status(500).json({
        ok: false,
        error: error.message,
        errorCode: isRestricted ? 'account_restricted' : 'automation_error',
        details: error.details,
      });
    }
    next(error);
  }
});

export default router;
