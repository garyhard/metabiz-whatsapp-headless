import fs from 'fs/promises';
import path from 'path';
import { readRequestLog } from './automation.js';

export async function buildScreenshotDataUrlFromPath(filePath) {
  try {
    const normalized = String(filePath || '').trim();
    if (!normalized) return null;
    const buffer = await fs.readFile(normalized);
    if (!buffer || buffer.length === 0) return null;
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function buildScreenshotDataUrl(screenshot) {
  const filePath = screenshot?.path ? String(screenshot.path) : '';
  return buildScreenshotDataUrlFromPath(filePath);
}

export async function enrichAutomationDetails(details, fallbackRequestId = null) {
  const enriched = details && typeof details === 'object' ? { ...details } : {};
  const requestId = String(enriched.requestId || fallbackRequestId || '').trim();
  if (requestId) {
    enriched.requestId = requestId;
  }

  const runnerLog = requestId ? await readRequestLog(requestId) : null;
  if (runnerLog && !enriched.runnerLog) {
    enriched.runnerLog = runnerLog;
  }

  const screenshotPath = String(enriched.screenshotPath || runnerLog?.screenshotPath || '').trim();
  if (screenshotPath) {
    enriched.screenshotPath = screenshotPath;
    if (!enriched.screenshotFilename) {
      enriched.screenshotFilename = path.basename(screenshotPath);
    }
    if (!enriched.screenshotDataUrl) {
      enriched.screenshotDataUrl = await buildScreenshotDataUrlFromPath(screenshotPath);
    }
  }

  return Object.keys(enriched).length > 0 ? enriched : null;
}

export async function buildAutomationErrorBody(error, getAutomationErrorCode, fallbackRequestId = null) {
  const details = await enrichAutomationDetails(error?.details, fallbackRequestId);
  return {
    ok: false,
    error: error?.message || 'Automation failed',
    errorCode: getAutomationErrorCode(error),
    details,
  };
}
