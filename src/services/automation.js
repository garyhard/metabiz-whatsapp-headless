/**
 * WhatsApp automation service - replicates the flow from content.js
 */

import { AutomationError } from '../errors.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INBOX_URL = 'https://business.facebook.com/latest/inbox';
const DEBUG_DIR = path.join(__dirname, '../../profiles/debug');
const REQUEST_LOG_DIR = path.join(DEBUG_DIR, 'requests');
const RELOAD_TIMEOUT_MS = 75000;
const SPINNER_TIMEOUT_MS = 30000;

async function captureDebugScreenshot(page, label, sessionId = 'unknown') {
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
    const filename = `session-${sessionId}-${safeLabel}-${ts}.png`;
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

function isBadAuthUrl(url) {
  const value = String(url || '').toLowerCase();
  return (
    value.includes('login') ||
    value.includes('checkpoint') ||
    value.includes('recover') ||
    value.includes('twofactor')
  );
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

async function ensureOnInbox(page, label = 'Automation') {
  const url = page.url();
  if (isBadAuthUrl(url)) {
    throw new AutomationError(
      `${label}: Redirected to auth/checkpoint URL: ${url}`,
      { url }
    );
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
    const nextUrl = page.url();
    if (isBadAuthUrl(nextUrl)) {
      throw new AutomationError(
        `${label}: Redirected to auth/checkpoint URL: ${nextUrl}`,
        { url: nextUrl }
      );
    }
    if (!nextUrl.includes('business.facebook.com') || (!nextUrl.includes('inbox') && !nextUrl.includes('messages'))) {
      throw new AutomationError(`${label}: Unexpected URL after reload: ${nextUrl}`, { url: nextUrl });
    }
  }
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

async function ensureInboxReady(page, label = 'Automation') {
  await ensureOnInbox(page, label);
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
  await sleep(1000);

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
    
    if (dialogExists) {
      console.error('[Automation] Step 2: Listing all visible buttons in dialog...');
      const allButtons = await page.$$('[role="dialog"] [role="button"], [role="dialog"] button, [role="dialog"] div[role="button"], [role="dialog"] a');
      const visibleButtons = [];
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
export async function sendMessage(page, { extension, phoneNumber, message, sessionId = null, forceInitialRefresh = false }) {
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
      await ensureInboxReady(page, 'Send');
      console.log('[Automation] ✓ Page refreshed');
      logStep('send:refresh_ok', { label });
    } catch (error) {
      console.warn(`[Automation] Refresh failed: ${error.message}. Retrying...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(2000);
      await ensureInboxReady(page, 'Send');
      console.log('[Automation] ✓ Page refreshed (retry)');
      logStep('send:refresh_retry_ok', { label });
    }
  };

  const runFlow = async () => {
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
    await sleep(800);
  };

  console.log('[Automation] ========================================');
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt === 1) {
        if (forceInitialRefresh) {
          await refreshForSend('idle');
        } else {
          await ensureInboxReady(page, 'Send');
          logStep('send:ensure_ready');
        }
      } else if (attempt === 3) {
        await refreshForSend('reload retry');
      }
      await runFlow();
      console.log('[Automation] ========================================');
      console.log('[Automation] ✓ Automation completed successfully');
      console.log('[Automation] ========================================');
      logStep('send:ok', { attempt });
      await writeRequestLog(requestId, { requestId, type: 'send', steps });
      return;
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
    const debug = await captureDebugScreenshot(page, 'send', sessionId || 'unknown');
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
export async function checkSessionFlow(page, { sessionId = null } = {}) {
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
      await ensureInboxReady(page, 'Check');
      console.log('[Automation] ✓ Page refreshed');
      logStep('check:refresh_ok', { label });
    } catch (error) {
      console.warn(`[Automation] Refresh failed: ${error.message}. Retrying...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(1500);
      await ensureInboxReady(page, 'Check');
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
  const debug = await captureDebugScreenshot(page, 'check', sessionId || 'unknown');
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
