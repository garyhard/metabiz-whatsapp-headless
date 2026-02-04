/**
 * Session Manager - manages browser session lifecycle
 */

import { v4 as uuidv4 } from 'uuid';
import { createBrowser } from './browserFactory.js';
import { normalizeCookiesInput, parseCookieString, toPlaywrightCookies, toPlaywrightCookiesFromJson } from '../utils/cookies.js';
import { sendMessage, checkSessionFlow } from './automation.js';
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
const SESSIONS_FILE = path.join(__dirname, '../../profiles/sessions.json');
const PROFILE_ROOT = path.join(__dirname, '../../profiles');

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
      { skipCUserCheck: true, cUserOverride: stored.cUser }
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
    { skipCUserCheck: true, cUserOverride: session.cUser }
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
    { skipCUserCheck: true, cUserOverride: session.cUser }
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
      const text = (document.body?.innerText || '').toLowerCase();
      const hasLoginForm =
        !!document.querySelector('input[name="email"], input#email, input[name="pass"], #pass') ||
        !!document.querySelector('[data-testid="royal_login_form"], form[action*="login"]');
      const keywordHit =
        text.includes('log in') ||
        text.includes('login') ||
        text.includes('masuk') ||
        text.includes('kata sandi') ||
        text.includes('password') ||
        text.includes('checkpoint') ||
        text.includes('two-factor');
      return { hasLoginForm, keywordHit };
    });

    if (indicators.hasLoginForm || indicators.keywordHit) {
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
  const { skipCUserCheck = false, cUserOverride = null } = options || {};
  const finalCUser = cUserOverride || cUser;

  return withCUserLock(finalCUser, async () => {
    logStep('createSession:start', { cUser: finalCUser });
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
    const fingerprintToUse = existingFingerprint || (stored ? stored.fingerprint : null);
    let browser = null;
    let context = null;
    let page = null;
    let activityTimer = null;
    let ipAddress = null;

    try {
      logStep('createSession:browser:init', { sessionId, cUser: finalCUser });
      // Use provided proxy, or fall back to config proxy, or null
      const proxyConfig = proxy || config.proxy || null;
      
      // Create browser instance with existing fingerprint and proxy if provided (for recreation)
      const browserInstance = await createBrowser(sessionId, fingerprintToUse, proxyConfig);
      browser = browserInstance.browser;
      context = browserInstance.context;
      page = browserInstance.page;
      logStep('createSession:browser:ready', { sessionId, cUser: finalCUser });

      if (proxyConfig && proxyConfig.server) {
        ipAddress = await verifyProxyConnection(context, proxyConfig, finalCUser);
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
      logStep('createSession:cookies:applied', { sessionId, cUser: finalCUser, format: normalized.format });

      // Navigate to inbox
      console.log(`[SessionManager] Navigating to ${INBOX_URL}...`);
      await withRetry(
        () => page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
        { retries: 2, delayMs: 1000 }
      );
      logStep('createSession:navigate:done', { sessionId, cUser: finalCUser });

      // Verify we're on the right page
      const finalUrl = page.url();
      console.log(`[SessionManager] Page loaded. Final URL: ${finalUrl}`);
      if (!finalUrl.includes('business.facebook.com')) {
        console.warn(`[SessionManager] ⚠️  Warning: Expected business.facebook.com, got: ${finalUrl}`);
      }

      // Wait a bit for page to fully load
      await page.waitForTimeout(2000);
      
      // Log page title to verify it loaded correctly
      const pageTitle = await page.title();
      console.log(`[SessionManager] Page title: ${pageTitle}`);

      // Fail fast if redirected to login/checkpoint
      const authCheck = await detectLoginOrCheckpoint(page);
      if (authCheck.blocked) {
        logStep('createSession:auth:blocked', { sessionId, cUser: finalCUser, reason: authCheck.reason });
        throw new InvalidInputError(`Session not authenticated: ${authCheck.reason}`);
      }
      logStep('createSession:auth:ok', { sessionId, cUser: finalCUser });
      
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
        status: 'active',
        lastActivity: sessionData.lastActivity,
      });

      // Save session metadata to disk (for dev mode persistence)
      // Only save if session was successfully created (we're past the error handling)
      if (config.devMode) {
        await saveSessionMetadata(sessionId, sessionData, normalized, proxyConfig);
      }

      console.log(`[SessionManager] ✓ Session created successfully: ${sessionId}`);
      console.log(`[SessionManager] Active sessions: ${sessions.size}`);
      logStep('createSession:done', { sessionId, cUser: finalCUser });
      
      return {
        sessionId,
        ipAddress,
        fingerprint: browserInstance.fingerprint,
        cUser: finalCUser,
      };
    } catch (error) {
      logStep('createSession:error', { sessionId, cUser: finalCUser, error: error?.message || error?.toString() });
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
export async function validateCookies(cookieInput, proxy = null) {
  const normalized = normalizeCookiesInput(cookieInput);
  const cUser = extractCUser(normalized);
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

  const tempSessionId = `validate-${uuidv4()}`;
  let browser = null;
  let context = null;
  let page = null;

  try {
    logStep('validateCookies:start', { cUser });
    const browserInstance = await createBrowser(tempSessionId, null, proxy);
    browser = browserInstance.browser;
    context = browserInstance.context;
    page = browserInstance.page;

    if (proxy && proxy.server) {
      await verifyProxyConnection(context, proxy, cUser);
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

    await withRetry(
      () => page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }),
      { retries: 2, delayMs: 1000 }
    );
    await page.waitForTimeout(1500);

    const authCheck = await detectLoginOrCheckpoint(page);
    if (authCheck.blocked) {
      logStep('validateCookies:blocked', { cUser, reason: authCheck.reason });
      throw new InvalidInputError(`Session not authenticated: ${authCheck.reason}`);
    }

    logStep('validateCookies:ok', { cUser });
    return { ok: true, cUser };
  } catch (error) {
    logStep('validateCookies:error', { cUser, error: error?.message || error?.toString() });
    if (error instanceof InvalidInputError) {
      throw error;
    }
    throw new BrowserCrashError(`Validate cookies failed: ${error.message}`);
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await cleanupProfile(tempSessionId);
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
export async function updateSessionCookies(sessionId, cookieInput) {
  const normalized = normalizeCookiesInput(cookieInput);
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
      { skipCUserCheck: true, cUserOverride: stored.cUser }
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

  // Refresh page to ensure cookies are applied
  if (session.page) {
    try {
      await withRetry(
        () => session.page.reload({ waitUntil: 'networkidle', timeout: 30000 }),
        { retries: 2, delayMs: 1000 }
      );
    } catch (error) {
      console.warn(`[SessionManager] Cookie update reload failed: ${error.message}`);
    }
  }
  logStep('updateSessionCookies:done', { sessionId, cUser: session.cUser || cUser });

  session.cookieString = normalized.format === 'string' ? normalized.raw : null;
  session.cookieJson = normalized.format === 'json' ? normalized.raw : null;
  session.cookieFormat = normalized.format;
  session.cUser = expectedCUser || cUser;
  touchSession(sessionId);

  sessionStore.updateCookies(sessionId, normalized.format, normalized.raw);

  if (config.devMode) {
    await saveSessionMetadata(sessionId, session, normalized, session.proxy || null);
  }
  return { ok: true };
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
export async function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

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
    sessionStore.deleteSession(sessionId);
    
    // Remove from metadata file
    if (config.devMode) {
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
export async function sendMessageForSession(sessionId, { extension, phoneNumber, message }) {
  return withGlobalSendLock(() =>
    withSessionLock(sessionId, async () => {
      const session = await ensureSessionActive(sessionId);

      try {
        // Update last activity
        touchSession(sessionId);

        // Run automation
        await withTimeout(
          sendMessage(session.page, { extension, phoneNumber, message, sessionId }),
          config.flowTimeoutMs,
          'Send flow'
        );
        return { ok: true };
      } catch (error) {
        if (isBrowserClosedError(error)) {
          try {
            await recreateSessionFromMemory(sessionId);
            const recreated = getSession(sessionId);
            recreated.lastActivity = Date.now();
            await withTimeout(
              sendMessage(recreated.page, { extension, phoneNumber, message, sessionId }),
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
          checkSessionFlow(session.page, { sessionId }),
          config.flowTimeoutMs,
          'Check flow'
        );
        return { ok: true };
      } catch (error) {
        if (isBrowserClosedError(error)) {
          try {
            await recreateSessionFromMemory(sessionId);
            const recreated = getSession(sessionId);
            recreated.lastActivity = Date.now();
            await withTimeout(
              checkSessionFlow(recreated.page, { sessionId }),
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

/**
 * Save session metadata to disk
 */
async function saveSessionMetadata(sessionId, sessionData, cookieString, proxy = null) {
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
      proxyConfig
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
export async function destroyAllSessions() {
  const sessionIds = Array.from(sessions.keys());
  await Promise.all(sessionIds.map((id) => destroySession(id).catch(() => {})));
  
  // Clear metadata file in dev mode
  if (config.devMode) {
    try {
      await fs.unlink(SESSIONS_FILE).catch(() => {});
    } catch {
      // Ignore
    }
  }
}
