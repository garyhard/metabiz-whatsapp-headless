/**
 * Cookie helpers
 * Supports both header cookie strings and JSON cookie arrays (e.g. Chrome export)
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

function normalizeSameSite(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeDomain(domain, hostOnly) {
  if (!domain) return null;
  const trimmed = String(domain).trim();
  if (!trimmed) return null;
  if (hostOnly) {
    return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
  }
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/**
 * Convert JSON cookies (Chrome/extension format) to Playwright cookie format
 * @param {Array<Object>} cookies - JSON cookies
 * @param {string} defaultDomain
 * @returns {Array}
 */
export function toPlaywrightCookiesFromJson(cookies, defaultDomain = 'business.facebook.com') {
  if (!Array.isArray(cookies)) return [];

  return cookies
    .map((cookie) => {
      const name = cookie?.name;
      const value = cookie?.value;
      if (!name || typeof name !== 'string') return null;
      if (value === undefined || value === null) return null;

      const domain = normalizeDomain(cookie.domain || defaultDomain, !!cookie.hostOnly);
      const path = cookie.path || '/';
      const secure = cookie.secure === undefined ? true : !!cookie.secure;
      const httpOnly = !!cookie.httpOnly;
      const sameSite = normalizeSameSite(cookie.sameSite);

      const rawExpires =
        cookie.session === true
          ? undefined
          : (cookie.expirationDate ?? cookie.expires);
      const expires = Number.isFinite(rawExpires) ? Math.floor(rawExpires) : undefined;

      return {
        name,
        value: String(value),
        domain: domain || `.${defaultDomain}`,
        path,
        secure,
        httpOnly,
        sameSite,
        ...(expires ? { expires } : {}),
      };
    })
    .filter(Boolean);
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

/**
 * Normalize input cookies (string or JSON array) into Playwright cookies
 * @param {string|Array<Object>} input
 * @returns {{format: 'string'|'json', raw: string|Array<Object>, cookies: Array}}
 */
export function normalizeCookiesInput(input) {
  if (typeof input === 'string') {
    const parsed = parseCookieString(input);
    return {
      format: 'string',
      raw: input,
      cookies: parsed,
    };
  }

  if (Array.isArray(input)) {
    return {
      format: 'json',
      raw: input,
      cookies: input,
    };
  }

  return {
    format: 'string',
    raw: '',
    cookies: [],
  };
}
