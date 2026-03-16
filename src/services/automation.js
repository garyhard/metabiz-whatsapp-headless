/**
 * WhatsApp automation service - replicates the flow from content.js
 */

import { AutomationError } from '../errors.js';
import { generateTotpCode } from '../utils/totp.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INBOX_URL = 'https://business.facebook.com/latest/inbox';
const DEBUG_DIR = path.join(__dirname, '../../profiles/debug');
const REQUEST_LOG_DIR = path.join(DEBUG_DIR, 'requests');
const RELOAD_TIMEOUT_MS = 60000;
const SPINNER_TIMEOUT_MS = 15000;
const SAVE_LOGIN_INFO_HINTS = normalizeList([
  'save login info',
  'save your login info',
  'simpan info login',
  'simpan info masuk',
]);
const NOT_NOW_LABELS = normalizeList(['not now', 'nanti', 'tidak sekarang', 'jangan sekarang', 'skip', 'lewati']);
const INBOX_DISMISS_LABELS = normalizeList(['dismiss', 'tutup', 'close']);
const CONNECT_INSTAGRAM_HINTS = normalizeList(['connect to instagram']);
const TWO_FACTOR_TEXT_HINTS = normalizeList([
  'try another way',
  'other ways to authenticate',
  'check your notifications on another device',
  'waiting for approval',
  'two-factor',
  'two factor',
  'authenticator app',
  'authentication app',
  'security code',
  'verification code',
  'kode keamanan',
  'kode verifikasi',
  "confirm you're human",
  'confirm you’re human',
  'confirm you are human',
]);
const TRY_ANOTHER_WAY_LABELS = normalizeList([
  'try another way',
  'coba cara lain',
  'cara lain',
  'metode lain',
  'opsi lain',
]);
const CONTINUE_LABELS = normalizeList([
  'continue',
  'submit',
  'next',
  'lanjut',
  'lanjutkan',
  'selanjutnya',
  'berikutnya',
]);
const TRUST_DEVICE_LABELS = normalizeList(['trust this device']);
const ALWAYS_CONFIRM_LABELS = normalizeList(["always confirm it's me", 'always confirm it’s me']);
const CODE_HINTS = normalizeList([
  'code',
  'kode',
  'otp',
  'security',
  'verification',
  'authenticator',
  'approvals_code',
]);
const AUTH_APP_LABELS = normalizeList([
  'authentication app',
  'authenticator app',
  'use authentication app',
  'aplikasi autentikasi',
  'aplikasi autentikator',
]);
const CHOOSE_METHOD_HINTS = normalizeList([
  "choose a way to confirm it's you",
  'choose a way to confirm it’s you',
  'available confirmation methods',
  'choose a way to authenticate',
  'pilih cara untuk mengonfirmasi bahwa ini anda',
  'pilih cara untuk mengonfirmasi ini anda',
  'pilih metode konfirmasi',
  'metode konfirmasi yang tersedia',
]);
const HUMAN_CONFIRM_HINTS = normalizeList([
  "confirm you're human",
  'confirm you’re human',
  'confirm you are human',
  'human to use your account',
  'human to use this account',
]);

async function dismissSaveLoginInfo(page, label = 'Automation') {
  try {
    const dialog = await findFirstVisible(page, '[role="dialog"], [aria-modal="true"]');
    const root = dialog || page;
    let dialogText = '';
    if (dialog) {
      dialogText = normalizeText(
        await page.evaluate((el) => el.textContent || el.innerText || '', dialog)
      );
    }
    if (dialog && !SAVE_LOGIN_INFO_HINTS.some((hint) => dialogText.includes(hint))) {
      return false;
    }

    const buttons = await root.$$('[role="button"], button');
    for (const btn of buttons) {
      if (!(await isVisible(page, btn))) continue;
      const matches = await elementTextMatches(page, btn, NOT_NOW_LABELS);
      if (!matches) continue;
      await btn.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
      console.log(`[${label}] Dismissed "Save login info" prompt`);
      return true;
    }
  } catch {
    // ignore dismissal errors
  }
  return false;
}

async function dismissInboxBlockingPrompts(page, label = 'Automation') {
  let dismissed = false;
  try {
    const bodyText = normalizeText(await page.evaluate(() => document.body?.innerText || ''));

    // "Connect to Instagram" card in inbox left pane.
    if (CONNECT_INSTAGRAM_HINTS.some((hint) => bodyText.includes(hint))) {
      const notNowBtn = await findByText(page, {
        text: 'Not now',
        selector: '[role="button"],button,a,[role="link"]',
      });
      if (notNowBtn) {
        await clickElement(page, notNowBtn, `${label}: dismiss connect instagram`);
        await sleep(350);
        dismissed = true;
      }
    }

    // Security notice at top of list that has a "Dismiss" link.
    const dismissLink = await findByText(page, {
      text: 'Dismiss',
      selector: 'a,[role="link"],[role="button"],button',
    });
    if (dismissLink) {
      await clickElement(page, dismissLink, `${label}: dismiss notice`);
      await sleep(250);
      dismissed = true;
    }

    // Generic fallback for localized dismiss labels.
    if (!dismissed) {
      const clickable = await page.$$('[role="button"],button,a,[role="link"]');
      for (const el of clickable) {
        if (!(await isVisible(page, el))) continue;
        const matches = await elementTextMatches(page, el, INBOX_DISMISS_LABELS);
        if (!matches) continue;
        await clickElement(page, el, `${label}: dismiss generic`);
        await sleep(250);
        dismissed = true;
        break;
      }
    }

    if (dismissed) {
      console.log(`[${label}] Dismissed inbox blocking prompt`);
    }
  } catch {
    // Ignore prompt dismissal failures
  }
  return dismissed;
}

export async function captureDebugScreenshot(page, label, cUser = 'unknown') {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    try {
      const viewport = page.viewportSize();
      if (!viewport || viewport.width < 1600) {
        await page.setViewportSize({ width: 1600, height: viewport?.height || 900 });
      }
    } catch {
      // Ignore viewport resize errors for debug screenshots
    }
    try {
      await page.addStyleTag({
        content: `
          [role="navigation"],
          [data-pagelet*="LeftRail"],
          [aria-label*="Navigation"],
          [aria-label*="Meta Business Suite"],
          [role="complementary"],
          [data-testid*="right_rail"],
          [data-pagelet*="RightRail"] {
            display: none !important;
          }
          body { overflow: hidden !important; }
        `,
      });
    } catch {
      // Ignore style injection errors for debug screenshots
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'error').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `cuser-${cUser}-${safeLabel}-${ts}.png`;
    const filePath = path.join(DEBUG_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    return { path: filePath, url: page.url() };
  } catch (error) {
    return { path: null, url: page?.url?.() || null, error: error?.message || String(error) };
  }
}

async function writeRequestLog(requestId, payload) {
  try {
    await fs.mkdir(REQUEST_LOG_DIR, { recursive: true });
    const filePath = path.join(REQUEST_LOG_DIR, `request-${requestId}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(`[Automation] Failed to write request log: ${error?.message || String(error)}`);
  }
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Normalize text for comparison
 */
function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeList(list) {
  return Array.isArray(list) ? list.map(normalizeText).filter(Boolean) : [];
}

function normalizeDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function isBadAuthUrl(url) {
  const value = String(url || '').toLowerCase();
  return (
    value.includes('login') ||
    value.includes('checkpoint') ||
    value.includes('recover') ||
    value.includes('twofactor')
  );
}

function isTwoFactorUrl(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('twofactor') || value.includes('checkpoint');
}

function isAuthRelatedError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('redirected to auth') ||
    message.includes('checkpoint') ||
    message.includes('login') ||
    message.includes('twofactor') ||
    message.includes('account restricted')
  );
}

async function clickFirstMatchingText(page, labels, { root = null, selector = '[role="button"],button,div[role],a' } = {}) {
  for (const label of labels) {
    const target = await findByText(page, { root: root || null, text: label, selector });
    if (!target) continue;
    await clickElement(page, target, `Auth: click "${label}"`);
    return true;
  }
  return false;
}

async function hasTwoFactorChallenge(page) {
  const url = page.url();
  if (isTwoFactorUrl(url)) return true;
  try {
    const text = normalizeText(await page.evaluate(() => document.body?.innerText || ''));
    return TWO_FACTOR_TEXT_HINTS.some((hint) => text.includes(hint));
  } catch {
    return false;
  }
}

async function findTwoFactorCodeInput(page) {
  const directSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="approvals_code" i]',
    'input[id*="approvals_code" i]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[inputmode="numeric"]',
    'input[aria-label*="code" i]',
    'input[aria-label*="security" i]',
    'input[aria-label*="verification" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="security" i]',
    'input[placeholder*="verification" i]',
  ];

  for (const selector of directSelectors) {
    const input = await findFirstVisible(page, selector);
    if (input) return input;
  }

  const allInputs = await page.$$('input');
  for (const input of allInputs) {
    if (!(await isVisible(page, input))) continue;
    const score = await input.evaluate((el) => {
      const id = String(el.id || '');
      const name = String(el.getAttribute('name') || '');
      const aria = String(el.getAttribute('aria-label') || '');
      const placeholder = String(el.getAttribute('placeholder') || '');
      const type = String(el.getAttribute('type') || '').toLowerCase();
      const inputMode = String(el.getAttribute('inputmode') || '').toLowerCase();
      const autoComplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
      const maxLength = Number(el.getAttribute('maxlength') || 0);
      let labelText = '';
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        labelText = String(label?.textContent || '');
      }
      return { id, name, aria, placeholder, labelText, type, inputMode, autoComplete, maxLength };
    });
    const bag = normalizeText(
      `${score.id} ${score.name} ${score.aria} ${score.placeholder} ${score.labelText}`
    );
    const textHasCode = CODE_HINTS.some((hint) => bag.includes(hint));
    const autoLooksCode =
      score.autoComplete.includes('one-time-code') ||
      score.autoComplete.includes('otp');
    const numericLooksCode = score.inputMode.includes('numeric') || score.inputMode.includes('decimal');
    const shortDigitsLike = Number.isFinite(score.maxLength) && score.maxLength > 0 && score.maxLength <= 8;
    const typeLooksCode =
      score.type === 'text' ||
      score.type === 'tel' ||
      score.type === 'number' ||
      score.type === 'password' ||
      score.type === '';
    if ((textHasCode && typeLooksCode) || autoLooksCode || (numericLooksCode && (shortDigitsLike || typeLooksCode))) {
      return input;
    }
  }
  return null;
}

async function selectAuthenticationAppMethod(page) {
  const looksLikeMethodChooserByText = await page.evaluate((hints) => {
    const text = (document.body?.innerText || '').toLowerCase();
    return hints.some((hint) => text.includes(hint));
  }, CHOOSE_METHOD_HINTS);

  let hasAuthAppOption = false;
  for (const label of AUTH_APP_LABELS) {
    const option = await findByText(page, {
      text: label,
      selector: 'label,[role="radio"],[role="button"],div,span',
    });
    if (option) {
      hasAuthAppOption = true;
      break;
    }
  }

  if (!looksLikeMethodChooserByText && !hasAuthAppOption) {
    return false;
  }

  // Click the "Authentication app" option (label/container/radio) if present.
  let selectedOption = false;
  for (const label of AUTH_APP_LABELS) {
    const option = await findByText(page, {
      text: label,
      selector: 'label,[role="radio"],[role="button"],div,span',
    });
    if (option) {
      await clickElement(page, option, `Auth: select "${label}"`);
      await sleep(300);
      selectedOption = true;
      break;
    }
  }

  const clickedContinue = await clickFirstMatchingText(page, CONTINUE_LABELS);
  if (!clickedContinue && !selectedOption) {
    return false;
  }
  await sleep(900);
  return true;
}

async function isHumanConfirmationStep(page) {
  try {
    return await page.evaluate(({ hints, continueLabels }) => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const hasHint = hints.some((hint) => text.includes(hint));
      if (!hasHint) return false;

      const clickables = Array.from(document.querySelectorAll('[role="button"],button,a,[role="link"]'));
      return clickables.some((el) => {
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }

        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();

        return continueLabels.some((continueLabel) => label === continueLabel || label.includes(continueLabel));
      });
    }, {
      hints: HUMAN_CONFIRM_HINTS,
      continueLabels: CONTINUE_LABELS,
    });
  } catch {
    return false;
  }
}

async function advanceHumanConfirmation(page, label = 'Automation') {
  let handled = false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const humanStep = await isHumanConfirmationStep(page);
    if (!humanStep) {
      break;
    }

    let continueButton = null;
    for (const continueLabel of CONTINUE_LABELS) {
      continueButton = await findByText(page, {
        text: continueLabel,
        selector: '[role="button"],button,a,[role="link"]',
      });
      if (continueButton) {
        break;
      }
    }

    if (!continueButton) {
      throw new AutomationError(`${label}: Human confirmation continue button not found`);
    }

    console.log(`[${label}] Human confirmation detected, continuing...`);
    await clickElement(page, continueButton, `${label}: human confirmation continue`);
    handled = true;

    await waitFor(
      page,
      async () => {
        if (await isHumanConfirmationStep(page)) return false;
        if (!isTwoFactorUrl(page.url())) return true;
        return (await findTwoFactorCodeInput(page)) || false;
      },
      { timeoutMs: 15000, intervalMs: 250 }
    ).catch(() => null);

    await sleep(1200);
  }

  if (handled) {
    console.log(`[${label}] Human confirmation step handled`);
  }

  return handled;
}

async function resolveTwoFactorChallenge(page, { twofaSecret = null, label = 'Automation' } = {}) {
  const challengeDetected = await hasTwoFactorChallenge(page);
  if (!challengeDetected) return false;

  console.log(`[${label}] Two-factor challenge detected, resolving via TOTP...`);

  await advanceHumanConfirmation(page, label).catch(() => false);

  if (!isTwoFactorUrl(page.url())) {
    if (!page.url().includes('business.facebook.com') || (!page.url().includes('inbox') && !page.url().includes('messages'))) {
      await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(800);
    }
    console.log(`[${label}] ✓ Two-factor challenge resolved`);
    return true;
  }

  try {
    await clickFirstMatchingText(page, TRY_ANOTHER_WAY_LABELS);
    await sleep(600);
  } catch {
    // Ignore if button not present in this challenge variant
  }

  // Some flows open a method-picker modal first: choose Authentication app then Continue.
  await selectAuthenticationAppMethod(page).catch(() => false);
  await advanceHumanConfirmation(page, label).catch(() => false);

  if (!isTwoFactorUrl(page.url())) {
    if (!page.url().includes('business.facebook.com') || (!page.url().includes('inbox') && !page.url().includes('messages'))) {
      await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(800);
    }
    console.log(`[${label}] ✓ Two-factor challenge resolved`);
    return true;
  }

  const input = await waitFor(
    page,
    async () => {
      const resolvedInput = await findTwoFactorCodeInput(page);
      if (resolvedInput) return resolvedInput;

      if (await isHumanConfirmationStep(page)) {
        await advanceHumanConfirmation(page, label).catch(() => false);
        return (await findTwoFactorCodeInput(page)) || (!isTwoFactorUrl(page.url()) ? 'resolved' : null);
      }

      if (!isTwoFactorUrl(page.url())) {
        return 'resolved';
      }

      return null;
    },
    { timeoutMs: 25000, intervalMs: 250 }
  ).catch(() => null);

  if (input === 'resolved') {
    if (!page.url().includes('business.facebook.com') || (!page.url().includes('inbox') && !page.url().includes('messages'))) {
      await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(800);
    }
    console.log(`[${label}] ✓ Two-factor challenge resolved`);
    return true;
  }

  if (!input) {
    const debug = await captureDebugScreenshot(page, 'twofa-input-not-found').catch(() => null);
    const diag = await page.evaluate(() => {
      const title = document.title || '';
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 250);
      return { title, text };
    }).catch(() => ({ title: '', text: '' }));
    console.warn(
      `[${label}] Two-factor code input not found`,
      JSON.stringify({
        url: page.url(),
        title: diag.title,
        text: diag.text,
        debugPath: debug?.path || null,
      })
    );
    throw new AutomationError(`${label}: Two-factor code input not found`);
  }

  const normalizedSecret = String(twofaSecret || '').trim();
  if (!normalizedSecret) {
    throw new AutomationError(`${label}: Two-factor challenge detected but twofaSecret is missing`);
  }

  let otp = generateTotpCode(normalizedSecret);
  if (otp.secondsRemaining <= 3) {
    await sleep((otp.secondsRemaining + 1) * 1000);
    otp = generateTotpCode(normalizedSecret);
  }

  await input.focus();
  await sleep(100);
  await setNativeValue(page, input, '');
  await sleep(100);
  await setNativeValue(page, input, otp.code);
  await sleep(300);

  const clickedContinue = await clickFirstMatchingText(page, CONTINUE_LABELS);
  if (!clickedContinue) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await sleep(1200);

  await clickFirstMatchingText(page, TRUST_DEVICE_LABELS).catch(() => false);
  await clickFirstMatchingText(page, ALWAYS_CONFIRM_LABELS).catch(() => false);
  await sleep(1200);

  await waitFor(
    page,
    async () => {
      const url = page.url();
      if (isTwoFactorUrl(url)) return false;
      if (url.includes('business.facebook.com') && (url.includes('inbox') || url.includes('messages'))) {
        return true;
      }
      return await page.evaluate(() => {
        return (
          !!document.querySelector('span[data-surface="/bizweb:all/thread_row"]') ||
          !!document.querySelector('[data-pagelet*="BizInbox"]') ||
          !!document.querySelector('[aria-label="Inbox"]')
        );
      });
    },
    { timeoutMs: 25000, intervalMs: 500 }
  ).catch(() => null);

  if (isTwoFactorUrl(page.url())) {
    throw new AutomationError(`${label}: Two-factor challenge not resolved`);
  }

  if (!page.url().includes('business.facebook.com') || (!page.url().includes('inbox') && !page.url().includes('messages'))) {
    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
    await sleep(800);
  }

  console.log(`[${label}] ✓ Two-factor challenge resolved`);
  return true;
}

export async function resolveTwoFactorIfNeeded(page, options = {}) {
  return resolveTwoFactorChallenge(page, options);
}

async function detectAccountRestricted(page, label = 'Automation') {
  try {
    const text = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
    const indicators = [
      'account restricted',
      'messaging restricted',
      "you can't send or receive messages",
      'cannot send or receive messages',
      "your account's messaging",
      'does not comply with whatsapp',
      'request a review',
    ];
    const hit = indicators.find((entry) => text.includes(entry));
    if (hit) {
      throw new AutomationError(`${label}: Account restricted detected`, { indicator: hit });
    }
  } catch (error) {
    if (error instanceof AutomationError) {
      throw error;
    }
    // Ignore detection failures
  }
}

async function ensureOnInbox(page, label = 'Automation', { twofaSecret = null } = {}) {
  let url = page.url();
  if (isBadAuthUrl(url)) {
    const resolved = await resolveTwoFactorChallenge(page, { twofaSecret, label });
    if (!resolved) {
      throw new AutomationError(
        `${label}: Redirected to auth/checkpoint URL: ${url}`,
        { url }
      );
    }
    url = page.url();
  }
  const isBusiness = url.includes('business.facebook.com');
  const isInbox = url.includes('inbox');
  const isMessages = url.includes('messages');
  if (!isBusiness || (!isInbox && !isMessages)) {
    try {
      await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
    } catch (error) {
      throw new AutomationError(`${label}: Unexpected URL after reload: ${url}`, { url });
    }
    let nextUrl = page.url();
    if (isBadAuthUrl(nextUrl)) {
      const resolved = await resolveTwoFactorChallenge(page, { twofaSecret, label });
      if (!resolved) {
        throw new AutomationError(
          `${label}: Redirected to auth/checkpoint URL: ${nextUrl}`,
          { url: nextUrl }
        );
      }
      nextUrl = page.url();
    }
    if (!nextUrl.includes('business.facebook.com') || (!nextUrl.includes('inbox') && !nextUrl.includes('messages'))) {
      throw new AutomationError(`${label}: Unexpected URL after reload: ${nextUrl}`, { url: nextUrl });
    }
  }
  await dismissSaveLoginInfo(page, label);
  await dismissInboxBlockingPrompts(page, label);
  await detectAccountRestricted(page, label);
}

async function waitForMainSpinner(page, { timeoutMs = 30000 } = {}) {
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const visible = await page.evaluate(() => {
        const spinner = document.querySelector('[role="progressbar"], [data-testid*="spinner"], [aria-label*="Loading"]');
        if (!spinner) return false;
        const style = window.getComputedStyle(spinner);
        return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });
      if (!visible) {
        return true;
      }
      await sleep(500);
    }
    return false;
  } catch {
    return false;
  }
}

async function ensureInboxReady(page, label = 'Automation', options = {}) {
  await ensureOnInbox(page, label, options);
  const spinnerOk = await waitForMainSpinner(page, { timeoutMs: SPINNER_TIMEOUT_MS });
  if (!spinnerOk) {
    throw new AutomationError(`${label}: Inbox still loading (spinner timeout)`);
  }
}

/**
 * Check if element is visible
 */
async function isVisible(page, elementHandle) {
  if (!elementHandle) return false;
  try {
    const box = await elementHandle.boundingBox();
    if (!box) return false;
    if (box.width === 0 || box.height === 0) return false;

    const visible = await page.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    }, elementHandle);

    return visible;
  } catch {
    return false;
  }
}

/**
 * Wait for a condition to be true
 */
async function waitFor(page, predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (true) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() - start > timeoutMs) {
      throw new AutomationError(`Timeout waiting (${timeoutMs}ms)`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Find first visible element matching selector
 */
async function findFirstVisible(page, selector) {
  const elements = await page.$$(selector);
  for (const el of elements) {
    if (await isVisible(page, el)) {
      return el;
    }
  }
  return null;
}

/**
 * Find element by text content
 */
async function elementTextMatches(page, el, wants) {
  const textContent = await page.evaluate((e) => {
    return {
      text: e.textContent || e.innerText || '',
      aria: e.getAttribute('aria-label') || '',
      title: e.getAttribute('title') || '',
    };
  }, el);

  const candidates = [
    normalizeText(textContent.text),
    normalizeText(textContent.aria),
    normalizeText(textContent.title),
  ].filter(Boolean);

  return candidates.some((value) => wants.some((want) => value === want || value.includes(want)));
}

async function findByText(page, { text, root = null, selector = '*' }) {
  const wants = normalizeList([text]);

  // If root is provided and is an ElementHandle, search within it
  if (root && root.$$) {
    const elements = await root.$$(selector);
    for (const el of elements) {
      const isElVisible = await isVisible(page, el);
      if (!isElVisible) continue;

      if (await elementTextMatches(page, el, wants)) {
        return el;
      }
    }
  } else {
    // Search in entire page
    const elements = await page.$$(selector);
    for (const el of elements) {
      const isElVisible = await isVisible(page, el);
      if (!isElVisible) continue;

      if (await elementTextMatches(page, el, wants)) {
        return el;
      }
    }
  }
  return null;
}

/**
 * Set native value on input element
 */
async function setNativeValue(page, elementHandle, value) {
  await elementHandle.evaluate(
    (el, val) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) {
        desc.set.call(el, val);
      } else {
        el.value = val;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
}

async function findSearchInput(page) {
  return (
    (await findFirstVisible(
      page,
      'div[data-pagelet="GenericBizInboxThreadListViewHeader"] input[role="combobox"][placeholder="Search"]'
    )) ||
    (await findFirstVisible(page, 'input[role="combobox"][placeholder="Search"]'))
  );
}

async function ensureSearchEmpty(page) {
  const input = await findSearchInput(page);
  if (!input) {
    throw new AutomationError('Search input not found');
  }
  const currentValue = await input.evaluate((el) => el.value || '');
  if (currentValue.trim() === '') {
    return;
  }
  await input.focus();
  await sleep(50);
  await setNativeValue(page, input, '');
  await sleep(100);
}

async function findThreadRowByNumber(page, digits) {
  const rows = await page.$$('span[data-surface="/bizweb:all/thread_row"]');
  for (const row of rows) {
    const text = await page.evaluate((el) => el.textContent || '', row);
    if (normalizeDigits(text).includes(digits)) {
      return row;
    }
  }
  return null;
}

async function isPeopleSectionItem(page, itemHandle) {
  try {
    return await itemHandle.evaluate((el) => {
      let node = el.parentElement;
      for (let i = 0; i < 6 && node; i += 1) {
        const heading = node.querySelector('div._ohe');
        if (heading && heading.textContent.trim().toUpperCase() === 'PEOPLE') {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function findPeopleResultByNumber(page, digits) {
  const items = await page.$$('li._7znk');
  for (const item of items) {
    const text = await page.evaluate((el) => el.textContent || '', item);
    if (normalizeDigits(text).includes(digits) && (await isPeopleSectionItem(page, item))) {
      return item;
    }
  }
  return null;
}

async function fillReplyMessage(page, message) {
  console.log('[Automation] Reply flow: waiting for reply box');
  const replyBox = await waitFor(
    page,
    async () =>
      findFirstVisible(
        page,
        'div[contenteditable="true"][role="textbox"][aria-placeholder*="Reply on WhatsApp"]'
      ),
    { timeoutMs: 8000 }
  );

  if (!replyBox) {
    throw new AutomationError('Reply input not found');
  }
  console.log('[Automation] Reply flow: reply box found');

  await replyBox.focus();
  await sleep(100);
  await replyBox.evaluate((el) => {
    el.textContent = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.keyboard.type(message, { delay: 1 });
  await sleep(50);
  await replyBox.evaluate((el) => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const currentText = await replyBox.evaluate((el) => el.textContent || '');
  console.log(`[Automation] Reply flow: reply text length=${currentText.length}`);
  await sleep(200);
  return replyBox;
}

async function findScopedReplyButton(page, replyBox) {
  if (!replyBox) return null;
  const handle = await replyBox.evaluateHandle((el) => {
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i += 1) {
      const btn =
        node.querySelector('div[role="button"][aria-label="Send"]') ||
        node.querySelector('div[role="button"][aria-label="Submit"]') ||
        node.querySelector('div[role="button"][aria-label*="Send"]');
      if (btn) return btn;
      node = node.parentElement;
    }
    return null;
  });
  return handle.asElement();
}

async function clickReplySend(page, replyBox) {
  console.log('[Automation] Reply flow: waiting for submit button');
  const button = await waitFor(
    page,
    async () => findScopedReplyButton(page, replyBox),
    { timeoutMs: 15000 }
  ).catch(() => null);
  if (!button) {
    throw new AutomationError('Reply submit button not found');
  }
  console.log('[Automation] Reply flow: submit button found');
  await clickElement(page, button, 'Reply: Submit');
}

async function tryReplyFlow(page, { phoneDigits, message, twofaSecret = null }) {
  try {
    console.log(`[Automation] Reply flow: start for ${phoneDigits}`);
    console.log(`[Automation] Reply flow: url=${page.url()}`);
    await ensureInboxReady(page, 'Reply', { twofaSecret });
    await dismissInboxBlockingPrompts(page, 'Reply');
    await ensureSearchEmpty(page);

    await waitFor(
      page,
      async () => {
        const rows = await page.$$('span[data-surface="/bizweb:all/thread_row"]');
        return rows.length > 0;
      },
      { timeoutMs: 2000 }
    ).catch(() => null);

    const row = await findThreadRowByNumber(page, phoneDigits);
    if (row) {
      console.log('[Automation] Reply flow: found thread row');
      await clickElement(page, row, 'Reply: Open thread row');
      await sleep(400);
      const replyBox = await fillReplyMessage(page, message);
      await clickReplySend(page, replyBox);
      console.log('[Automation] Reply flow: sent via thread row');
      return true;
    }

    const searchInput = await findSearchInput(page);
    if (!searchInput) {
      console.warn('[Automation] Reply flow: search input not found');
      return false;
    }

    await setNativeValue(page, searchInput, phoneDigits);
    await sleep(400);

    const peopleItem = await waitFor(
      page,
      async () => findPeopleResultByNumber(page, phoneDigits),
      { timeoutMs: 3000 }
    ).catch(() => null);

    if (peopleItem) {
      console.log('[Automation] Reply flow: found people result');
      await clickElement(page, peopleItem, 'Reply: Open people result');
      await sleep(400);
      const replyBox = await fillReplyMessage(page, message);
      await clickReplySend(page, replyBox);
      console.log('[Automation] Reply flow: sent via people result');
      return true;
    }

    console.warn('[Automation] Reply flow: no matching thread/people result');
    await ensureSearchEmpty(page);
    return false;
  } catch (error) {
    if (isAuthRelatedError(error)) {
      throw error;
    }
    console.warn(`[Automation] Reply flow failed, falling back: ${error?.message || error}`);
    return false;
  }
}

/**
 * Click element with proper events and error handling
 */
async function clickElement(page, elementHandle, stepName = 'click') {
  if (!elementHandle) {
    throw new AutomationError(`${stepName}: click() target missing`);
  }

  try {
    // Scroll into view
    await elementHandle.scrollIntoViewIfNeeded();
    await sleep(200);

    // Remove any overlays that might intercept clicks
    await page.evaluate(() => {
      // Remove elements with data-visualcompletion="ignore" that might overlay
      const overlays = document.querySelectorAll('[data-visualcompletion="ignore"]');
      overlays.forEach(overlay => {
        const style = window.getComputedStyle(overlay);
        if (style.pointerEvents === 'auto' || style.pointerEvents === '') {
          overlay.style.pointerEvents = 'none';
        }
      });
    });

    // Try JavaScript click first (most reliable, bypasses all interception)
    try {
      // Use elementHandle.evaluate() instead of page.evaluate() to avoid argument issues
      await elementHandle.evaluate((el) => {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Dispatch all mouse events
        const events = ['mousedown', 'mouseup', 'click'];
        events.forEach(eventType => {
          const event = new MouseEvent(eventType, {
            view: window,
            bubbles: true,
            cancelable: true,
            buttons: 1
          });
          el.dispatchEvent(event);
        });
      });
      console.log(`[Automation] ${stepName}: Clicked using JavaScript click`);
      await sleep(300);
      return; // Success, exit early
    } catch (jsError) {
      console.log(`[Automation] ${stepName}: JavaScript click failed, trying Playwright click...`);
    }

    // Fallback: Try Playwright click with force
    try {
      await elementHandle.click({ force: true, timeout: 3000 });
      console.log(`[Automation] ${stepName}: Clicked using force click`);
    } catch (forceError) {
      // Last resort: Regular click
      await elementHandle.click({ timeout: 5000 });
      console.log(`[Automation] ${stepName}: Clicked using regular click`);
    }
  } catch (error) {
    throw new AutomationError(`${stepName}: Failed to click element - ${error.message}`);
  }
}

/**
 * Open WhatsApp modal
 */
async function openWhatsappModal(page) {
  console.log('[Automation] Step 1: Opening WhatsApp modal...');
  
  // Try data-surface attribute first
  let btn = await findFirstVisible(
    page,
    'div[role="button"][data-surface*="whatsapp_biz_init_thread_header_button"]'
  );

  // Fallback to exact text search
  if (!btn) {
    console.log('[Automation] Step 1: Button not found by data-surface, trying exact text...');
    btn = await findByText(page, {
      text: 'Send a Message on WhatsApp',
      selector: '[role="button"],button,div[role],a',
    });
  }

  if (!btn) {
    throw new AutomationError('Step 1: Could not find "Send a Message on WhatsApp" button');
  }

  console.log('[Automation] Step 1: Found button, clicking...');
  await clickElement(page, btn, 'Step 1: Open WhatsApp modal');

  // Wait for dialog to appear
  console.log('[Automation] Step 1: Waiting for dialog to appear...');
  await waitFor(
    page,
    async () => {
      const dialog = await findFirstVisible(page, '[role="dialog"]');
      return dialog !== null;
    },
    { timeoutMs: 15000 }
  );
  console.log('[Automation] Step 1: ✓ WhatsApp modal opened successfully');
}

/**
 * Click "New WhatsApp number" button
 */
async function clickNewWhatsappNumber(page) {
  console.log('[Automation] Step 2: Clicking "New WhatsApp number" button...');
  
  // Wait for dialog to be fully loaded
  const dialog = await waitFor(
    page,
    async () => findFirstVisible(page, '[role="dialog"]'),
    { timeoutMs: 15000 }
  );

  if (!dialog) {
    throw new AutomationError('Step 2: Dialog not found');
  }

  console.log('[Automation] Step 2: Dialog found, waiting for content to load...');
  
  // Wait longer for dialog content to fully render
  await sleep(300);

  // Wait for any buttons to appear in the dialog
  await waitFor(
    page,
    async () => {
      const buttons = await page.$$('[role="dialog"] [role="button"], [role="dialog"] button');
      return buttons.length > 0;
    },
    { timeoutMs: 10000 }
  );

  console.log('[Automation] Step 2: Dialog content loaded, searching for button...');

  // Strategy 1: Use data-surface attribute (most reliable)
  let target = await findFirstVisible(
    page,
    'div[role="button"][data-surface*="business-initiate-thread-search-contacts-button"]'
  );

  if (target) {
    console.log('[Automation] Step 2: Found button by data-surface attribute');
  }

  // Strategy 2: Find by exact text match
  if (!target) {
    console.log('[Automation] Step 2: Trying exact text...');
    target = await findByText(page, {
      text: 'New WhatsApp number',
      selector: '[role="button"],button,div[role="button"]',
    });
  }

  // Debug: Log what buttons we can see
  if (!target) {
    console.error('[Automation] Step 2: ========== DEBUG INFO ==========');
    console.error('[Automation] Step 2: Button not found! Gathering debug information...');
    
    // Log page title and URL first
    const pageInfo = await page.evaluate(() => ({
      title: document.title,
      url: window.location.href,
    }));
    console.error('[Automation] Step 2: Page info:', JSON.stringify(pageInfo, null, 2));
    
    // Check if dialog exists
    const dialogExists = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
    console.error('[Automation] Step 2: Dialog exists:', dialogExists);
    
    let visibleButtons = [];
    if (dialogExists) {
      console.error('[Automation] Step 2: Listing all visible buttons in dialog...');
      const allButtons = await page.$$('[role="dialog"] [role="button"], [role="dialog"] button, [role="dialog"] div[role="button"], [role="dialog"] a');
      for (const btn of allButtons) {
        if (await isVisible(page, btn)) {
          const btnInfo = await page.evaluate((el) => {
            return {
              text: (el.textContent || el.innerText || '').trim(),
              dataSurface: el.getAttribute('data-surface') || '',
              role: el.getAttribute('role') || '',
              className: el.className || '',
              id: el.id || '',
              tagName: el.tagName || '',
            };
          }, btn);
          if (btnInfo.text || btnInfo.dataSurface) {
            visibleButtons.push(btnInfo);
          }
        }
      }
      console.error('[Automation] Step 2: Visible buttons found (' + visibleButtons.length + '):');
      console.error(JSON.stringify(visibleButtons.slice(0, 20), null, 2));
      
      // Also log all text content in dialog
      const dialogText = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return 'No dialog';
        return (dialog.textContent || dialog.innerText || '').substring(0, 500);
      });
      console.error('[Automation] Step 2: Dialog text content (first 500 chars):', dialogText);
      
      // Log dialog HTML structure (first 3000 chars)
      try {
      } catch (e) {
      }
    } else {
      console.error('[Automation] Step 2: ERROR - No dialog found on page!');
    }
    
    console.error('[Automation] Step 2: ====================================');
    
    // Build error message with summary
    let errorMsg = 'Step 2: Could not find "New WhatsApp number" button. ';
    if (dialogExists) {
      errorMsg += `Found ${visibleButtons.length} visible button(s) in dialog. Check server console logs for details.`;
    } else {
      errorMsg += 'Dialog not found on page. Check server console logs for page state.';
    }
    throw new AutomationError(errorMsg);
  }

  console.log('[Automation] Step 2: Found button, clicking...');
  await clickElement(page, target, 'Step 2: New WhatsApp number');
  await sleep(1000); // Wait longer for form to appear
  console.log('[Automation] Step 2: ✓ "New WhatsApp number" clicked successfully');
}

/**
 * Select extension from dropdown
 */
async function selectExtension(page, extension) {
  console.log(`[Automation] Step 3: Selecting extension "${extension}"...`);
  
  const dialog = await waitFor(
    page,
    async () => findFirstVisible(page, '[role="dialog"]'),
    { timeoutMs: 15000 }
  );

  if (!dialog) {
    throw new AutomationError('Step 3: Dialog not found');
  }

  await sleep(500);

  // Find the extension dropdown combobox (shows country code like "US +1")
  const allCombos = await dialog.$$('[role="combobox"][aria-haspopup="listbox"]');
  let comboContainer = null;
  
  for (const combo of allCombos) {
    if (await isVisible(page, combo)) {
      const text = await combo.evaluate((el) => (el.textContent || el.innerText || '').trim());
      if (text.includes('+')) {
        comboContainer = combo;
        break;
      }
    }
  }

  if (!comboContainer) {
    throw new AutomationError('Step 3: Could not find extension dropdown in dialog');
  }

  const isExpanded = await comboContainer.evaluate(
    (el) => el.getAttribute('aria-expanded') === 'true'
  );

  if (!isExpanded) {
    await comboContainer.focus();
    await sleep(100);
    await comboContainer.click({ timeout: 3000 });
    await sleep(300);

    await waitFor(
      page,
      async () => {
        const expanded = await comboContainer.evaluate(
          (el) => el.getAttribute('aria-expanded') === 'true'
        );
        if (!expanded) return false;
        
        const contextualLayer = await page.$('[data-testid="ContextualLayerRoot"]');
        if (!contextualLayer) return false;
        
        const searchInput = await contextualLayer.$('input[role="combobox"][type="text"]');
        if (!searchInput) return false;
        
        return await isVisible(page, searchInput) && await isVisible(page, contextualLayer);
      },
      { timeoutMs: 10000, intervalMs: 200 }
    );
    await sleep(600);
  }

  // Find the search input inside the expanded dropdown's ContextualLayerRoot
  // Must have aria-expanded="true" to distinguish from other inputs
  const searchInput = await waitFor(
    page,
    async () => {
      const contextualLayers = await page.$$('[data-testid="ContextualLayerRoot"]');
      
      for (const layer of contextualLayers) {
        if (await isVisible(page, layer)) {
          const input = await layer.$('input[role="combobox"][type="text"]');
          if (input && await isVisible(page, input)) {
            const ariaExpanded = await input.evaluate((el) => el.getAttribute('aria-expanded'));
            const ariaControls = await input.evaluate((el) => el.getAttribute('aria-controls'));
            
            if (ariaExpanded === 'true' && ariaControls) {
              return input;
            }
          }
        }
      }
      return null;
    },
    { timeoutMs: 8000, intervalMs: 200 }
  );

  if (!searchInput) {
    throw new AutomationError('Step 3: Could not find extension search input after opening dropdown');
  }

  // Type the extension into the search input
  const wantDigits = extension.replace(/^\+/, '').trim();
  await searchInput.focus();
  await sleep(100);
  await setNativeValue(page, searchInput, '');
  await sleep(100);
  await setNativeValue(page, searchInput, wantDigits);
  await sleep(800);

  const controlsId = await searchInput.evaluate((el) => el.getAttribute('aria-controls'));
  if (!controlsId) {
    throw new AutomationError('Search input has no aria-controls attribute');
  }

  // Find the listbox by ID from aria-controls
  const listbox = await waitFor(
    page,
    async () => {
      const listboxById = await page.$(`#${controlsId}`);
      if (listboxById && await isVisible(page, listboxById)) {
        const options = await listboxById.$$('[role="option"]');
        if (options.length > 0) {
          const firstOptionText = await options[0].evaluate((el) => 
            (el.textContent || el.innerText || '').trim()
          );
          if (firstOptionText && firstOptionText.includes('+')) {
            return listboxById;
          }
        }
      }
      return null;
    },
    { timeoutMs: 10000, intervalMs: 300 }
  );

  if (!listbox) {
    throw new AutomationError(`Step 3: Could not find listbox with id="${controlsId}" after typing extension`);
  }

  const options = await listbox.$$('[role="option"]');
  if (options.length === 0) {
    throw new AutomationError('Step 3: No options found in listbox after filtering');
  }

  await options[0].scrollIntoViewIfNeeded();
  await sleep(200);
  await clickElement(page, options[0], 'Step 3: Select extension option');
  await sleep(400);
}

/**
 * Fill phone number
 */
async function fillPhoneNumber(page, phone) {
  console.log(`[Automation] Step 4: Filling phone number "${phone}"...`);
  
  const dialog = await waitFor(
    page,
    async () => findFirstVisible(page, '[role="dialog"]'),
    { timeoutMs: 15000 }
  );

  if (!dialog) {
    throw new AutomationError('Step 4: Dialog not found');
  }

  // Wait for form inputs to appear
  await waitFor(
    page,
    async () => {
      const inputs = await dialog.$$('input');
      const visibleInputs = [];
      for (const input of inputs) {
        if (await isVisible(page, input)) {
          visibleInputs.push(input);
        }
      }
      return visibleInputs.length > 0;
    },
    { timeoutMs: 10000 }
  );

  // Find phone input - most precise: any visible tel-type input in dialog
  let input = await findFirstVisible(page, 'input[type="tel"],input[inputmode="tel"]');

  // Fallback: last visible input in page (phone usually comes after extension)
  if (!input) {
    const allInputs = await page.$$('input');
    const visibleInputs = [];
    for (const inp of allInputs) {
      if (await isVisible(page, inp)) {
        visibleInputs.push(inp);
      }
    }
    if (visibleInputs.length > 0) {
      input = visibleInputs[visibleInputs.length - 1];
    }
  }

  if (!input) {
    throw new AutomationError('Could not find phone input in dialog');
  }

  await setNativeValue(page, input, phone);
  await sleep(200);
  console.log(`[Automation] Step 4: ✓ Phone number filled successfully`);
}

/**
 * Fill message
 */
async function fillMessage(page, message) {
  console.log(`[Automation] Step 5: Filling message...`);
  
  const dialog = await waitFor(
    page,
    async () => findFirstVisible(page, '[role="dialog"]'),
    { timeoutMs: 15000 }
  );

  if (!dialog) {
    throw new AutomationError('Step 5: Dialog not found');
  }

  // Wait for message input to appear
  await waitFor(
    page,
    async () => {
      const textarea = await findFirstVisible(page, 'textarea');
      const editable = await findFirstVisible(page, '[contenteditable="true"]');
      return textarea !== null || editable !== null;
    },
    { timeoutMs: 10000 }
  );

  // Try textarea first
  const textarea = await findFirstVisible(page, 'textarea');
  if (textarea) {
    console.log('[Automation] Step 5: Found textarea, filling...');
    await setNativeValue(page, textarea, message);
    await sleep(200);
    console.log('[Automation] Step 5: ✓ Message filled successfully (textarea)');
    return;
  }

  // Some Meta inputs use contenteditable divs
  const editable = await findFirstVisible(page, '[contenteditable="true"]');
  if (!editable) {
    throw new AutomationError('Step 5: Could not find message input (textarea or contenteditable)');
  }

  console.log('[Automation] Step 5: Found contenteditable, filling...');
  await editable.focus();
  await sleep(100);
  await page.evaluate(
    (el, msg) => {
      el.textContent = msg;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    editable,
    message
  );
  await sleep(200);
  console.log('[Automation] Step 5: ✓ Message filled successfully (contenteditable)');
}

/**
 * Click Send Message button
 */
async function clickSendMessage(page) {
  console.log('[Automation] Step 6: Clicking "Send Message" button...');
  
  const dialog = await waitFor(
    page,
    async () => findFirstVisible(page, '[role="dialog"]'),
    { timeoutMs: 15000 }
  );

  if (!dialog) {
    throw new AutomationError('Step 6: Dialog not found');
  }

  // Find button with exact text
  const btn = await findByText(page, {
    root: dialog,
    text: 'Send Message',
    selector: '[role="button"],button,div[role="button"]',
  });

  // If we matched the inner label div, climb to its button container
  if (btn) {
    const role = await page.evaluate((el) => el.getAttribute('role'), btn);
    if (role !== 'button') {
      const parentBtnHandle = await page.evaluateHandle((el) => {
        return el.closest('[role="button"]');
      }, btn);
      const parentBtn = await parentBtnHandle.asElement();
      if (parentBtn) {
        btn = parentBtn;
      }
    }
  }

  if (!btn) {
    throw new AutomationError('Step 6: Could not find "Send message" button');
  }

  console.log('[Automation] Step 6: Found button, clicking...');
  
  await sleep(100);
  await clickElement(page, btn, 'Step 6: Send Message');
  console.log('[Automation] Step 6: ✓ "Send Message" button clicked');
}

/**
 * Main automation flow - send WhatsApp message
 * @param {Page} page - Playwright page instance
 * @param {Object} options - {extension, phoneNumber, message}
 */
export async function sendMessage(
  page,
  {
    extension,
    phoneNumber,
    message,
    sessionId = null,
    cUser = null,
    twofaSecret = null,
    forceInitialRefresh = false,
    useReplyFlow = true,
    includeSuccessScreenshot = false,
  }
) {
  if (!extension || !phoneNumber || !message) {
    throw new AutomationError('Missing required fields: extension, phoneNumber, message');
  }

  const requestId = `${sessionId || 'unknown'}-${Date.now()}`;
  const steps = [];
  const logStep = (label, extra = {}) => {
    steps.push({ at: new Date().toISOString(), label, ...extra });
  };

  console.log('[Automation] ========================================');
  console.log('[Automation] Starting WhatsApp message automation');
  console.log(`[Automation] Extension: ${extension}`);
  console.log(`[Automation] Phone: ${phoneNumber}`);
  console.log(`[Automation] Message: ${message}`);
  logStep('send:start', { sessionId, extension, phoneNumber });
  
  // Verify we're on the right page
  const currentUrl = page.url();
  console.log(`[Automation] Current URL: ${currentUrl}`);
  if (!currentUrl.includes('business.facebook.com') || !currentUrl.includes('inbox')) {
    console.warn('[Automation] ⚠️  Warning: Not on expected inbox page!');
  }
  logStep('send:current_url', { url: currentUrl });
  
  const maxAttempts = 3;
  const backoffMs = [2000, 5000, 10000];
  const retryableMessage = 'Step 1: Could not find "Send a Message on WhatsApp" button';
  const shouldRetry = (error) =>
    error instanceof AutomationError && !isAuthRelatedError(error);

  const refreshForSend = async (label) => {
    console.log(`[Automation] Refreshing page to ensure clean state${label ? ` (${label})` : ''}...`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(2000); // Wait for page to fully load
      await ensureInboxReady(page, 'Send', { twofaSecret });
      console.log('[Automation] ✓ Page refreshed');
      logStep('send:refresh_ok', { label });
    } catch (error) {
      console.warn(`[Automation] Refresh failed: ${error.message}. Retrying...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(2000);
      await ensureInboxReady(page, 'Send', { twofaSecret });
      console.log('[Automation] ✓ Page refreshed (retry)');
      logStep('send:refresh_retry_ok', { label });
    }
  };

  const runFlow = async () => {
    if (useReplyFlow) {
      const phoneDigits = normalizeDigits(`${extension}${phoneNumber}`);
      const replied = await tryReplyFlow(page, { phoneDigits, message, twofaSecret });
      if (replied) {
        logStep('send:reply_flow', { phoneDigits });
        return;
      }
    }

    // Step 1: Open WhatsApp modal
    await openWhatsappModal(page);
    logStep('send:open_modal');

    // Step 2: Click "New WhatsApp number"
    await clickNewWhatsappNumber(page);
    logStep('send:new_number');

    // Step 3: Select extension
    await selectExtension(page, extension);
    logStep('send:select_extension');

    // Step 4: Fill phone number
    await fillPhoneNumber(page, phoneNumber);
    logStep('send:fill_phone');

    // Step 5: Fill message
    await fillMessage(page, message);
    logStep('send:fill_message');

    // Step 6: Click Send message (screenshot will be taken, but click is disabled inside function)
    await clickSendMessage(page);
    logStep('send:click_send');

    // Give the UI a short moment for send to process
    await sleep(200);
  };

  console.log('[Automation] ========================================');
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt === 1) {
        if (forceInitialRefresh) {
          await refreshForSend('idle');
        } else {
          await ensureInboxReady(page, 'Send', { twofaSecret });
          logStep('send:ensure_ready');
        }
      } else if (attempt === 3) {
        await refreshForSend('reload retry');
      }
      await runFlow();
      console.log('[Automation] ========================================');
      console.log('[Automation] ✓ Automation completed successfully');
      console.log('[Automation] ========================================');
      let successScreenshot = null;
      if (includeSuccessScreenshot) {
        const debug = await captureDebugScreenshot(page, 'send-success', cUser || 'unknown');
        successScreenshot = {
          path: debug.path || null,
          url: debug.url || null,
          filename: debug.path ? path.basename(debug.path) : null,
        };
      }
      logStep('send:ok', { attempt });
      await writeRequestLog(requestId, {
        requestId,
        type: 'send',
        steps,
        screenshotPath: successScreenshot?.path || null,
        url: successScreenshot?.url || null,
      });
      return {
        ok: true,
        screenshot: successScreenshot,
      };
    } catch (error) {
      lastError = error;
      logStep('send:error', { attempt, error: error?.message || String(error) });
      if (shouldRetry(error) && attempt < maxAttempts) {
        const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
        console.warn(
          `[Automation] Retryable error detected (${error.message}). Retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})...`
        );
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  if (lastError) {
    console.error('[Automation] ========================================');
    console.error('[Automation] ✗ Automation failed');
    console.error(`[Automation] Error: ${lastError.message}`);
    
    // Log page state on failure
    try {
      const pageState = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        hasDialog: !!document.querySelector('[role="dialog"]'),
        dialogCount: document.querySelectorAll('[role="dialog"]').length,
        visibleButtons: Array.from(document.querySelectorAll('[role="button"], button')).filter(btn => {
          const style = window.getComputedStyle(btn);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }).length,
      }));
      console.error('[Automation] Page state on failure:', JSON.stringify(pageState, null, 2));
      
    } catch (stateError) {
      console.error('[Automation] Could not get page state:', stateError.message);
    }
    
    console.error('[Automation] ========================================');
  const debug = await captureDebugScreenshot(page, 'send', cUser || 'unknown');
    await writeRequestLog(requestId, {
      requestId,
      type: 'send',
      steps,
      error: lastError.message,
      screenshotPath: debug.path,
      url: debug.url,
    });
    if (lastError instanceof AutomationError) {
      if (!lastError.details) {
        lastError.details = { url: debug.url, screenshotPath: debug.path };
      }
      throw lastError;
    }
    throw new AutomationError(`Automation failed: ${lastError.message}`, {
      url: debug.url,
      screenshotPath: debug.path,
      cause: lastError,
    });
  }
}

/**
 * Lightweight UI check to validate session can open WhatsApp flow
 * @param {Page} page - Playwright page instance
 */
export async function checkSessionFlow(page, { sessionId = null, cUser = null, twofaSecret = null } = {}) {
  console.log('[Automation] ========================================');
  console.log('[Automation] Starting WhatsApp session check');
  console.log(`[Automation] Current URL: ${page.url()}`);

  const requestId = `${sessionId || 'unknown'}-${Date.now()}`;
  const steps = [];
  const logStep = (label, extra = {}) => {
    steps.push({ at: new Date().toISOString(), label, ...extra });
  };
  logStep('check:start', { sessionId });

  const maxAttempts = 3;
  const backoffMs = [2000, 5000, 10000];
  const shouldRetry = (error) =>
    error instanceof AutomationError && !isAuthRelatedError(error);

  const refreshForCheck = async (label) => {
    console.log(`[Automation] Refreshing page for check${label ? ` (${label})` : ''}...`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(1500);
      await ensureInboxReady(page, 'Check', { twofaSecret });
      console.log('[Automation] ✓ Page refreshed');
      logStep('check:refresh_ok', { label });
    } catch (error) {
      console.warn(`[Automation] Refresh failed: ${error.message}. Retrying...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(1500);
      await ensureInboxReady(page, 'Check', { twofaSecret });
      console.log('[Automation] ✓ Page refreshed (retry)');
      logStep('check:refresh_retry_ok', { label });
    }
  };

  const runCheck = async () => {
    // Step 1: Open WhatsApp modal
    await openWhatsappModal(page);
    logStep('check:open_modal');

    // Step 2: Click "New WhatsApp number"
    await clickNewWhatsappNumber(page);
    logStep('check:new_number');

    // Step 3: Ensure extension combobox exists
    const dialog = await waitFor(
      page,
      async () => findFirstVisible(page, '[role="dialog"]'),
      { timeoutMs: 10000 }
    );
    if (!dialog) {
      throw new AutomationError('Check: Dialog not found');
    }
    logStep('check:dialog_ok');

    const combo = await findFirstVisible(page, '[role="dialog"] [role="combobox"][aria-haspopup="listbox"]');
    if (!combo) {
      throw new AutomationError('Check: Extension dropdown not found');
    }
    logStep('check:combo_ok');

    // Step 4: Ensure phone input exists
    const phoneInput = await findFirstVisible(page, 'input[type="tel"],input[inputmode="tel"]');
    if (!phoneInput) {
      throw new AutomationError('Check: Phone input not found');
    }
    logStep('check:phone_ok');

    // Step 5: Ensure message input exists
    const textarea = await findFirstVisible(page, 'textarea');
    const editable = await findFirstVisible(page, '[contenteditable="true"]');
    if (!textarea && !editable) {
      throw new AutomationError('Check: Message input not found');
    }
    logStep('check:message_ok');

    // Close dialog
    try {
      await page.keyboard.press('Escape');
      await sleep(300);
    } catch {
      // Ignore close failures
    }
  };

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt === 1) {
        await refreshForCheck('initial');
      } else if (attempt === 3) {
        await refreshForCheck('reload retry');
      } else {
        await refreshForCheck();
      }
      await runCheck();
      console.log('[Automation] ✓ Session check completed successfully');
      console.log('[Automation] ========================================');
      logStep('check:ok', { attempt });
      await writeRequestLog(requestId, { requestId, type: 'check', steps });
      return true;
    } catch (error) {
      lastError = error;
      logStep('check:error', { attempt, error: error?.message || String(error) });
      if (shouldRetry(error) && attempt < maxAttempts) {
        const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
        console.warn(
          `[Automation] Retryable check error (${error.message}). Retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})...`
        );
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  console.error('[Automation] ========================================');
  console.error('[Automation] ✗ Session check failed');
  console.error(`[Automation] Error: ${lastError?.message || 'unknown error'}`);
  console.error('[Automation] ========================================');
  const debug = await captureDebugScreenshot(page, 'check', cUser || 'unknown');
  await writeRequestLog(requestId, {
    requestId,
    type: 'check',
    steps,
    error: lastError?.message || 'unknown error',
    screenshotPath: debug.path,
    url: debug.url,
  });
  if (lastError instanceof AutomationError) {
    if (!lastError.details) {
      lastError.details = { url: debug.url, screenshotPath: debug.path };
    }
    throw lastError;
  }
  throw new AutomationError(
    `Session check failed: ${lastError?.message || 'unknown error'}`,
    { url: debug.url, screenshotPath: debug.path, cause: lastError }
  );
}
