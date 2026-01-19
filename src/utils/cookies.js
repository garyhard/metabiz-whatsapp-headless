/**
 * Parse cookie strings from format "name=value; name2=value2"
 * Replicates the logic from background.js
 */

/**
 * Parse a cookie string like "name=value; name2=value2" into an array of {name, value} objects
 * @param {string} cookieString - Cookie string to parse
 * @returns {Array<{name: string, value: string}>} Array of cookie objects
 */
export function parseCookieString(cookieString) {
  if (!cookieString || !cookieString.trim()) {
    return [];
  }

  const cookies = [];
  const pairs = cookieString.split(';');

  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const name = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Remove quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (name) {
      cookies.push({ name, value });
    }
  }

  return cookies;
}

/**
 * Convert parsed cookies to Playwright cookie format
 * @param {Array<{name: string, value: string}>} cookies - Parsed cookies
 * @param {string} domain - Domain to set cookies for (e.g., "business.facebook.com")
 * @returns {Array} Playwright cookie format
 */
export function toPlaywrightCookies(cookies, domain = 'business.facebook.com') {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: domain.startsWith('.') ? domain : `.${domain}`,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
  }));
}

