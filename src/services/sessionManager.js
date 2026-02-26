/**
 * Session Manager - manages browser session lifecycle
 */

import { v4 as uuidv4 } from 'uuid';
import { createBrowser } from './browserFactory.js';
import { normalizeCookiesInput, parseCookieString, toPlaywrightCookies, toPlaywrightCookiesFromJson } from '../utils/cookies.js';
import { sendMessage, checkSessionFlow, captureDebugScreenshot, resolveTwoFactorIfNeeded } from './automation.js';
import { SessionNotFoundError, InvalidInputError, BrowserCrashError, SessionAlreadyExistsError } from '../errors.js';
import { config } from '../config.js';
import { sessionStore } from './sessionStore.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INBOX_URL = 'https://business.facebook.com/latest/inbox';
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

// In-memory session registry
const sessions = new Map();
// Simple per-session mutex to serialize UI automation
const sessionLocks = new Map();
// Simple per-c_user mutex to prevent duplicate sessions
const cUserLocks = new Map();
// Global mutex to avoid noisy concurrent UI automation across sessions
let globalSendLock = Promise.resolve();

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

    logStep('proxy:check:meta:start', { cUser, url: INBOX_URL, timeout: PROXY_META_CHECK_TIMEOUT });
    await checkPage.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: PROXY_META_CHECK_TIMEOUT });
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
      reject(new BrowserCrashError(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

async function withSessionLock(sessionId, task) {
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  sessionLocks.set(sessionId, previous.then(() => current));

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
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
  cUserLocks.set(cUser, previous.then(() => current));

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (cUserLocks.get(cUser) === current) {
      cUserLocks.delete(cUser);
    }
  }
}

async function withGlobalSendLock(task) {
  const previous = globalSendLock;
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  globalSendLock = previous.then(() => current);

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (globalSendLock === current) {
      globalSendLock = Promise.resolve();
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

function isRecoverableCrash(error) {
  return error instanceof BrowserCrashError || isBrowserClosedError(error);
}

function setIdleTimer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  if (!config.idleTimeoutMs || config.idleTimeoutMs <= 0) return;

  session.idleTimer = setTimeout(async () => {
    try {
      await suspendSession(sessionId);
    } catch (error) {
      console.warn(`[SessionManager] Idle suspend failed for session ${sessionId}:`, error.message);
    }
  }, config.idleTimeoutMs);
}

function touchSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.lastActivity = Date.now();
  setIdleTimer(sessionId);
  sessionStore.updateStatus(sessionId, session.status || 'active', session.lastActivity);
}

async function suspendSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.activityTimer) {
    clearInterval(session.activityTimer);
    session.activityTimer = null;
  }
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

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

async function ensureSessionActive(sessionId) {
  let session = sessions.get(sessionId);
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
  }
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  if (session.page && session.context && session.browser) {
    session.status = 'active';
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
    refreshed.status = 'active';
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
  const { skipCUserCheck = false, cUserOverride = null, twofaSecret = null } = options || {};
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
    if (!skipCUserCheck) {
      const existing = sessionStore.getByCUser(finalCUser);
      if (existing && existing.sessionId !== existingSessionId) {
        logStep('createSession:exists', { cUser: finalCUser, existingSessionId: existing.sessionId });
        throw new SessionAlreadyExistsError(finalCUser, existing.sessionId);
      }
    }

    // Use existing sessionId if provided (for recreation), otherwise generate new one
    const sessionId = existingSessionId || uuidv4();
    const stored = sessionStore.getByCUser(finalCUser);
    const storedFingerprint = stored ? stored.fingerprint : sessionStore.getFingerprint(finalCUser);
    const fingerprintToUse = existingFingerprint || storedFingerprint || null;
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
      
      // Create browser instance with existing fingerprint and proxy if provided (for recreation)
      const browserInstance = await createBrowser(sessionId, fingerprintToUse, proxyConfig);
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
      setProgress(finalCUser, 'create:cookies:applied', { sessionId, format: normalized.format });

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
          });
        } catch (error) {
          throw new InvalidInputError(error.message);
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
        throw new InvalidInputError(`Session not authenticated: ${authCheck.reason}`);
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
        status: 'active',
        suspendedAt: null,
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
        status: 'active',
        lastActivity: sessionData.lastActivity,
      });

      // Save session metadata to disk (for dev mode persistence)
      // Only save if session was successfully created (we're past the error handling)
      if (config.devMode) {
        await saveSessionMetadata(sessionId, sessionData, normalized, proxyConfig, normalizedTwofaSecret);
      }

      console.log(`[SessionManager] ✓ Session created successfully: ${sessionId}`);
      console.log(`[SessionManager] Active sessions: ${sessions.size}`);
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

      if (error instanceof InvalidInputError) {
        throw error;
      }
      const message = error?.message || error?.toString() || 'unknown error';
      throw new BrowserCrashError(`Failed to create session: ${message}`);
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
  let browser = null;
  let context = null;
  let page = null;
  let activityTimer = null;

  try {
    logStep('validateCookies:start', { cUser });
    setProgress(cUser, 'validate:start');
    if (persist) {
      const existing = sessionStore.getByCUser(cUser);
      if (existing && existing.sessionId) {
        setProgress(cUser, 'validate:exists', { sessionId: existing.sessionId });
        return { ok: true, cUser, sessionId: existing.sessionId, reused: true };
      }
    }
    const storedFingerprint = sessionStore.getFingerprint(cUser);
    const browserInstance = await createBrowser(tempSessionId, storedFingerprint, proxy);
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
      });
    } catch (error) {
      throw new InvalidInputError(error.message);
    }

    const authCheck = await detectLoginOrCheckpoint(page);
    if (authCheck.blocked) {
      logStep('validateCookies:blocked', { cUser, reason: authCheck.reason });
      setProgress(cUser, 'validate:blocked', { reason: authCheck.reason });
      throw new InvalidInputError(`Session not authenticated: ${authCheck.reason}`);
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
  const normalized = normalizeCookiesInput(cookieInput);
  const incomingTwofa = String(options?.twofaSecret || '').trim();
  if (normalized.format === 'string') {
    if (!normalized.raw || !String(normalized.raw).trim()) {
      throw new InvalidInputError('Cookies are required');
    }
  }
  if (normalized.format === 'json' && (!Array.isArray(normalized.raw) || normalized.raw.length === 0)) {
    throw new InvalidInputError('Cookies are required');
  }

  let session = sessions.get(sessionId);
  if (!session) {
    const stored = sessionStore.getBySessionId(sessionId);
    if (!stored) {
      throw new SessionNotFoundError(sessionId);
    }
    logStep('updateSessionCookies:restore', { sessionId, cUser: stored.cUser });
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
  }
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  const cUser = extractCUser(normalized);
  if (!cUser) {
    throw new InvalidInputError('c_user cookie is required');
  }
  const stored = sessionStore.getBySessionId(sessionId);
  const expectedCUser = stored?.cUser || session.cUser;
  if (expectedCUser && expectedCUser !== cUser) {
    throw new InvalidInputError('c_user does not match existing session');
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
      });
    } catch (error) {
      throw new InvalidInputError(error.message);
    }
    const authCheck = await detectLoginOrCheckpoint(session.page);
    if (authCheck.blocked) {
      throw new InvalidInputError(`Session not authenticated: ${authCheck.reason}`);
    }
    try {
      await checkSessionFlow(session.page, {
        sessionId,
        cUser: session.cUser || null,
        twofaSecret,
      });
    } catch (error) {
      if (error instanceof InvalidInputError) {
        throw error;
      }
      throw new InvalidInputError(error.message);
    }
  }
  logStep('updateSessionCookies:done', { sessionId, cUser: session.cUser || cUser });

  session.cookieString = normalized.format === 'string' ? normalized.raw : null;
  session.cookieJson = normalized.format === 'json' ? normalized.raw : null;
  session.cookieFormat = normalized.format;
  session.cUser = expectedCUser || cUser;
  if (incomingTwofa) {
    session.twofaSecret = incomingTwofa;
  } else if (session.twofaSecret === undefined && stored?.twofaSecret) {
    session.twofaSecret = stored.twofaSecret;
  }
  touchSession(sessionId);

  const twofaToStore = incomingTwofa || session.twofaSecret || stored?.twofaSecret;
  if (twofaToStore) {
    sessionStore.updateCookies(sessionId, normalized.format, normalized.raw, twofaToStore);
  } else {
    sessionStore.updateCookies(sessionId, normalized.format, normalized.raw);
  }

  if (config.devMode) {
    await saveSessionMetadata(sessionId, session, normalized, session.proxy || null, twofaToStore || null);
  }
  return { ok: true };
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
    console.log(`[SessionManager] Active sessions: ${sessions.size}`);
  }
}

/**
 * Send a message using a session
 * @param {string} sessionId - Session ID
 * @param {Object} options - {extension, phoneNumber, message}
 */
export async function sendMessageForSession(sessionId, { extension, phoneNumber, message, useReplyFlow = true }) {
  return withGlobalSendLock(() =>
    withSessionLock(sessionId, async () => {
      const session = await ensureSessionActive(sessionId);
      const now = Date.now();
      const lastActivity = session.lastActivity || 0;
      const forceInitialRefresh =
        config.sendReloadIdleMs > 0 &&
        lastActivity > 0 &&
        now - lastActivity > config.sendReloadIdleMs;

      try {
        // Update last activity
        touchSession(sessionId);

        // Run automation
        await withTimeout(
          sendMessage(session.page, {
            extension,
            phoneNumber,
            message,
            sessionId,
            cUser: session.cUser || null,
            twofaSecret: session.twofaSecret || null,
            forceInitialRefresh,
            useReplyFlow,
          }),
          config.flowTimeoutMs,
          'Send flow'
        );
        return { ok: true };
      } catch (error) {
        if (isRecoverableCrash(error)) {
          try {
            await recreateSessionFromMemory(sessionId);
            const recreated = getSession(sessionId);
            recreated.lastActivity = Date.now();
            await withTimeout(
              sendMessage(recreated.page, {
                extension,
                phoneNumber,
                message,
                sessionId,
                cUser: recreated.cUser || null,
                twofaSecret: recreated.twofaSecret || null,
                forceInitialRefresh: true,
                useReplyFlow,
              }),
              config.flowTimeoutMs,
              'Send flow (retry)'
            );
            return { ok: true, retried: true };
          } catch (retryError) {
            sessions.delete(sessionId);
            throw new BrowserCrashError(`Browser crashed for session ${sessionId}: ${retryError.message}`);
          }
        }
        throw error;
      }
    })
  );
}

export async function checkSessionForSession(sessionId) {
  return withGlobalSendLock(() =>
    withSessionLock(sessionId, async () => {
      const session = await ensureSessionActive(sessionId);
      try {
        touchSession(sessionId);
        await withTimeout(
          checkSessionFlow(session.page, {
            sessionId,
            cUser: session.cUser || null,
            twofaSecret: session.twofaSecret || null,
          }),
          config.flowTimeoutMs,
          'Check flow'
        );
        return { ok: true };
      } catch (error) {
        if (isRecoverableCrash(error)) {
          try {
            await recreateSessionFromMemory(sessionId);
            const recreated = getSession(sessionId);
            recreated.lastActivity = Date.now();
            await withTimeout(
              checkSessionFlow(recreated.page, {
                sessionId,
                cUser: recreated.cUser || null,
                twofaSecret: recreated.twofaSecret || null,
              }),
              config.flowTimeoutMs,
              'Check flow (retry)'
            );
            return { ok: true, retried: true };
          } catch (retryError) {
            sessions.delete(sessionId);
            throw new BrowserCrashError(`Browser crashed for session ${sessionId}: ${retryError.message}`);
          }
        }
        throw error;
      }
    })
  );
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
  return {
    sessionId,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    status: session.page && session.context && session.browser ? 'active' : 'suspended',
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
