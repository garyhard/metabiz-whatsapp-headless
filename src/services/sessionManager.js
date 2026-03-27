/**
 * Session Manager - manages browser session lifecycle
 */

import { v4 as uuidv4 } from 'uuid';
import { createBrowser } from './browserFactory.js';
import { normalizeCookiesInput, parseCookieString, toPlaywrightCookies, toPlaywrightCookiesFromJson } from '../utils/cookies.js';
import { sendMessage, checkSessionFlow, captureDebugScreenshot, detectNeedNewCookiesPage, resolveTwoFactorIfNeeded } from './automation.js';
import { SessionNotFoundError, InvalidInputError, BrowserCrashError, FlowTimeoutError, AutomationError } from '../errors.js';
import { config } from '../config.js';
import { sessionStore } from './sessionStore.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INBOX_URL = 'https://business.facebook.com/latest/inbox';
const FACEBOOK_HOME_URL = 'https://www.facebook.com/';
const PROXY_IP_CHECK_URL = 'https://api.ipify.org?format=json';
const PROXY_IP_CHECK_TIMEOUT = 15000;
const PROXY_META_CHECK_TIMEOUT = 60000;
const progressByCUser = new Map();
const SESSIONS_FILE = path.join(__dirname, '../../profiles/sessions.json');
const PROFILE_ROOT = path.join(__dirname, '../../profiles');

async function applyResolutionCookies(context, viewport) {
  const width = Number(viewport?.width) || 1600;
  const height = Number(viewport?.height) || 900;
  const value = `${width}x${height}`;
  const cookieBase = {
    name: 'wd',
    value,
    path: '/',
    secure: true,
  };
  const cookies = [
    { ...cookieBase, domain: '.facebook.com' },
    { ...cookieBase, domain: 'business.facebook.com' },
  ];
  try {
    await context.addCookies(cookies);
  } catch (error) {
    console.warn(`[SessionManager] Failed to set resolution cookies: ${error.message}`);
  }
}

async function summarizeContextCookies(context) {
  try {
    const cookies = await context.cookies([FACEBOOK_HOME_URL, INBOX_URL]);
    const names = Array.from(new Set(cookies.map((cookie) => cookie?.name).filter(Boolean))).sort();
    return {
      count: cookies.length,
      names,
    };
  } catch (error) {
    return {
      count: 0,
      names: [],
      error: error?.message || String(error),
    };
  }
}

// In-memory session registry
const sessions = new Map();
// Priority-aware per-session mutex to serialize UI automation.
const sessionLocks = new Map();
const sessionBusyCounts = new Map();
// Simple per-c_user mutex to serialize creation/check flow for the same account
const cUserLocks = new Map();
const pendingBrowserReservations = new Set();
let browserPoolLock = Promise.resolve();

const BROWSER_POOL_POLL_MS = 500;

function hasLiveBrowser(session) {
  return !!(session?.page && session?.context && session?.browser);
}

function getLiveBrowserCount() {
  let count = 0;
  for (const session of sessions.values()) {
    if (hasLiveBrowser(session)) {
      count += 1;
    }
  }
  return count;
}

function getSessionBusyCount(sessionId) {
  return sessionBusyCounts.get(sessionId) || 0;
}

function markSessionBusy(sessionId) {
  sessionBusyCounts.set(sessionId, getSessionBusyCount(sessionId) + 1);
}

function unmarkSessionBusy(sessionId) {
  const nextCount = Math.max(0, getSessionBusyCount(sessionId) - 1);
  if (nextCount <= 0) {
    sessionBusyCounts.delete(sessionId);
    return;
  }
  sessionBusyCounts.set(sessionId, nextCount);
}

function isSessionBusy(sessionId) {
  return getSessionBusyCount(sessionId) > 0;
}

function normalizeLockPriority(priority, fallback = 'normal') {
  const normalized = String(priority || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'low') {
    return normalized;
  }
  return fallback;
}

function lockPriorityRank(priority) {
  switch (normalizeLockPriority(priority)) {
    case 'high':
      return 0;
    case 'low':
      return 2;
    default:
      return 1;
  }
}

function selectNextWaiterIndex(queue, predicate = null) {
  if (!Array.isArray(queue) || queue.length === 0) return null;

  let nextIndex = null;
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (predicate && !predicate(candidate)) {
      continue;
    }
    if (nextIndex === null) {
      nextIndex = index;
      continue;
    }

    const current = queue[nextIndex];
    if (candidate.priorityRank < current.priorityRank) {
      nextIndex = index;
      continue;
    }
    if (candidate.priorityRank === current.priorityRank && candidate.seq < current.seq) {
      nextIndex = index;
    }
  }

  return nextIndex;
}

function dequeueNextWaiter(queue, { highStreak = 0, maxHighStreak = 0 } = {}) {
  if (!Array.isArray(queue) || queue.length === 0) return null;

  let nextIndex = selectNextWaiterIndex(queue);
  if (nextIndex === null) return null;

  if (maxHighStreak > 0 && highStreak >= maxHighStreak) {
    const fallbackIndex = selectNextWaiterIndex(queue, (candidate) => candidate.priorityRank > 0);
    if (fallbackIndex !== null) {
      nextIndex = fallbackIndex;
    }
  }

  const [next] = queue.splice(nextIndex, 1);
  return next || null;
}

function ensureSessionLockState(sessionId) {
  const key = String(sessionId);
  let state = sessionLocks.get(key);
  if (!state) {
    state = { active: false, queue: [], seq: 0, highStreak: 0 };
    sessionLocks.set(key, state);
  }
  return state;
}

function dispatchNextSessionWaiter(sessionId) {
  const key = String(sessionId);
  const state = sessionLocks.get(key);
  if (!state || state.active) return;

  const next = dequeueNextWaiter(state.queue, {
    highStreak: state.highStreak,
    maxHighStreak: Math.max(1, Number(config.priorityHighStreakLimit) || 3),
  });
  if (!next) {
    state.highStreak = 0;
    sessionLocks.delete(key);
    return;
  }

  state.highStreak = next.priorityRank === 0 ? state.highStreak + 1 : 0;
  state.active = true;
  next.resolve();
}

async function withBrowserPoolLock(task) {
  const previous = browserPoolLock;
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  browserPoolLock = queued;

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (browserPoolLock === queued) {
      browserPoolLock = Promise.resolve();
    }
  }
}

function getEvictableSessionCandidate(protectedSessionIds = []) {
  const protectedIds = new Set(
    Array.isArray(protectedSessionIds)
      ? protectedSessionIds.filter(Boolean).map((value) => String(value))
      : []
  );

  const candidates = [];
  for (const [sessionId, session] of sessions.entries()) {
    if (!hasLiveBrowser(session)) continue;
    if (protectedIds.has(String(sessionId))) continue;
    if (isSessionBusy(sessionId)) continue;
    if (getEffectiveSessionStatus(session) !== 'active') continue;
    if (session.manualAction) continue;

    candidates.push({
      sessionId,
      lastActivity: Number(session.lastActivity || session.createdAt || 0),
      cUser: session.cUser || null,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.lastActivity !== b.lastActivity) {
      return a.lastActivity - b.lastActivity;
    }
    return String(a.sessionId).localeCompare(String(b.sessionId));
  });

  return candidates[0];
}

async function tryReserveBrowserSlot(reservationKey, protectedSessionIds = [], reason = 'activation') {
  return withBrowserPoolLock(async () => {
    const maxActiveBrowsers = Number(config.maxActiveBrowsers) || 0;
    if (maxActiveBrowsers <= 0) {
      return { reserved: true, liveCount: getLiveBrowserCount(), pendingCount: pendingBrowserReservations.size };
    }

    const currentLiveBrowsers = getLiveBrowserCount();
    const currentPendingReservations = pendingBrowserReservations.size;
    if (currentLiveBrowsers + currentPendingReservations < maxActiveBrowsers) {
      pendingBrowserReservations.add(reservationKey);
      return {
        reserved: true,
        liveCount: currentLiveBrowsers,
        pendingCount: currentPendingReservations + 1,
      };
    }

    const candidate = getEvictableSessionCandidate(protectedSessionIds);
    if (!candidate) {
      return {
        reserved: false,
        liveCount: currentLiveBrowsers,
        pendingCount: currentPendingReservations,
      };
    }

    logStep('browser_pool:evict:start', {
      reason,
      maxActiveBrowsers,
      evictSessionId: candidate.sessionId,
      cUser: candidate.cUser,
      lastActivity: candidate.lastActivity || null,
      liveCount: currentLiveBrowsers,
      pendingCount: currentPendingReservations,
    });
    await suspendSession(candidate.sessionId);
    pendingBrowserReservations.add(reservationKey);
    const nextLiveCount = getLiveBrowserCount();
    const nextPendingCount = pendingBrowserReservations.size;
    logStep('browser_pool:evict:done', {
      reason,
      maxActiveBrowsers,
      evictSessionId: candidate.sessionId,
      liveCount: nextLiveCount,
      pendingCount: nextPendingCount,
    });
    return {
      reserved: true,
      evictedSessionId: candidate.sessionId,
      liveCount: nextLiveCount,
      pendingCount: nextPendingCount,
    };
  });
}

async function reserveBrowserSlot(reservationKey, protectedSessionIds = [], reason = 'activation') {
  const maxActiveBrowsers = Number(config.maxActiveBrowsers) || 0;
  if (maxActiveBrowsers <= 0) {
    return;
  }

  const waitMs = Math.max(0, Number(config.browserPoolWaitMs) || 0);
  const deadline = Date.now() + waitMs;

  while (true) {
    const result = await tryReserveBrowserSlot(reservationKey, protectedSessionIds, reason);
    if (result.reserved) {
      logStep('browser_pool:reserve', {
        reason,
        maxActiveBrowsers,
        liveCount: result.liveCount,
        pendingCount: result.pendingCount,
        reservationKey,
      });
      return;
    }

    if (Date.now() >= deadline) {
      throw new BrowserCrashError(
        `Active browser limit reached (${maxActiveBrowsers}) and no idle session could be suspended`
      );
    }

    await sleep(BROWSER_POOL_POLL_MS);
  }
}

async function releaseBrowserSlot(reservationKey) {
  const maxActiveBrowsers = Number(config.maxActiveBrowsers) || 0;
  if (maxActiveBrowsers <= 0) {
    return;
  }

  await withBrowserPoolLock(async () => {
    pendingBrowserReservations.delete(reservationKey);
  });
}

function extractCUser(normalized) {
  if (!normalized || !normalized.cookies) return '';
  if (normalized.format === 'string') {
    const match = normalized.cookies.find((cookie) => cookie.name === 'c_user');
    return match?.value?.toString().trim() || '';
  }
  const match = normalized.cookies.find((cookie) => String(cookie?.name) === 'c_user');
  return match?.value?.toString().trim() || '';
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeProxyConfig(proxy) {
  if (!proxy || typeof proxy !== 'object' || !proxy.server) return null;
  const server = String(proxy.server || '').trim();
  if (!server) return null;
  const username = String(proxy.username || '').trim();
  const password = String(proxy.password || '').trim();
  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function sameProxyConfig(left, right) {
  const a = normalizeProxyConfig(left);
  const b = normalizeProxyConfig(right);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.server === b.server &&
    String(a.username || '') === String(b.username || '') &&
    String(a.password || '') === String(b.password || '');
}

async function buildInvalidInputDetails(page, label, cUser = 'unknown', details = null) {
  const normalized = details && typeof details === 'object' ? { ...details } : {};
  if (!page) {
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  try {
    const debug = await captureDebugScreenshot(page, label, cUser || 'unknown');
    if (debug?.path && !normalized.screenshotPath) {
      normalized.screenshotPath = debug.path;
    }
    if (debug?.filename && !normalized.screenshotFilename) {
      normalized.screenshotFilename = debug.filename;
    }
    if (debug?.url && !normalized.url) {
      normalized.url = debug.url;
    }
  } catch (error) {
    console.warn(`[SessionManager] Failed to capture ${label} screenshot: ${error.message}`);
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

async function buildNeedNewCookiesDetails(page, label, cUser = 'unknown', detected = null, details = {}) {
  const normalizedDetected = detected && typeof detected === 'object' ? detected : {};
  return buildInvalidInputDetails(page, label, cUser, {
    type: 'need_new_cookies',
    indicator: normalizedDetected.reason || null,
    matchedHints: Array.isArray(normalizedDetected.matchedHints) ? normalizedDetected.matchedHints : [],
    ...details,
  });
}

async function dismissSaveLoginInfo(page) {
  try {
    const dialog = await page.$('[role="dialog"], [aria-modal="true"]');
    if (!dialog) return false;
    const dialogText = normalizeText(
      await page.evaluate((el) => el.textContent || el.innerText || '', dialog)
    );
    const hints = ['save login info', 'save your login info', 'simpan info login', 'simpan info masuk'];
    if (!hints.some((hint) => dialogText.includes(hint))) {
      return false;
    }
    const buttons = await dialog.$$('[role="button"], button');
    const notNowLabels = ['not now', 'nanti', 'tidak sekarang', 'jangan sekarang', 'skip', 'lewati'];
    for (const btn of buttons) {
      const visible = await btn
        .evaluate((el) => {
          const box = el.getBoundingClientRect();
          if (!box || box.width === 0 || box.height === 0) return false;
          const style = window.getComputedStyle(el);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          );
        })
        .catch(() => false);
      if (!visible) continue;
      const label = normalizeText(
        await btn.evaluate((el) => el.textContent || el.innerText || el.getAttribute('aria-label') || '')
      );
      if (notNowLabels.some((value) => label.includes(value))) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
        logStep('login_info:dismissed');
        return true;
      }
    }
  } catch {
    // ignore dismissal errors
  }
  return false;
}

async function withRetry(fn, { retries = 2, delayMs = 1000 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > retries) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

function logStep(label, details = {}) {
  const payload = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[SessionManager] ${label}${payload}`);
}

function setProgress(cUser, step, extra = {}) {
  if (!cUser) return;
  progressByCUser.set(String(cUser), {
    cUser: String(cUser),
    step,
    updatedAt: Date.now(),
    ...extra,
  });
}

export function getProgressByCUser(cUser) {
  if (!cUser) return null;
  return progressByCUser.get(String(cUser)) || null;
}

async function verifyProxyConnection(context, proxyConfig, cUser = null) {
  if (!proxyConfig || !proxyConfig.server) {
    return null;
  }

  logStep('proxy:check:start', { cUser, server: proxyConfig.server });
  const checkPage = await context.newPage();
  let ipAddress = null;
  let ipCheckFailed = false;

  try {
    try {
      logStep('proxy:check:ip:start', { cUser, url: PROXY_IP_CHECK_URL, timeout: PROXY_IP_CHECK_TIMEOUT });
      await checkPage.goto(PROXY_IP_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: PROXY_IP_CHECK_TIMEOUT });
      const ipResponse = await checkPage.textContent('body');
      const ipData = JSON.parse(ipResponse);
      ipAddress = ipData?.ip;
      if (!ipAddress) {
        throw new Error('invalid IP response');
      }
    } catch (error) {
      ipCheckFailed = true;
      logStep('proxy:check:ip:warn', { cUser, server: proxyConfig.server, error: error?.message || String(error) });
    }

    logStep('proxy:check:ok', { cUser, server: proxyConfig.server, ip: ipAddress || null, ipCheckFailed });
    return ipAddress;
  } catch (error) {
    logStep('proxy:check:error', { cUser, server: proxyConfig.server, error: error?.message || String(error) });
    throw new InvalidInputError(`Proxy invalid: ${error?.message || 'unable to connect'}`);
  } finally {
    await checkPage.close().catch(() => {});
  }
}

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new FlowTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

async function withSessionLock(sessionId, task, { priority = 'normal' } = {}) {
  const key = String(sessionId);
  const state = ensureSessionLockState(key);
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  state.queue.push({
    priorityRank: lockPriorityRank(priority),
    seq: state.seq++,
    resolve: release,
  });
  dispatchNextSessionWaiter(key);
  try {
    await current;
    markSessionBusy(key);
    return await task();
  } finally {
    unmarkSessionBusy(key);
    const currentState = sessionLocks.get(key);
    if (currentState === state) {
      state.active = false;
      dispatchNextSessionWaiter(key);
    }
  }
}

async function withCUserLock(cUser, task) {
  if (!cUser) {
    return task();
  }
  const previous = cUserLocks.get(cUser) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  cUserLocks.set(cUser, queued);

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (cUserLocks.get(cUser) === queued) {
      cUserLocks.delete(cUser);
    }
  }
}

function isBrowserClosedError(error) {
  const message = error?.message?.toLowerCase() || '';
  return (
    message.includes('target page') ||
    message.includes('context or browser has been closed') ||
    message.includes('browser has been closed') ||
    message.includes('target closed') ||
    message.includes('browser closed') ||
    message.includes('session closed')
  );
}

function isRecoverableFlowError(error) {
  return error instanceof BrowserCrashError || error instanceof FlowTimeoutError || isBrowserClosedError(error);
}

function isCaptchaRequiredError(error) {
  return error instanceof AutomationError && String(error?.details?.type || '').toLowerCase() === 'captcha_required';
}

function isAccountRestrictedError(error) {
  return error instanceof AutomationError && String(error?.details?.type || '').toLowerCase() === 'account_restricted';
}

function isInboxNotReadyError(error) {
  return error instanceof AutomationError && String(error?.details?.type || '').toLowerCase() === 'inbox_not_ready';
}

function getEffectiveSessionStatus(session) {
  if (!session) return 'suspended';
  if (session.status) return session.status;
  return session.page && session.context && session.browser ? 'active' : 'suspended';
}

function normalizeRestrictedDetails(details = null) {
  const normalized = details && typeof details === 'object' ? { ...details } : {};
  normalized.type = 'account_restricted';
  if (normalized.screenshotPath && !normalized.screenshotFilename) {
    normalized.screenshotFilename = path.basename(normalized.screenshotPath);
  }
  return normalized;
}

function buildRestrictedManualAction(details = null, detectedAtMs = Date.now(), flow = 'restricted', message = 'Account restricted detected') {
  const normalizedDetails = normalizeRestrictedDetails(details);
  const isoDetectedAt = new Date(detectedAtMs || Date.now()).toISOString();
  return {
    type: 'account_restricted',
    flow,
    detectedAt: isoDetectedAt,
    details: {
      ...normalizedDetails,
      flow,
      restrictedDetectedAt: isoDetectedAt,
    },
    message,
  };
}

function getStoredRestrictedSnapshot(sessionId) {
  const stored = sessionStore.getBySessionId(sessionId);
  if (!stored?.restricted) {
    return null;
  }

  return {
    detectedAtMs: Number(stored.restrictionDetectedAt || stored.updatedAt || Date.now()),
    details: normalizeRestrictedDetails(stored.restrictionDetails),
    message: 'Account restricted detected',
  };
}

function hydrateStoredRestrictedState(sessionId, session) {
  if (!session) return null;
  if (session.manualAction?.type === 'account_restricted') {
    return session.manualAction;
  }

  const snapshot = getStoredRestrictedSnapshot(sessionId);
  if (!snapshot) {
    return null;
  }

  session.status = 'restricted';
  session.lastActivity = session.lastActivity || snapshot.detectedAtMs;
  session.manualAction = buildRestrictedManualAction(
    snapshot.details,
    snapshot.detectedAtMs,
    snapshot.details?.flow || 'restricted_cache',
    snapshot.message
  );
  return session.manualAction;
}

function getCachedRestrictedManualAction(sessionId) {
  const session = sessions.get(sessionId);
  if (session?.manualAction?.type === 'account_restricted') {
    return session.manualAction;
  }
  if (session) {
    return hydrateStoredRestrictedState(sessionId, session);
  }

  const snapshot = getStoredRestrictedSnapshot(sessionId);
  if (!snapshot) {
    return null;
  }

  return buildRestrictedManualAction(
    snapshot.details,
    snapshot.detectedAtMs,
    snapshot.details?.flow || 'restricted_cache',
    snapshot.message
  );
}

function clearRestrictedSessionState(sessionId, nextStatus = null) {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.manualAction?.type === 'account_restricted') {
      session.manualAction = null;
    }
    if (session.status === 'restricted' && nextStatus) {
      session.status = nextStatus;
    }
  }
  sessionStore.clearSessionRestricted(sessionId);
}

function markSessionRestricted(sessionId, error, flow = 'unknown') {
  const session = sessions.get(sessionId);
  const detectedAtMs = Date.now();
  const manualAction = buildRestrictedManualAction(
    {
      ...(error?.details || {}),
      sessionId,
    },
    detectedAtMs,
    flow,
    error?.message || 'Account restricted detected'
  );

  if (session) {
    if (session.activityTimer) {
      clearInterval(session.activityTimer);
      session.activityTimer = null;
    }
    session.status = 'restricted';
    session.lastActivity = detectedAtMs;
    session.manualAction = manualAction;
    setIdleTimer(sessionId);
  }

  sessionStore.markSessionRestricted(sessionId, manualAction.details, detectedAtMs);
  const cancelledJobs = sessionStore.failQueuedMessageJobsForSession(
    sessionId,
    manualAction.message,
    {
      ok: false,
      error: manualAction.message,
      errorCode: 'account_restricted',
      name: error?.name ? String(error.name) : null,
      details: {
        ...(manualAction.details || {}),
        flow,
        sessionId,
      },
    }
  );
  sessionStore.updateStatus(sessionId, 'restricted', detectedAtMs);
  logStep('session:restricted', {
    sessionId,
    flow,
    cancelledJobs,
    screenshotPath: manualAction.details?.screenshotPath || null,
    message: manualAction.message,
  });
}

function throwIfSessionRestricted(sessionId, flow = 'unknown') {
  const manualAction = getCachedRestrictedManualAction(sessionId);
  if (!manualAction) {
    return;
  }

  throw new AutomationError(`Session ${sessionId}: Account restricted detected`, {
    ...(manualAction.details || {}),
    flow,
    cachedRestricted: true,
    sessionId,
  });
}

function wrapRecoverableFlowError(sessionId, error) {
  const message = error?.message ? String(error.message) : String(error || 'Unknown recoverable flow failure');
  if (error instanceof FlowTimeoutError) {
    return new FlowTimeoutError(
      message.includes(`Session ${sessionId}:`) ? message : `Session ${sessionId}: ${message}`
    );
  }
  return new BrowserCrashError(
    message.includes(`session ${sessionId}`) ? message : `Browser crashed for session ${sessionId}: ${message}`
  );
}

async function runRecoverableSessionFlow({
  sessionId,
  flowName,
  manualActionFlow,
  restrictedFlow,
  failureSuspendReason,
  retryFailureSuspendReason,
  initialTask,
  retryTask,
  maxRecoveryAttemptsOverride = null,
}) {
  try {
    return await initialTask();
  } catch (error) {
    if (isCaptchaRequiredError(error)) {
      markSessionNeedsManualAction(sessionId, error, manualActionFlow);
      throw error;
    }
    if (isAccountRestrictedError(error)) {
      markSessionRestricted(sessionId, error, restrictedFlow);
      throw error;
    }
    if (!isRecoverableFlowError(error)) {
      await suspendUnhealthySession(sessionId, failureSuspendReason);
      throw error;
    }

    let lastError = error;
    const configuredAttempts =
      maxRecoveryAttemptsOverride == null
        ? Number(config.flowRecoverableRetryAttempts) || 0
        : Number(maxRecoveryAttemptsOverride) || 0;
    const maxRecoveryAttempts = Math.max(0, configuredAttempts);
    const retryDelayMs = Math.max(0, Number(config.flowRecoverableRetryDelayMs) || 0);

    for (let attempt = 1; attempt <= maxRecoveryAttempts; attempt += 1) {
      logStep('session:flow:recoverable_retry', {
        sessionId,
        flow: flowName,
        attempt,
        maxAttempts: maxRecoveryAttempts,
        error: lastError?.message || String(lastError),
      });

      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }

      try {
        await recreateSessionFromMemory(sessionId);
        return {
          retried: true,
          ...(await retryTask(attempt) || {}),
        };
      } catch (retryError) {
        lastError = retryError;
        if (isCaptchaRequiredError(retryError)) {
          markSessionNeedsManualAction(sessionId, retryError, `${manualActionFlow}_retry`);
          throw retryError;
        }
        if (isAccountRestrictedError(retryError)) {
          markSessionRestricted(sessionId, retryError, `${restrictedFlow}_retry`);
          throw retryError;
        }
        if (!isRecoverableFlowError(retryError)) {
          await suspendUnhealthySession(sessionId, failureSuspendReason);
          throw retryError;
        }
      }
    }

    await suspendUnhealthySession(sessionId, retryFailureSuspendReason);
    throw wrapRecoverableFlowError(sessionId, lastError);
  }
}

function clearSessionTimers(session) {
  if (!session) return;
  if (session.activityTimer) {
    clearInterval(session.activityTimer);
    session.activityTimer = null;
  }
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function setIdleTimer(sessionId, timeoutOverrideMs = null) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  const configuredTimeoutMs = Number(timeoutOverrideMs);
  const idleTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 0
    ? configuredTimeoutMs
    : config.idleTimeoutMs;

  if (!idleTimeoutMs || idleTimeoutMs <= 0) return;

  session.idleTimer = setTimeout(async () => {
    try {
      await suspendSession(sessionId);
    } catch (error) {
      console.warn(`[SessionManager] Idle suspend failed for session ${sessionId}:`, error.message);
    }
  }, idleTimeoutMs);
}

function touchSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.lastActivity = Date.now();
  setIdleTimer(sessionId);
  sessionStore.updateStatus(sessionId, getEffectiveSessionStatus(session), session.lastActivity);
}

function markSessionActive(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status === 'restricted' || session.manualAction?.type === 'account_restricted') {
    clearRestrictedSessionState(sessionId, 'active');
  }
  session.status = 'active';
  session.suspendedAt = null;
  session.manualAction = null;
  session.lastActivity = Date.now();
  if (session.page && !session.activityTimer) {
    session.activityTimer = startActivitySimulation(session.page, sessionId);
  }
  setIdleTimer(sessionId);
  sessionStore.updateStatus(sessionId, 'active', session.lastActivity);
}

function hasQueuedWorkForSession(sessionId) {
  const now = Date.now();
  return (
    sessionStore.hasQueuedMessageJobForSession(sessionId, now) ||
    sessionStore.hasQueuedSessionFlowJobForSession(sessionId, now)
  );
}

function settleSessionAfterFlow(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  markSessionActive(sessionId);

  if (hasQueuedWorkForSession(sessionId)) {
    return;
  }

  const configuredPostFlowIdleTimeoutMs = Math.max(0, Number(config.postFlowIdleTimeoutMs) || 0);
  if (configuredPostFlowIdleTimeoutMs <= 0) {
    void suspendSession(sessionId).catch((error) => {
      console.warn(`[SessionManager] Post-flow suspend failed for session ${sessionId}:`, error.message);
    });
    return;
  }

  const effectiveTimeoutMs =
    config.idleTimeoutMs > 0
      ? Math.min(config.idleTimeoutMs, configuredPostFlowIdleTimeoutMs)
      : configuredPostFlowIdleTimeoutMs;

  setIdleTimer(sessionId, effectiveTimeoutMs);
}

function markSessionNeedsManualAction(sessionId, error, flow = 'unknown') {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearSessionTimers(session);
  const manualActionType = String(error?.details?.type || 'manual_action_required');
  const manualActionMessage = error?.message || 'Manual action required';
  session.status = 'needs_manual_action';
  session.lastActivity = Date.now();
  session.manualAction = {
    type: manualActionType,
    flow,
    detectedAt: new Date().toISOString(),
    details: {
      ...(error?.details || {}),
      flow,
    },
    message: manualActionMessage,
  };
  sessionStore.updateStatus(sessionId, 'needs_manual_action', session.lastActivity);
  const queuedMessageJobs = sessionStore.failQueuedMessageJobsForSession(
    sessionId,
    manualActionMessage,
    {
      ok: false,
      error: manualActionMessage,
      errorCode: manualActionType,
      details: {
        ...(error?.details || {}),
        flow,
        sessionId,
      },
    }
  );
  const queuedSessionFlowJobs = sessionStore.failQueuedSessionFlowJobsForSession(
    sessionId,
    manualActionMessage,
    manualActionType,
    {
      ok: false,
      error: manualActionMessage,
      errorCode: manualActionType,
      details: {
        ...(error?.details || {}),
        flow,
        sessionId,
      },
    }
  );
  logStep('session:manual_action_required', {
    sessionId,
    flow,
    type: session.manualAction.type,
    message: session.manualAction.message,
    cancelledJobs: queuedMessageJobs,
    cancelledSessionFlowJobs: queuedSessionFlowJobs,
  });
}

async function suspendSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  clearSessionTimers(session);

  try {
    if (session.page) {
      await session.page.close().catch(() => {});
    }
    if (session.context) {
      await session.context.close().catch(() => {});
    }
    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
  } catch (error) {
    console.warn(`[SessionManager] Error suspending session ${sessionId}:`, error.message);
  }

  session.page = null;
  session.context = null;
  session.browser = null;
  session.activityTimer = null;
  session.ipAddress = null;
  session.status = 'suspended';
  session.suspendedAt = Date.now();
  sessionStore.updateStatus(sessionId, 'suspended', session.lastActivity || Date.now());
}

async function suspendUnhealthySession(sessionId, reason = 'unknown') {
  try {
    await suspendSession(sessionId);
    logStep('session:suspended:unhealthy', { sessionId, reason });
  } catch (error) {
    console.warn(
      `[SessionManager] Failed to suspend unhealthy session ${sessionId}:`,
      error?.message || String(error)
    );
  }
}

async function ensureSessionActive(sessionId) {
  let session = sessions.get(sessionId);
  if (session) {
    hydrateStoredRestrictedState(sessionId, session);
  }
  if (!session) {
    const stored = sessionStore.getBySessionId(sessionId);
    if (!stored) {
      throw new SessionNotFoundError(sessionId);
    }
    await createSession(
      stored.cookies,
      sessionId,
      stored.fingerprint,
      stored.proxy || null,
      {
        skipCUserCheck: true,
        cUserOverride: stored.cUser,
        twofaSecret: stored.twofaSecret || null,
      }
    );
    session = sessions.get(sessionId);
    if (session) {
      hydrateStoredRestrictedState(sessionId, session);
    }
  }
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  if (session.page && session.context && session.browser) {
    return session;
  }

  const cookiePayload = session.cookieString || session.cookieJson;
  await createSession(
    cookiePayload,
    sessionId,
    session.fingerprint,
    session.proxy || null,
    {
      skipCUserCheck: true,
      cUserOverride: session.cUser,
      twofaSecret: session.twofaSecret || null,
    }
  );
  const refreshed = sessions.get(sessionId);
  if (refreshed) {
    hydrateStoredRestrictedState(sessionId, refreshed);
    if (!refreshed.status || refreshed.status === 'suspended') {
      refreshed.status = 'active';
    }
    return refreshed;
  }
  return getSession(sessionId);
}

async function recreateSessionFromMemory(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || (!session.cookieString && !session.cookieJson)) {
    throw new InvalidInputError(`No cookies available to recreate session ${sessionId}`);
  }

  try {
    if (session.activityTimer) {
      clearInterval(session.activityTimer);
    }
    if (session.page) {
      await session.page.close().catch(() => {});
    }
    if (session.context) {
      await session.context.close().catch(() => {});
    }
    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
  } catch {
    // Ignore timer cleanup errors
  }

  const cookiePayload = session.cookieString || session.cookieJson;
  return createSession(
    cookiePayload,
    sessionId,
    session.fingerprint,
    session.proxy || null,
    {
      skipCUserCheck: true,
      cUserOverride: session.cUser,
      twofaSecret: session.twofaSecret || null,
    }
  );
}

async function detectLoginOrCheckpoint(page) {
  const url = page.url();
  const urlLower = url.toLowerCase();
  if (
    urlLower.includes('login') ||
    urlLower.includes('checkpoint') ||
    urlLower.includes('recover') ||
    urlLower.includes('twofactor')
  ) {
    return { blocked: true, reason: `Unexpected auth URL: ${url}` };
  }

  try {
    const indicators = await page.evaluate(() => {
      const inboxIndicators =
        !!document.querySelector('span[data-surface="/bizweb:all/thread_row"]') ||
        !!document.querySelector('[data-pagelet="GenericBizInboxThreadListViewHeader"]') ||
        !!document.querySelector('[aria-label="Inbox"]') ||
        !!document.querySelector('[data-pagelet*="BizInbox"]');
      const hasLoginForm =
        !!document.querySelector('input[name="email"], input#email, input[name="pass"], #pass') ||
        !!document.querySelector('[data-testid="royal_login_form"], form[action*="login"]');
      return { inboxIndicators, hasLoginForm };
    });

    if (indicators.inboxIndicators) {
      return { blocked: false, reason: null };
    }

    if (indicators.hasLoginForm) {
      return { blocked: true, reason: 'Login/checkpoint indicators detected' };
    }
  } catch {
    // Ignore DOM inspection failures
  }

  return { blocked: false, reason: null };
}

async function cleanupProfile(sessionId) {
  const dir = path.join(PROFILE_ROOT, `session-${sessionId}`);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Generate random number between min and max
 */
function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Start subtle activity simulation for a session
 */
function startActivitySimulation(page, sessionId) {
  // Random interval between 5-10 minutes
  const intervalMs = random(5 * 60 * 1000, 10 * 60 * 1000);

  const timer = setInterval(async () => {
    try {
      // Very subtle activity: tiny mouse movement or small scroll
      const action = Math.random() > 0.5 ? 'mouse' : 'scroll';

      if (action === 'mouse') {
        // Get current mouse position and move slightly
        const currentX = random(100, 500);
        const currentY = random(100, 500);
        await page.mouse.move(currentX + random(-2, 2), currentY + random(-2, 2));
      } else {
        // Small scroll
        const scrollAmount = random(10, 50);
        await page.evaluate((amount) => {
          window.scrollBy(0, amount);
        }, scrollAmount);
      }
    } catch (error) {
      // If page is closed or browser crashed, stop the timer
      console.warn(`[SessionManager] Activity simulation failed for session ${sessionId}:`, error.message);
      clearInterval(timer);
      const session = sessions.get(sessionId);
      if (session) {
        session.activityTimer = null;
      }
    }
  }, intervalMs);

  return timer;
}

/**
 * Create a new session
 * @param {string|Array<Object>} cookieInput - Cookie string or JSON cookie array
 * @param {string} [existingSessionId] - Optional session ID to reuse (for recreation)
 * @param {Object} [existingFingerprint] - Optional fingerprint to reuse (for recreation)
 * @param {Object} [proxy] - Optional proxy configuration {server, username?, password?}
 * @returns {Promise<string>} Session ID
 */
export async function createSession(
  cookieInput,
  existingSessionId = null,
  existingFingerprint = null,
  proxy = null,
  options = {}
) {
  const normalized = normalizeCookiesInput(cookieInput);
  const cUser = extractCUser(normalized);
  const { cUserOverride = null, twofaSecret = null } = options || {};
  const normalizedTwofaSecret = String(twofaSecret || '').trim() || null;
  const finalCUser = cUserOverride || cUser;

  return withCUserLock(finalCUser, async () => {
    logStep('createSession:start', { cUser: finalCUser });
    setProgress(finalCUser, 'create:start');
    if (normalized.format === 'string') {
      if (!normalized.raw || !String(normalized.raw).trim()) {
        throw new InvalidInputError('Cookies are required');
      }
    }
    if (normalized.format === 'json' && (!Array.isArray(normalized.raw) || normalized.raw.length === 0)) {
      throw new InvalidInputError('Cookies are required');
    }
    if (!finalCUser) {
      throw new InvalidInputError('c_user cookie is required');
    }
    // Use existing sessionId if provided (for recreation), otherwise generate new one
    const sessionId = existingSessionId || uuidv4();
    const cachedRestriction = existingSessionId ? getCachedRestrictedManualAction(sessionId) : null;
    const stored = sessionStore.getByCUser(finalCUser);
    const storedFingerprint = stored ? stored.fingerprint : sessionStore.getFingerprint(finalCUser);
    const fingerprintToUse = existingFingerprint || storedFingerprint || null;
    const existingSession = existingSessionId ? sessions.get(sessionId) : null;
    const browserReservationKey = `session:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const needsBrowserReservation = !hasLiveBrowser(existingSession);
    let browserSlotReserved = false;
    let browserInstance = null;
    let browser = null;
    let context = null;
    let page = null;
    let activityTimer = null;
    let ipAddress = null;

    try {
      logStep('createSession:browser:init', { sessionId, cUser: finalCUser });
      setProgress(finalCUser, 'create:browser:init', { sessionId });
      // Use provided proxy, or fall back to config proxy, or null
      const proxyConfig = proxy || config.proxy || null;

      if (needsBrowserReservation) {
        await reserveBrowserSlot(
          browserReservationKey,
          [sessionId],
          existingSessionId ? 'restore_session' : 'create_session'
        );
        browserSlotReserved = true;
      }

      // Create browser instance with existing fingerprint and proxy if provided (for recreation)
      await cleanupProfile(sessionId);
      logStep('createSession:profile:reset', { sessionId, cUser: finalCUser });
      browserInstance = await createBrowser(sessionId, fingerprintToUse, proxyConfig);
      browser = browserInstance.browser;
      context = browserInstance.context;
      page = browserInstance.page;
      logStep('createSession:browser:ready', { sessionId, cUser: finalCUser });
      setProgress(finalCUser, 'create:browser:ready', { sessionId });

      if (proxyConfig && proxyConfig.server) {
        ipAddress = await verifyProxyConnection(context, proxyConfig, finalCUser);
        setProgress(finalCUser, 'create:proxy:ok', { sessionId, ipAddress });
      }

      // Parse and set cookies (string header or JSON array)
      if (normalized.format === 'string') {
        const cookies = parseCookieString(normalized.raw);
        if (cookies.length === 0) {
          throw new InvalidInputError('No valid cookies found in the input string');
        }

        // Convert to Playwright format and set for multiple domains
        const domains = ['business.facebook.com', '.facebook.com'];
        for (const domain of domains) {
          try {
            const playwrightCookies = toPlaywrightCookies(cookies, domain);
            await context.addCookies(playwrightCookies);
          } catch (error) {
            // Some cookies might fail for certain domains, continue
            console.warn(`[SessionManager] Failed to set cookies for ${domain}:`, error.message);
          }
        }
      } else {
        const playwrightCookies = toPlaywrightCookiesFromJson(normalized.raw);
        if (playwrightCookies.length === 0) {
          throw new InvalidInputError('No valid cookies found in the input array');
        }
        await context.addCookies(playwrightCookies);
      }
      await applyResolutionCookies(context, browserInstance.fingerprint?.viewport);
      logStep('createSession:cookies:applied', { sessionId, cUser: finalCUser, format: normalized.format });
      const cookieSummary = await summarizeContextCookies(context);
      logStep('createSession:cookies:verified', {
        sessionId,
        cUser: finalCUser,
        count: cookieSummary.count,
        names: cookieSummary.names,
        error: cookieSummary.error || null,
      });
      setProgress(finalCUser, 'create:cookies:applied', { sessionId, format: normalized.format });

      console.log(`[SessionManager] Navigating to ${FACEBOOK_HOME_URL} for cookie bootstrap...`);
      await withRetry(
        () => page.goto(FACEBOOK_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
        { retries: 2, delayMs: 1000 }
      );
      logStep('createSession:bootstrap:done', { sessionId, cUser: finalCUser, url: page.url() });
      await page.waitForTimeout(500);

      // Navigate to inbox
      console.log(`[SessionManager] Navigating to ${INBOX_URL}...`);
      await withRetry(
        () => page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
        { retries: 2, delayMs: 1000 }
      );
      logStep('createSession:navigate:done', { sessionId, cUser: finalCUser });
      setProgress(finalCUser, 'create:navigate:done', { sessionId });

      // Verify we're on the right page
      const finalUrl = page.url();
      console.log(`[SessionManager] Page loaded. Final URL: ${finalUrl}`);
      if (!finalUrl.includes('business.facebook.com')) {
        console.warn(`[SessionManager] ⚠️  Warning: Expected business.facebook.com, got: ${finalUrl}`);
      }

      // Short settle time after DOMContentLoaded
      await page.waitForTimeout(500);
      
      // Log page title to verify it loaded correctly
      const pageTitle = await page.title();
      console.log(`[SessionManager] Page title: ${pageTitle}`);

      // Retry auth check a few times before declaring cookies expired
      let authCheck = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await dismissSaveLoginInfo(page);
        try {
          await resolveTwoFactorIfNeeded(page, {
            twofaSecret: normalizedTwofaSecret,
            label: 'CreateSession',
            cUser: finalCUser,
          });
        } catch (error) {
          if (isAccountRestrictedError(error) && sessionId) {
            markSessionRestricted(sessionId, error, 'create_session');
            throw error;
          }
          throw new InvalidInputError(error.message, error?.details || null);
        }
        authCheck = await detectLoginOrCheckpoint(page);
        if (!authCheck.blocked) break;
        logStep('createSession:auth:retry', { sessionId, cUser: finalCUser, attempt, reason: authCheck.reason });
        if (attempt < 3) {
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(1500);
            await dismissSaveLoginInfo(page);
          } catch (error) {
            console.warn(`[SessionManager] Auth retry reload failed: ${error.message}`);
          }
        }
      }
      if (authCheck && authCheck.blocked) {
        logStep('createSession:auth:blocked', { sessionId, cUser: finalCUser, reason: authCheck.reason });
        setProgress(finalCUser, 'create:auth:blocked', { sessionId, reason: authCheck.reason });
        throw new InvalidInputError(
          `Session not authenticated: ${authCheck.reason}`,
          await buildInvalidInputDetails(page, 'create-auth-blocked', finalCUser, {
            type: 'need_new_cookies',
            reason: authCheck.reason,
            stage: 'create_session.auth_check',
          })
        );
      }
      const needNewCookies = await detectNeedNewCookiesPage(page);
      if (needNewCookies?.detected) {
        logStep('createSession:need_new_cookies', {
          sessionId,
          cUser: finalCUser,
          indicator: needNewCookies.reason || null,
        });
        throw new InvalidInputError(
          'Session requires new cookies',
          await buildNeedNewCookiesDetails(page, 'create-need-new-cookies', finalCUser, needNewCookies, {
            stage: 'create_session.need_new_cookies',
            sessionId,
          })
        );
      }
      logStep('createSession:auth:ok', { sessionId, cUser: finalCUser });
      setProgress(finalCUser, 'create:auth:ok', { sessionId });
      
      // Verify proxy is working by checking IP address
      if (!ipAddress && proxyConfig && proxyConfig.server) {
        try {
          console.log(`[SessionManager] Verifying proxy connection...`);
          const ipCheckPage = await context.newPage();
          await ipCheckPage.goto(PROXY_IP_CHECK_URL, {
            waitUntil: 'networkidle',
            timeout: 10000,
          });
          const ipResponse = await ipCheckPage.textContent('body');
          const ipData = JSON.parse(ipResponse);
          ipAddress = ipData.ip;
          console.log(`[SessionManager] ✓ Proxy working! Browser IP: ${ipAddress}`);
          await ipCheckPage.close();
        } catch (error) {
          console.warn(`[SessionManager] ⚠️  Could not verify proxy IP (this may be normal): ${error.message}`);
        }
      } else if (!proxyConfig || !proxyConfig.server) {
        // Check IP even without proxy to show server IP
        try {
          const ipCheckPage = await context.newPage();
          await ipCheckPage.goto(PROXY_IP_CHECK_URL, {
            waitUntil: 'networkidle',
            timeout: 10000,
          });
          const ipResponse = await ipCheckPage.textContent('body');
          const ipData = JSON.parse(ipResponse);
          ipAddress = ipData.ip;
          console.log(`[SessionManager] Browser IP (no proxy): ${ipAddress}`);
          await ipCheckPage.close();
        } catch (error) {
          // Ignore IP check errors
        }
      }

      // Start activity simulation
      activityTimer = startActivitySimulation(page, sessionId);

      // Store session
      const sessionData = {
        browser,
        context,
        page,
        activityTimer,
        idleTimer: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        fingerprint: browserInstance.fingerprint, // Save the fingerprint
        ipAddress: ipAddress, // Save the IP address
        cookieString: normalized.format === 'string' ? normalized.raw : null,
        cookieJson: normalized.format === 'json' ? normalized.raw : null,
        cookieFormat: normalized.format,
        proxy: proxyConfig, // Save proxy for recreation
        status: cachedRestriction ? 'restricted' : 'active',
        suspendedAt: null,
        manualAction: cachedRestriction
          ? {
              ...cachedRestriction,
              details: { ...(cachedRestriction.details || {}) },
            }
          : null,
        cUser: finalCUser,
        twofaSecret: normalizedTwofaSecret,
      };
      sessions.set(sessionId, sessionData);
      setIdleTimer(sessionId);

      sessionStore.saveSession({
        sessionId,
        cUser: finalCUser,
        cookieFormat: normalized.format,
        cookies: normalized.raw,
        fingerprint: browserInstance.fingerprint,
        proxy: proxyConfig,
        twofaSecret: normalizedTwofaSecret,
        status: sessionData.status,
        lastActivity: sessionData.lastActivity,
      });

      // Save session metadata to disk (for dev mode persistence)
      // Only save if session was successfully created (we're past the error handling)
      if (config.devMode) {
        await saveSessionMetadata(sessionId, sessionData, normalized, proxyConfig, normalizedTwofaSecret);
      }

      console.log(`[SessionManager] ✓ Session created successfully: ${sessionId}`);
      console.log(`[SessionManager] Loaded sessions: ${sessions.size}, live browsers: ${getLiveBrowserCount()}`);
      logStep('createSession:done', { sessionId, cUser: finalCUser });
      setProgress(finalCUser, 'create:done', { sessionId });
      
      return {
        sessionId,
        ipAddress,
        fingerprint: browserInstance.fingerprint,
        cUser: finalCUser,
      };
    } catch (error) {
      logStep('createSession:error', { sessionId, cUser: finalCUser, error: error?.message || error?.toString() });
      setProgress(finalCUser, 'create:error', { sessionId, error: error?.message || error?.toString() });
      // Cleanup on error
      if (activityTimer) clearInterval(activityTimer);
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});

      if (error instanceof InvalidInputError || error instanceof AutomationError) {
        throw error;
      }
      const message = error?.message || error?.toString() || 'unknown error';
      throw new BrowserCrashError(`Failed to create session: ${message}`);
    } finally {
      if (browserSlotReserved) {
        await releaseBrowserSlot(browserReservationKey);
      }
    }
  });
}

/**
 * Validate cookies without creating a persisted session
 * @param {string|Array<Object>} cookieInput
 * @param {Object} [proxy]
 */
export async function validateCookies(cookieInput, proxy = null, options = {}) {
  const normalized = normalizeCookiesInput(cookieInput);
  const cUser = extractCUser(normalized);
  const persist = options?.persist === true;
  const freshBrowser = options?.freshBrowser === true;
  const normalizedTwofaSecret = String(options?.twofaSecret || '').trim() || null;
  if (normalized.format === 'string') {
    if (!normalized.raw || !String(normalized.raw).trim()) {
      throw new InvalidInputError('Cookies are required');
    }
  }
  if (normalized.format === 'json' && (!Array.isArray(normalized.raw) || normalized.raw.length === 0)) {
    throw new InvalidInputError('Cookies are required');
  }
  if (!cUser) {
    throw new InvalidInputError('c_user cookie is required');
  }

  const tempSessionId = persist ? uuidv4() : `validate-${uuidv4()}`;
  const browserReservationKey = persist
    ? `validate:${tempSessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    : null;
  let browserSlotReserved = false;
  let browserInstance = null;
  let browser = null;
  let context = null;
  let page = null;
  let activityTimer = null;

  try {
    logStep('validateCookies:start', { cUser });
    setProgress(cUser, 'validate:start');
    const storedFingerprint = freshBrowser ? null : sessionStore.getFingerprint(cUser);
    if (persist) {
      await reserveBrowserSlot(browserReservationKey, [], 'validate_cookies_persist');
      browserSlotReserved = true;
    }
    logStep('validateCookies:browser:init', { cUser, freshBrowser, reuseFingerprint: Boolean(storedFingerprint) });
    browserInstance = await createBrowser(tempSessionId, storedFingerprint, proxy);
    browser = browserInstance.browser;
    context = browserInstance.context;
    page = browserInstance.page;

    let ipAddress = null;
    if (proxy && proxy.server) {
      ipAddress = await verifyProxyConnection(context, proxy, cUser);
      setProgress(cUser, 'validate:proxy:ok');
    }

    if (normalized.format === 'string') {
      const cookies = parseCookieString(normalized.raw);
      if (cookies.length === 0) {
        throw new InvalidInputError('No valid cookies found in the input string');
      }
      const domains = ['business.facebook.com', '.facebook.com'];
      for (const domain of domains) {
        try {
          const playwrightCookies = toPlaywrightCookies(cookies, domain);
          await context.addCookies(playwrightCookies);
        } catch {
          // ignore per-domain cookie failures
        }
      }
    } else {
      const playwrightCookies = toPlaywrightCookiesFromJson(normalized.raw);
      if (playwrightCookies.length === 0) {
        throw new InvalidInputError('No valid cookies found in the input array');
      }
      await context.addCookies(playwrightCookies);
    }

    await applyResolutionCookies(context, browserInstance.fingerprint?.viewport);

    await withRetry(
      () => page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
      { retries: 2, delayMs: 1000 }
    );
    await page.waitForTimeout(1500);
    await dismissSaveLoginInfo(page);
    try {
      await resolveTwoFactorIfNeeded(page, {
        twofaSecret: normalizedTwofaSecret,
        label: 'ValidateCookies',
        cUser,
      });
    } catch (error) {
      throw new InvalidInputError(error.message, error?.details || null);
    }

    const authCheck = await detectLoginOrCheckpoint(page);
    if (authCheck.blocked) {
      logStep('validateCookies:blocked', { cUser, reason: authCheck.reason });
      setProgress(cUser, 'validate:blocked', { reason: authCheck.reason });
      throw new InvalidInputError(
        `Session not authenticated: ${authCheck.reason}`,
        await buildInvalidInputDetails(page, 'validate-auth-blocked', cUser, {
          type: 'need_new_cookies',
          reason: authCheck.reason,
          stage: 'validate_cookies.auth_check',
        })
      );
    }
    const needNewCookies = await detectNeedNewCookiesPage(page);
    if (needNewCookies?.detected) {
      logStep('validateCookies:need_new_cookies', { cUser, indicator: needNewCookies.reason || null });
      setProgress(cUser, 'validate:need_new_cookies', { indicator: needNewCookies.reason || null });
      throw new InvalidInputError(
        'Session requires new cookies',
        await buildNeedNewCookiesDetails(page, 'validate-need-new-cookies', cUser, needNewCookies, {
          stage: 'validate_cookies.need_new_cookies',
          sessionId: persist ? tempSessionId : null,
        })
      );
    }

    logStep('validateCookies:ok', { cUser });
    if (browserInstance && browserInstance.fingerprint) {
      sessionStore.saveFingerprint(cUser, browserInstance.fingerprint);
    }
    setProgress(cUser, 'validate:ok');
    if (persist) {
      activityTimer = startActivitySimulation(page, tempSessionId);
      const sessionData = {
        browser,
        context,
        page,
        activityTimer,
        idleTimer: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        fingerprint: browserInstance.fingerprint,
        ipAddress: ipAddress,
        cookieString: normalized.format === 'string' ? normalized.raw : null,
        cookieJson: normalized.format === 'json' ? normalized.raw : null,
        cookieFormat: normalized.format,
        proxy: proxy || null,
        status: 'active',
        suspendedAt: null,
        manualAction: null,
        cUser,
        twofaSecret: normalizedTwofaSecret,
      };
      sessions.set(tempSessionId, sessionData);
      setIdleTimer(tempSessionId);
      sessionStore.saveSession({
        sessionId: tempSessionId,
        cUser,
        cookieFormat: normalized.format,
        cookies: normalized.raw,
        fingerprint: browserInstance.fingerprint,
        proxy: proxy || null,
        twofaSecret: normalizedTwofaSecret,
        status: 'active',
        lastActivity: sessionData.lastActivity,
      });
      logStep('validateCookies:persisted', { cUser, sessionId: tempSessionId });
      setProgress(cUser, 'validate:done', { sessionId: tempSessionId });
      return { ok: true, cUser, sessionId: tempSessionId, reused: false };
    }
    return { ok: true, cUser };
  } catch (error) {
    logStep('validateCookies:error', { cUser, error: error?.message || error?.toString() });
    setProgress(cUser, 'validate:error', { error: error?.message || error?.toString() });
    if (page) {
      await captureDebugScreenshot(page, 'validate', cUser || 'unknown').catch(() => {});
    }
    if (error instanceof InvalidInputError) {
      throw error;
    }
    throw new BrowserCrashError(`Validate cookies failed: ${error.message}`);
  } finally {
    if (browserSlotReserved) {
      await releaseBrowserSlot(browserReservationKey);
    }
    if (!persist) {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      await cleanupProfile(tempSessionId);
    }
  }
}

/**
 * Validate proxy connectivity using Playwright (no cookies required)
 * @param {Object} [proxy]
 */
export async function validateProxy(proxy = null) {
  if (!proxy || !proxy.server) {
    throw new InvalidInputError('Proxy is required');
  }

  const tempSessionId = `proxy-${uuidv4()}`;
  let browser = null;
  let context = null;

  try {
    logStep('validateProxy:start', { server: proxy.server });
    const browserInstance = await createBrowser(tempSessionId, null, proxy);
    browser = browserInstance.browser;
    context = browserInstance.context;

    await verifyProxyConnection(context, proxy, null);
    logStep('validateProxy:ok', { server: proxy.server });
    return { ok: true };
  } catch (error) {
    logStep('validateProxy:error', { server: proxy?.server, error: error?.message || error?.toString() });
    if (error instanceof InvalidInputError) {
      throw error;
    }
    throw new BrowserCrashError(`Validate proxy failed: ${error.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await cleanupProfile(tempSessionId);
  }
}

/**
 * Update cookies for an existing session (without destroying it)
 * @param {string} sessionId - Session ID
 * @param {string|Array<Object>} cookieInput - Cookie string or JSON array
 */
export async function updateSessionCookies(sessionId, cookieInput, options = {}) {
  return withSessionLock(sessionId, async () => {
    const normalized = normalizeCookiesInput(cookieInput);
    const incomingTwofa = String(options?.twofaSecret || '').trim();
    const incomingProxy = normalizeProxyConfig(options?.proxy || null);
    if (normalized.format === 'string') {
      if (!normalized.raw || !String(normalized.raw).trim()) {
        throw new InvalidInputError('Cookies are required');
      }
    }
    if (normalized.format === 'json' && (!Array.isArray(normalized.raw) || normalized.raw.length === 0)) {
      throw new InvalidInputError('Cookies are required');
    }
    const cUser = extractCUser(normalized);
    if (!cUser) {
      throw new InvalidInputError('c_user cookie is required');
    }

    logStep('updateSessionCookies:start', {
      sessionId,
      cUser,
      cookieFormat: normalized.format,
      proxyProvided: !!incomingProxy,
      proxyServer: incomingProxy?.server || null,
    });

    let session = sessions.get(sessionId);
    if (!session) {
      const stored = sessionStore.getBySessionId(sessionId);
      if (!stored) {
        throw new SessionNotFoundError(sessionId);
      }
      logStep('updateSessionCookies:restore', { sessionId, cUser: stored.cUser });
      await createSession(
        normalized.raw,
        sessionId,
        stored.fingerprint,
        incomingProxy || stored.proxy || null,
        {
          skipCUserCheck: true,
          cUserOverride: cUser,
          twofaSecret: incomingTwofa || stored.twofaSecret || null,
        }
      );
      session = sessions.get(sessionId);
    }
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    const stored = sessionStore.getBySessionId(sessionId);
    const previousCUser = session.cUser || stored?.cUser || null;
    const currentProxy = normalizeProxyConfig(session.proxy || stored?.proxy || null);
    if (previousCUser && previousCUser !== cUser) {
      logStep('updateSessionCookies:cuser_changed', { sessionId, from: previousCUser, to: cUser });
    }
    if (incomingProxy) {
      const recreateReason = sameProxyConfig(incomingProxy, currentProxy) ? 'proxy_reapply' : 'proxy_changed';
      logStep(`updateSessionCookies:${recreateReason}`, {
        sessionId,
        cUser,
        from: currentProxy?.server || null,
        to: incomingProxy.server,
      });
      await destroySession(sessionId, { preserveStore: true });
      await createSession(
        normalized.raw,
        sessionId,
        session.fingerprint || stored?.fingerprint || null,
        incomingProxy,
        {
          skipCUserCheck: true,
          cUserOverride: cUser,
          twofaSecret: incomingTwofa || session.twofaSecret || stored?.twofaSecret || null,
        }
      );
      session = sessions.get(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }
    }
    if (normalized.format === 'string') {
      const cookies = parseCookieString(normalized.raw);
      if (cookies.length === 0) {
        throw new InvalidInputError('No valid cookies found in the input string');
      }

      const domains = ['business.facebook.com', '.facebook.com'];
      for (const domain of domains) {
        try {
          const playwrightCookies = toPlaywrightCookies(cookies, domain);
          await session.context.addCookies(playwrightCookies);
        } catch (error) {
          console.warn(`[SessionManager] Failed to set cookies for ${domain}:`, error.message);
        }
      }
    } else {
      const playwrightCookies = toPlaywrightCookiesFromJson(normalized.raw);
      if (playwrightCookies.length === 0) {
        throw new InvalidInputError('No valid cookies found in the input array');
      }
      await session.context.addCookies(playwrightCookies);
    }
    logStep('updateSessionCookies:cookies_applied', {
      sessionId,
      cUser,
      cookieFormat: normalized.format,
      proxyServer: incomingProxy?.server || session.proxy?.server || stored?.proxy?.server || null,
    });

    const viewport = session.page ? session.page.viewportSize() : null;
    await applyResolutionCookies(session.context, viewport);

    // Refresh page to ensure cookies are applied
    if (session.page) {
      try {
        await withRetry(
          () => session.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }),
          { retries: 2, delayMs: 1000 }
        );
      } catch (error) {
        console.warn(`[SessionManager] Cookie update reload failed: ${error.message}`);
      }
    }

    if (session.page) {
      const twofaSecret = incomingTwofa || session.twofaSecret || stored?.twofaSecret || null;
      try {
        await resolveTwoFactorIfNeeded(session.page, {
          twofaSecret,
          label: 'UpdateSessionCookies',
          cUser,
        });
      } catch (error) {
        if (isAccountRestrictedError(error)) {
          markSessionRestricted(sessionId, error, 'update_cookies');
          throw error;
        }
        throw new InvalidInputError(error.message, error?.details || null);
      }
      const authCheck = await detectLoginOrCheckpoint(session.page);
      if (authCheck.blocked) {
        logStep('updateSessionCookies:auth_blocked', { sessionId, cUser, reason: authCheck.reason });
        throw new InvalidInputError(
          `Session not authenticated: ${authCheck.reason}`,
          await buildInvalidInputDetails(session.page, 'update-cookies-auth-blocked', cUser, {
            type: 'need_new_cookies',
            reason: authCheck.reason,
            stage: 'update_session_cookies.auth_check',
            sessionId,
          })
        );
      }
      const needNewCookies = await detectNeedNewCookiesPage(session.page);
      if (needNewCookies?.detected) {
        logStep('updateSessionCookies:need_new_cookies', {
          sessionId,
          cUser,
          indicator: needNewCookies.reason || null,
        });
        throw new InvalidInputError(
          'Session requires new cookies',
          await buildNeedNewCookiesDetails(session.page, 'update-cookies-need-new-cookies', cUser, needNewCookies, {
            stage: 'update_session_cookies.need_new_cookies',
            sessionId,
          })
        );
      }
      try {
        await checkSessionFlow(session.page, {
          sessionId,
          cUser,
          twofaSecret,
        });
      } catch (error) {
        logStep('updateSessionCookies:check_failed', {
          sessionId,
          cUser,
          error: error?.message || String(error),
        });
        if (isAccountRestrictedError(error)) {
          markSessionRestricted(sessionId, error, 'update_cookies');
          throw error;
        }
        if (isInboxNotReadyError(error)) {
          throw new InvalidInputError(
            'Session loaded Facebook Business, but inbox is not ready yet',
            await buildInvalidInputDetails(session.page, 'update-cookies-inbox-not-ready', cUser, {
              type: 'inbox_not_ready',
              reason: String(error?.details?.reason || 'inbox_not_ready'),
              stage: 'update_session_cookies.inbox_check',
              sessionId,
              upstreamStage: error?.details?.stage || null,
              upstreamUrl: error?.details?.url || null,
            })
          );
        }
        if (error instanceof InvalidInputError) {
          throw error;
        }
        throw new InvalidInputError(error.message, error?.details || null);
      }
    }
    logStep('updateSessionCookies:done', { sessionId, cUser });

    clearRestrictedSessionState(sessionId, 'active');
    session.cookieString = normalized.format === 'string' ? normalized.raw : null;
    session.cookieJson = normalized.format === 'json' ? normalized.raw : null;
    session.cookieFormat = normalized.format;
    session.cUser = cUser;
    if (incomingTwofa) {
      session.twofaSecret = incomingTwofa;
    } else if (session.twofaSecret === undefined && stored?.twofaSecret) {
      session.twofaSecret = stored.twofaSecret;
    }
    touchSession(sessionId);

    const twofaToStore = incomingTwofa || session.twofaSecret || stored?.twofaSecret;
    sessionStore.saveSession({
      sessionId,
      cUser,
      cookieFormat: normalized.format,
      cookies: normalized.raw,
      fingerprint: session.fingerprint || stored?.fingerprint || null,
      proxy: incomingProxy || session.proxy || stored?.proxy || null,
      twofaSecret: twofaToStore || null,
      status: getEffectiveSessionStatus(session),
      lastActivity: session.lastActivity,
    });
    if (session.fingerprint) {
      sessionStore.saveFingerprint(cUser, session.fingerprint);
    }

    if (config.devMode) {
      await saveSessionMetadata(sessionId, session, normalized, session.proxy || null, twofaToStore || null);
    }
    return { ok: true };
  });
}

/**
 * Update proxy for an existing session.
 * The service will recreate browser context with the new proxy while preserving sessionId.
 * @param {string} sessionId - Session ID
 * @param {Object} proxyInput - Proxy configuration {server, username?, password?}
 */
export async function updateSessionProxy(sessionId, proxyInput) {
  if (!proxyInput || typeof proxyInput !== 'object' || !proxyInput.server) {
    throw new InvalidInputError('Invalid proxy format. Expected {server: string, username?: string, password?: string}.');
  }

  const proxy = {
    server: String(proxyInput.server),
    username: proxyInput.username || undefined,
    password: proxyInput.password || undefined,
  };

  return withSessionLock(sessionId, async () => {
    const active = sessions.get(sessionId);
    const stored = sessionStore.getBySessionId(sessionId);
    if (!active && !stored) {
      throw new SessionNotFoundError(sessionId);
    }

    const cookieFormat = active?.cookieFormat || stored?.cookieFormat || 'string';
    const cookies = cookieFormat === 'json'
      ? (active?.cookieJson || stored?.cookies || [])
      : (active?.cookieString || stored?.cookies || '');
    const fingerprint = active?.fingerprint || stored?.fingerprint || null;
    const cUser = active?.cUser || stored?.cUser || null;
    const twofaSecret = active?.twofaSecret || stored?.twofaSecret || null;
    if ((cookieFormat === 'json' && (!Array.isArray(cookies) || cookies.length === 0)) ||
        (cookieFormat === 'string' && !String(cookies || '').trim())) {
      throw new InvalidInputError('Cookies are required to update proxy');
    }

    logStep('updateSessionProxy:start', { sessionId, cUser, server: proxy.server });

    if (active) {
      await destroySession(sessionId, { preserveStore: true });
    }
    const createWithProxy = async (targetProxy, maxAttempts = 3) => {
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await createSession(
            cookies,
            sessionId,
            fingerprint,
            targetProxy,
            {
              skipCUserCheck: true,
              cUserOverride: cUser || null,
              twofaSecret,
            }
          );
        } catch (error) {
          lastError = error;
          logStep('updateSessionProxy:attempt:failed', {
            sessionId,
            cUser,
            attempt,
            maxAttempts,
            server: targetProxy?.server || null,
            error: error?.message || String(error),
          });
          if (error instanceof InvalidInputError || attempt >= maxAttempts) {
            break;
          }
          await sleep(1200);
        }
      }
      throw lastError;
    };

    let result = null;
    try {
      result = await createWithProxy(proxy, 3);
    } catch (updateError) {
      // Do not rollback to previous proxy: keep session stopped and require explicit proxy fix.
      sessionStore.updateStatus(sessionId, 'suspended', Date.now());
      logStep('updateSessionProxy:failed:session_stopped', {
        sessionId,
        cUser,
        server: proxy.server,
        error: updateError?.message || String(updateError),
      });
      throw updateError;
    }

    logStep('updateSessionProxy:done', { sessionId, cUser, server: proxy.server });
    return { ok: true, ...result };
  });
}

/**
 * Get a session by ID
 * @param {string} sessionId - Session ID
 * @returns {Object} Session object
 */
export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  return session;
}

/**
 * Destroy a session
 * @param {string} sessionId - Session ID
 */
export async function destroySession(sessionId, options = {}) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  const preserveStore = options?.preserveStore === true;

  try {
    // Clear activity timer
    if (session.activityTimer) {
      clearInterval(session.activityTimer);
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    // Close page, context, and browser
    if (session.page) {
      await session.page.close().catch(() => {});
    }
    if (session.context) {
      await session.context.close().catch(() => {});
    }
    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
  } catch (error) {
    console.warn(`[SessionManager] Error destroying session ${sessionId}:`, error.message);
  } finally {
    // Remove from registry
    sessions.delete(sessionId);

    // Remove from session store
    if (!preserveStore) {
      sessionStore.deleteSession(sessionId);
    }
    
    // Remove from metadata file
    if (config.devMode && !preserveStore) {
      await removeSessionMetadata(sessionId);
    }
    
    console.log(`[SessionManager] ✓ Session destroyed: ${sessionId}`);
    console.log(`[SessionManager] Loaded sessions: ${sessions.size}, live browsers: ${getLiveBrowserCount()}`);
  }
}

/**
 * Send a message using a session
 * @param {string} sessionId - Session ID
 * @param {Object} options - {extension, phoneNumber, message}
 */
export async function sendMessageForSession(
  sessionId,
  {
    extension,
    phoneNumber,
    message,
    useReplyFlow = true,
    includeSuccessScreenshot = false,
    requestId = null,
    priority = null,
  }
) {
  const sendPriority = normalizeLockPriority(priority, useReplyFlow ? 'high' : 'normal');
  return withSessionLock(sessionId, async () => {
    throwIfSessionRestricted(sessionId, 'send_cached');
    const session = await ensureSessionActive(sessionId);
    const now = Date.now();
    const lastActivity = session.lastActivity || 0;
    const forceInitialRefresh =
      config.sendReloadIdleMs > 0 &&
      lastActivity > 0 &&
      now - lastActivity > config.sendReloadIdleMs;

    const executeSendFlow = async (label, forceRefresh) => {
      const activeSession = await ensureSessionActive(sessionId);
      touchSession(sessionId);
      const result = await withTimeout(
        sendMessage(activeSession.page, {
          extension,
          phoneNumber,
          message,
          sessionId,
          cUser: activeSession.cUser || null,
          twofaSecret: activeSession.twofaSecret || null,
          forceInitialRefresh: forceRefresh,
          useReplyFlow,
          includeSuccessScreenshot,
          requestId,
        }),
        config.flowTimeoutMs,
        label
      );
      return result || {};
    };

    const result = await runRecoverableSessionFlow({
      sessionId,
      flowName: 'send',
      manualActionFlow: 'send',
      restrictedFlow: 'send',
      failureSuspendReason: 'send_flow_failed',
      retryFailureSuspendReason: 'send_retry_failed',
      initialTask: () => executeSendFlow('Send flow', forceInitialRefresh),
      retryTask: (attempt) => executeSendFlow(`Send flow (recovery ${attempt})`, true),
    });
    settleSessionAfterFlow(sessionId);
    return { ok: true, ...(result || {}) };
  }, { priority: sendPriority });
}

export async function checkSessionForSession(
  sessionId,
  { requestId = null, flowTimeoutMs = null, recoverableRetryAttempts = null } = {}
) {
  return withSessionLock(sessionId, async () => {
    throwIfSessionRestricted(sessionId, 'check_cached');
    await ensureSessionActive(sessionId);
    const effectiveFlowTimeoutMs =
      Number.isFinite(Number(flowTimeoutMs)) && Number(flowTimeoutMs) > 0
        ? Number(flowTimeoutMs)
        : config.flowTimeoutMs;
    const executeCheckFlow = async (label) => {
      const activeSession = await ensureSessionActive(sessionId);
      touchSession(sessionId);
      const result = await withTimeout(
        checkSessionFlow(activeSession.page, {
          sessionId,
          cUser: activeSession.cUser || null,
          twofaSecret: activeSession.twofaSecret || null,
          requestId,
        }),
        effectiveFlowTimeoutMs,
        label
      );
      return result || {};
    };

    const result = await runRecoverableSessionFlow({
      sessionId,
      flowName: 'check',
      manualActionFlow: 'check',
      restrictedFlow: 'check',
      failureSuspendReason: 'check_flow_failed',
      retryFailureSuspendReason: 'check_retry_failed',
      initialTask: () => executeCheckFlow('Check flow'),
      retryTask: (attempt) => executeCheckFlow(`Check flow (recovery ${attempt})`),
      maxRecoveryAttemptsOverride: recoverableRetryAttempts,
    });
    settleSessionAfterFlow(sessionId);
    return { ok: true, ...(result || {}) };
  });
}

/**
 * Get all active session IDs
 * @returns {Array<string>} Array of session IDs
 */
export function getAllSessionIds() {
  return Array.from(sessions.keys());
}

/**
 * Destroy all sessions except those in keepIds
 * @param {Array<string>} keepIds
 */
export async function cleanupSessions(keepIds = []) {
  const keepSet = new Set(Array.isArray(keepIds) ? keepIds : []);
  const sessionIds = Array.from(sessions.keys());
  const toDestroy = sessionIds.filter((id) => !keepSet.has(id));
  await Promise.all(toDestroy.map((id) => destroySession(id).catch(() => {})));
  return { destroyed: toDestroy.length, kept: keepSet.size };
}

/**
 * Get session info (without throwing if not found)
 * @param {string} sessionId - Session ID
 * @returns {Object|null} Session info or null if not found
 */
export function getSessionInfo(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }
  hydrateStoredRestrictedState(sessionId, session);
  return {
    sessionId,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    suspendedAt: session.suspendedAt || null,
    ipAddress: session.ipAddress || null,
    cUser: session.cUser || null,
    status: getEffectiveSessionStatus(session),
    liveBrowser: hasLiveBrowser(session),
    manualAction: session.manualAction || null,
  };
}

export function getSessionCaptchaImageInfo(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }
  const manualAction = session.manualAction || null;
  const details = manualAction?.details || null;
  const captchaImagePath = details?.captchaImagePath || null;
  if (!captchaImagePath) {
    return null;
  }
  return {
    sessionId,
    status: getEffectiveSessionStatus(session),
    type: manualAction?.type || null,
    path: captchaImagePath,
    filename: details?.captchaImageFilename || path.basename(captchaImagePath),
    detectedAt: manualAction?.detectedAt || null,
  };
}

export async function restoreSessionFromStore(sessionId) {
  const stored = sessionStore.getBySessionId(sessionId);
  if (!stored) {
    throw new SessionNotFoundError(sessionId);
  }
  return createSession(
    stored.cookies,
    sessionId,
    stored.fingerprint,
    stored.proxy || null,
    {
      skipCUserCheck: true,
      cUserOverride: stored.cUser,
      twofaSecret: stored.twofaSecret || null,
    }
  );
}

/**
 * Save session metadata to disk
 */
async function saveSessionMetadata(sessionId, sessionData, cookieString, proxy = null, twofaSecret = null) {
  try {
    let metadata = {};
    try {
      const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
      metadata = JSON.parse(data);
    } catch {
      // File doesn't exist yet, start fresh
    }

    const cookieFormat = cookieString?.format || 'string';
    const cookieRaw = cookieString?.raw ?? cookieString ?? null;

    metadata[sessionId] = {
      sessionId,
      createdAt: sessionData.createdAt,
      lastActivity: sessionData.lastActivity,
      profilePath: `session-${sessionId}`,
      cookieFormat,
      cookieString: cookieFormat === 'string' ? cookieRaw : null,
      cookieJson: cookieFormat === 'json' ? cookieRaw : null,
      fingerprint: sessionData.fingerprint, // Save the fingerprint for recreation
      proxy: proxy || null, // Save proxy config if provided
      twofaSecret: twofaSecret || sessionData.twofaSecret || null,
    };

    await fs.writeFile(SESSIONS_FILE, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.warn(`[SessionManager] Failed to save session metadata: ${error.message}`);
  }
}

/**
 * Load session metadata from disk
 */
async function loadSessionMetadata() {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Remove session metadata from disk
 */
async function removeSessionMetadata(sessionId) {
  try {
    let metadata = {};
    try {
      const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
      metadata = JSON.parse(data);
    } catch {
      return;
    }

    delete metadata[sessionId];
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.warn(`[SessionManager] Failed to remove session metadata: ${error.message}`);
  }
}

/**
 * Recreate a session using saved cookie string and fingerprint (for dev mode)
 * This creates a new session with the same sessionId, cookie string, and fingerprint
 */
async function recreateSession(metadata) {
  try {
    // Check if we have a saved cookie string
    const cookieFormat = metadata.cookieFormat || (metadata.cookieJson ? 'json' : 'string');
    const cookiePayload = cookieFormat === 'json' ? metadata.cookieJson : metadata.cookieString;
    if (!cookiePayload || (Array.isArray(cookiePayload) && cookiePayload.length === 0)) {
      console.warn(`[SessionManager] No cookies saved for session ${metadata.sessionId}, cannot recreate`);
      return null;
    }

    // Check if we have a saved fingerprint
    if (!metadata.fingerprint) {
      console.warn(`[SessionManager] No fingerprint saved for session ${metadata.sessionId}, cannot recreate`);
      return null;
    }

    console.log(`[SessionManager] Recreating session ${metadata.sessionId} with saved cookie string and fingerprint...`);
    
    // Use saved proxy, or fall back to config proxy, or null
    const proxyConfig = metadata.proxy || config.proxy || null;
    
    // Create a new session using the saved cookie string, sessionId, fingerprint, and proxy
    const result = await createSession(
      cookiePayload,
      metadata.sessionId,
      metadata.fingerprint,
      proxyConfig,
      { twofaSecret: metadata.twofaSecret || null }
    );
    
    console.log(`[SessionManager] ✓ Successfully recreated session ${result.sessionId}`);
    return result.sessionId;
  } catch (error) {
    console.warn(`[SessionManager] Failed to recreate session ${metadata.sessionId}: ${error.message}`);
    return null;
  }
}

/**
 * Restore sessions from disk (called on startup in dev mode)
 * In dev mode, we recreate sessions using saved cookie strings
 */
export async function restoreSessions() {
  if (!config.devMode) {
    return;
  }

  try {
    console.log('[SessionManager] Recreating sessions from saved cookie strings...');
    const metadata = await loadSessionMetadata();
    const sessionIds = Object.keys(metadata);

    if (sessionIds.length === 0) {
      console.log('[SessionManager] No sessions to recreate');
      return;
    }

    console.log(`[SessionManager] Found ${sessionIds.length} session(s) to recreate`);

    // Recreate each session using its saved cookie string
    const recreatePromises = sessionIds.map(async (sessionId) => {
      const sessionMetadata = metadata[sessionId];
      const recreatedSessionId = await recreateSession(sessionMetadata);
      
      // If recreation failed, remove the metadata
      if (!recreatedSessionId) {
        await removeSessionMetadata(sessionId);
      }
      
      return recreatedSessionId;
    });

    const results = await Promise.all(recreatePromises);
    const successful = results.filter(id => id !== null).length;

    console.log(`[SessionManager] Successfully recreated ${successful} session(s)`);
  } catch (error) {
    console.error('[SessionManager] Error recreating sessions:', error);
  }
}

/**
 * Destroy all sessions (for graceful shutdown)
 */
export async function destroyAllSessions(options = {}) {
  const sessionIds = Array.from(sessions.keys());
  await Promise.all(sessionIds.map((id) => destroySession(id, options).catch(() => {})));
  
  // Clear metadata file in dev mode
  if (config.devMode && !options?.preserveStore) {
    try {
      await fs.unlink(SESSIONS_FILE).catch(() => {});
    } catch {
      // Ignore
    }
  }
}

export async function clearAllSessions() {
  await destroyAllSessions();
  sessionStore.clearAll();
  progressByCUser.clear();
  return { ok: true };
}
