/**
 * Session Manager - manages browser session lifecycle
 */

import { v4 as uuidv4 } from 'uuid';
import { createBrowser } from './browserFactory.js';
import { parseCookieString, toPlaywrightCookies } from '../utils/cookies.js';
import { sendMessage } from './automation.js';
import { SessionNotFoundError, InvalidInputError, BrowserCrashError } from '../errors.js';
import { config } from '../config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INBOX_URL = 'https://business.facebook.com/latest/inbox';
const SESSIONS_FILE = path.join(__dirname, '../../profiles/sessions.json');

// In-memory session registry
const sessions = new Map();

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
 * @param {string} cookieString - Cookie string in format "name=value; name2=value2"
 * @returns {Promise<string>} Session ID
 */
export async function createSession(cookieString, existingSessionId = null, existingFingerprint = null) {
  if (!cookieString || !cookieString.trim()) {
    throw new InvalidInputError('Cookies are required');
  }

  // Use existing sessionId if provided (for recreation), otherwise generate new one
  const sessionId = existingSessionId || uuidv4();
  let browser = null;
  let context = null;
  let page = null;
  let activityTimer = null;

  try {
    // Create browser instance with existing fingerprint if provided (for recreation)
    const browserInstance = await createBrowser(sessionId, existingFingerprint);
    browser = browserInstance.browser;
    context = browserInstance.context;
    page = browserInstance.page;

    // Parse and set cookies
    const cookies = parseCookieString(cookieString);
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

    // Navigate to inbox
    console.log(`[SessionManager] Navigating to ${INBOX_URL}...`);
    await page.goto(INBOX_URL, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

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

    // Start activity simulation
    activityTimer = startActivitySimulation(page, sessionId);

    // Store session
    const sessionData = {
      browser,
      context,
      page,
      activityTimer,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      fingerprint: browserInstance.fingerprint, // Save the fingerprint
    };
    sessions.set(sessionId, sessionData);

    // Save session metadata to disk (for dev mode persistence)
    // Only save if session was successfully created (we're past the error handling)
    if (config.devMode) {
      await saveSessionMetadata(sessionId, sessionData, cookieString);
    }

    console.log(`[SessionManager] ✓ Session created successfully: ${sessionId}`);
    console.log(`[SessionManager] Active sessions: ${sessions.size}`);
    
    return sessionId;
  } catch (error) {
    // Cleanup on error
    if (activityTimer) clearInterval(activityTimer);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});

    if (error instanceof InvalidInputError) {
      throw error;
    }
    throw new BrowserCrashError(`Failed to create session: ${error.message}`);
  }
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
  const session = getSession(sessionId);

  try {
    // Update last activity
    session.lastActivity = Date.now();

    // Run automation
    await sendMessage(session.page, { extension, phoneNumber, message });
  } catch (error) {
    // If browser crashed, mark session as dead
    if (
      error.message.includes('Target closed') ||
      error.message.includes('Browser closed') ||
      error.message.includes('Session closed')
    ) {
      sessions.delete(sessionId);
      throw new BrowserCrashError(`Browser crashed for session ${sessionId}`);
    }
    throw error;
  }
}

/**
 * Get all active session IDs
 * @returns {Array<string>} Array of session IDs
 */
export function getAllSessionIds() {
  return Array.from(sessions.keys());
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
    status: 'active',
  };
}

/**
 * Save session metadata to disk
 */
async function saveSessionMetadata(sessionId, sessionData, cookieString) {
  try {
    let metadata = {};
    try {
      const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
      metadata = JSON.parse(data);
    } catch {
      // File doesn't exist yet, start fresh
    }

    metadata[sessionId] = {
      sessionId,
      createdAt: sessionData.createdAt,
      lastActivity: sessionData.lastActivity,
      profilePath: `session-${sessionId}`,
      cookieString: cookieString, // Save the cookie string for reconnection
      fingerprint: sessionData.fingerprint, // Save the fingerprint for recreation
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
    if (!metadata.cookieString) {
      console.warn(`[SessionManager] No cookie string saved for session ${metadata.sessionId}, cannot recreate`);
      return null;
    }

    // Check if we have a saved fingerprint
    if (!metadata.fingerprint) {
      console.warn(`[SessionManager] No fingerprint saved for session ${metadata.sessionId}, cannot recreate`);
      return null;
    }

    console.log(`[SessionManager] Recreating session ${metadata.sessionId} with saved cookie string and fingerprint...`);
    
    // Create a new session using the saved cookie string, sessionId, and fingerprint
    const sessionId = await createSession(metadata.cookieString, metadata.sessionId, metadata.fingerprint);
    
    console.log(`[SessionManager] ✓ Successfully recreated session ${sessionId}`);
    return sessionId;
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

