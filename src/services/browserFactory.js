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

/**
 * Create a browser instance with unique fingerprint and persistent context
 * @param {string} sessionId - Unique session identifier
 * @param {Object} [existingFingerprint] - Optional fingerprint to reuse (for session recreation)
 * @param {Object} [proxy] - Optional proxy configuration {server, username?, password?}
 * @returns {Promise<{browser: Browser, context: BrowserContext, page: Page, fingerprint: Object}>}
 */
export async function createBrowser(sessionId, existingFingerprint = null, proxy = null) {
  const fingerprint = existingFingerprint || generateFingerprint();
  const userDataDir = path.join(__dirname, '../../profiles', `session-${sessionId}`);

  // Launch browser
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: config.browser.args,
  });

  // Build context options
  const contextOptions = {
    userDataDir,
    viewport: fingerprint.viewport,
    locale: fingerprint.locale, // Fixed to en-US
    timezoneId: fingerprint.timezoneId, // Fixed to America/New_York
    userAgent: fingerprint.userAgent,
    // Override navigator properties via CDP
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };

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
  const context = await browser.newContext(contextOptions);

  // Override navigator and other properties to create unique fingerprint
  await context.addInitScript((fingerprint) => {
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
      get: () => ['en-US', 'en'],
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
  }, fingerprint);

  // Create a new page
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    fingerprint,
  };
}

