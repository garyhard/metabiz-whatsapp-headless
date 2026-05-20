/**
 * Browser factory for creating Playwright browser instances with unique fingerprints
 */

import { chromium } from 'playwright';
import { generateFingerprint } from '../utils/fingerprint.js';
import { config } from '../config.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function stageTimeout(promise, ms, stage, sessionId, context = null) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Browser ${stage} timed out after ${ms}ms`);
      error.stage = stage;
      error.sessionId = sessionId;
      reject(error);
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]).catch(async (error) => {
    if (context) {
      await context.close().catch(() => {});
    }
    throw error;
  });
}

/**
 * Create a browser instance with unique fingerprint and persistent context
 * @param {string} sessionId - Unique session identifier
 * @param {Object} [existingFingerprint] - Optional fingerprint to reuse (for session recreation)
 * @param {Object} [proxy] - Optional proxy configuration {server, username?, password?}
 * @returns {Promise<{browser: Browser, context: BrowserContext, page: Page, fingerprint: Object}>}
 */
export async function createBrowser(sessionId, existingFingerprint = null, proxy = null) {
  const startedAt = Date.now();
  const fingerprint = existingFingerprint || generateFingerprint();
  const userDataDir = path.join(__dirname, '../../profiles', `session-${sessionId}`);

  // Build context options
  const contextOptions = {
    viewport: fingerprint.viewport,
    locale: fingerprint.locale, // Fixed to en-SG
    timezoneId: fingerprint.timezoneId, // Fixed to Asia/Singapore
    geolocation: { latitude: 1.3521, longitude: 103.8198 },
    permissions: ['geolocation'],
    userAgent: fingerprint.userAgent,
    // Override navigator properties via CDP
    extraHTTPHeaders: {
      'Accept-Language': 'en-SG,en;q=0.9',
    },
  };

  const launchArgs = Array.isArray(config.browser.args) ? [...config.browser.args] : [];
  if (proxy && proxy.server) {
    launchArgs.push(`--proxy-server=${proxy.server}`);
    launchArgs.push('--proxy-bypass-list=<-loopback>');
  }

  // Add proxy if provided
  if (proxy && proxy.server) {
    contextOptions.proxy = {
      server: proxy.server,
    };
    if (proxy.username) {
      contextOptions.proxy.username = proxy.username;
    }
    if (proxy.password) {
      contextOptions.proxy.password = proxy.password;
    }
    const authInfo = proxy.username ? ` (auth: ${proxy.username})` : ' (no auth)';
    console.log(`[BrowserFactory] Using proxy: ${proxy.server}${authInfo}`);
  } else {
    console.log(`[BrowserFactory] No proxy configured`);
  }

  // Create persistent context with fingerprint
  console.log(`[BrowserFactory] launchPersistentContext:start session=${sessionId} timeout_ms=${config.browser.launchTimeoutMs}`);
  let context = null;
  try {
    context = await stageTimeout(
      chromium.launchPersistentContext(userDataDir, {
        headless: config.browser.headless,
        args: launchArgs,
        ignoreHTTPSErrors: true,
        timeout: config.browser.launchTimeoutMs,
        ...contextOptions,
      }),
      config.browser.launchTimeoutMs + 5000,
      'launchPersistentContext',
      sessionId
    );
    console.log(`[BrowserFactory] launchPersistentContext:ready session=${sessionId} elapsed_ms=${elapsedMs(startedAt)}`);
  } catch (error) {
    console.error(`[BrowserFactory] launchPersistentContext:error session=${sessionId} elapsed_ms=${elapsedMs(startedAt)} error=${error?.message || String(error)}`);
    throw error;
  }
  const browser = context.browser();

  // Override navigator and other properties to create unique fingerprint
  console.log(`[BrowserFactory] addInitScript:start session=${sessionId}`);
  await stageTimeout(context.addInitScript((fingerprint) => {
    // Override navigator properties
    Object.defineProperty(navigator, 'platform', {
      get: () => fingerprint.platform,
      configurable: true,
    });
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => fingerprint.hardwareConcurrency,
      configurable: true,
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => fingerprint.deviceMemory,
      configurable: true,
    });

    // Override webdriver property (common detection point)
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-SG', 'en'],
      configurable: true,
    });

    // Override plugins (make it look like a real browser)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        // Return a realistic plugins array
        return [
          {
            0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            description: 'Portable Document Format',
            filename: 'internal-pdf-viewer',
            length: 1,
            name: 'Chrome PDF Plugin',
          },
          {
            0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: '' },
            description: '',
            filename: 'internal-pdf-viewer',
            length: 1,
            name: 'Chrome PDF Viewer',
          },
          {
            0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
            1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
            description: '',
            filename: 'internal-nacl-plugin',
            length: 2,
            name: 'Native Client',
          },
        ];
      },
      configurable: true,
    });

    // Override permissions API if it exists
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(parameters);
      };
    }

    // Override chrome property (some sites check for this)
    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: {},
    };
  }, fingerprint), 10000, 'addInitScript', sessionId, context);
  console.log(`[BrowserFactory] addInitScript:ready session=${sessionId} elapsed_ms=${elapsedMs(startedAt)}`);

  // Create a new page
  console.log(`[BrowserFactory] newPage:start session=${sessionId} timeout_ms=${config.browser.newPageTimeoutMs}`);
  const page = await stageTimeout(
    context.newPage(),
    config.browser.newPageTimeoutMs,
    'newPage',
    sessionId,
    context
  );
  console.log(`[BrowserFactory] newPage:ready session=${sessionId} elapsed_ms=${elapsedMs(startedAt)}`);
  console.log(`[BrowserFactory] createBrowser:ready session=${sessionId} elapsed_ms=${elapsedMs(startedAt)}`);

  return {
    browser,
    context,
    page,
    fingerprint,
  };
}
