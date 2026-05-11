/**
 * Dedicated operation-based Meta create-preflight routes.
 */

import express from 'express';
import { normalizeCookiesInput } from '../utils/cookies.js';
import { normalizeRequestId } from '../services/automation.js';
import {
  enqueueCreateOperation,
  getCreateOperation,
  getCreateOperationByRequestId,
  getCreateOperationQueueWorkerStatus,
  serializeCreateOperationResponse,
} from '../services/createOperationQueue.js';
import { InvalidInputError } from '../errors.js';
import { buildJsonErrorBody } from '../utils/apiErrors.js';

const router = express.Router();

function extractCUser(cookies) {
  const normalized = normalizeCookiesInput(cookies);
  const cookie = Array.isArray(normalized.cookies)
    ? normalized.cookies.find((entry) => String(entry?.name) === 'c_user')
    : null;
  return cookie?.value ? String(cookie.value).trim() : '';
}

function toBoolean(value) {
  if (value === true) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

router.post('/', async (req, res, next) => {
  try {
    const {
      cookies,
      proxy,
      twofaSecret,
      requestId,
      flowTimeoutMs,
      recoverableRetryAttempts,
      validateProxyFirst,
    } = req.body || {};

    const cookiesIsString = typeof cookies === 'string';
    const cookiesIsArray = Array.isArray(cookies);
    if (!cookies || (!cookiesIsString && !cookiesIsArray)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid cookies format. Expected a string or array.',
        errorCode: 'invalid_input',
      });
    }

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

    const cUser = extractCUser(cookies);
    if (!cUser) {
      throw new InvalidInputError('c_user cookie is required');
    }

    const normalizedRequestId = normalizeRequestId('create-operation', requestId);
    const existingOperation = normalizedRequestId ? getCreateOperationByRequestId(normalizedRequestId) : null;
    if (existingOperation) {
      return res.status(202).json({
        ok: true,
        accepted: true,
        created: false,
        operation: serializeCreateOperationResponse(existingOperation),
      });
    }

    const queueStatus = getCreateOperationQueueWorkerStatus(Date.now());
    if (queueStatus.stalled) {
      return res.status(503).json({
        ok: false,
        accepted: false,
        error: 'Meta create queue is temporarily overloaded. Please retry after current create operations finish.',
        errorCode: 'create_queue_stalled',
        queue: queueStatus,
      });
    }

    const { operation, created } = enqueueCreateOperation({
      requestId: normalizedRequestId,
      cUser,
      payload: {
        cookies,
        proxy: proxyConfig,
        twofaSecret: twofaSecret || null,
        requestId: normalizedRequestId,
        flowTimeoutMs: flowTimeoutMs || null,
        recoverableRetryAttempts: recoverableRetryAttempts || null,
        validateProxyFirst: validateProxyFirst === undefined ? true : toBoolean(validateProxyFirst),
      },
    });

    return res.status(202).json({
      ok: true,
      accepted: true,
      created,
      operation: serializeCreateOperationResponse(operation),
    });
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return res.status(400).json(
        buildJsonErrorBody(error, 'Invalid input', {
          errorCode: 'invalid_input',
        })
      );
    }
    next(error);
  }
});

router.get('/:operationId', async (req, res) => {
  const operationId = String(req.params.operationId || '').trim();
  const operation = getCreateOperation(operationId);
  if (!operation) {
    return res.status(404).json({ ok: false, error: 'Create operation not found', errorCode: 'not_found' });
  }

  return res.json({
    ok: operation.status !== 'error',
    operation: serializeCreateOperationResponse(operation),
  });
});

export default router;
