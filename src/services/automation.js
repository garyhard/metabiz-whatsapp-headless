/**
 * WhatsApp automation service - replicates the flow from content.js
 */

import { AutomationError } from '../errors.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
async function findByText(page, { text, root = null, selector = '*' }) {
  const want = normalizeText(text);

  // If root is provided and is an ElementHandle, search within it
  if (root && root.$$) {
    const elements = await root.$$(selector);
    for (const el of elements) {
      const isElVisible = await isVisible(page, el);
      if (!isElVisible) continue;

      const textContent = await page.evaluate((e) => {
        return e.textContent || e.innerText || '';
      }, el);

      const normalized = normalizeText(textContent);
      if (!normalized) continue;
      if (normalized === want || normalized.includes(want)) {
        return el;
      }
    }
  } else {
    // Search in entire page
    const elements = await page.$$(selector);
    for (const el of elements) {
      const isElVisible = await isVisible(page, el);
      if (!isElVisible) continue;

      const textContent = await page.evaluate((e) => {
        return e.textContent || e.innerText || '';
      }, el);

      const normalized = normalizeText(textContent);
      if (!normalized) continue;
      if (normalized === want || normalized.includes(want)) {
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

  // Fallback to text search
  if (!btn) {
    console.log('[Automation] Step 1: Button not found by data-surface, trying text search...');
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

  // Strategy 2: Try partial text match (case insensitive)
  if (!target) {
    console.log('[Automation] Step 2: Button not found by data-surface, trying text search...');
    const allButtons = await page.$$('[role="button"], button, div[role="button"]');
    for (const btn of allButtons) {
      if (await isVisible(page, btn)) {
        const text = await page.evaluate((el) => {
          return (el.textContent || el.innerText || '').toLowerCase();
        }, btn);
        if (text.includes('new whatsapp') || text.includes('new number')) {
          target = btn;
          console.log('[Automation] Step 2: Found button by text content:', text.substring(0, 50));
          break;
        }
      }
    }
  }

  // Strategy 3: Find by exact text match
  if (!target) {
    console.log('[Automation] Step 2: Trying exact text match...');
    target = await findByText(page, {
      text: 'New WhatsApp number',
      selector: '[role="button"],button,div[role="button"]',
    });
  }

  // Strategy 4: Search for any button containing "WhatsApp" and "new"
  if (!target) {
    console.log('[Automation] Step 2: Trying broader search...');
    const allButtons = await page.$$('[role="button"], button');
    for (const btn of allButtons) {
      if (await isVisible(page, btn)) {
        const text = await page.evaluate((el) => {
          return (el.textContent || el.innerText || '').toLowerCase();
        }, btn);
        if ((text.includes('whatsapp') || text.includes('wa')) && text.includes('new')) {
          target = btn;
          console.log('[Automation] Step 2: Found button by broader search:', text.substring(0, 50));
          break;
        }
      }
    }
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

  // Find button with text "Send Message" or "Send message"
  let btn = await findByText(page, {
    root: dialog,
    text: 'Send Message',
    selector: '[role="button"],button,div[role="button"]',
  });

  if (!btn) {
    btn = await findByText(page, {
      root: dialog,
      text: 'Send message',
      selector: '[role="button"],button,div[role="button"]',
    });
  }

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
export async function sendMessage(page, { extension, phoneNumber, message }) {
  if (!extension || !phoneNumber || !message) {
    throw new AutomationError('Missing required fields: extension, phoneNumber, message');
  }

  console.log('[Automation] ========================================');
  console.log('[Automation] Starting WhatsApp message automation');
  console.log(`[Automation] Extension: ${extension}`);
  console.log(`[Automation] Phone: ${phoneNumber}`);
  console.log(`[Automation] Message: ${message}`);
  
  // Verify we're on the right page
  const currentUrl = page.url();
  console.log(`[Automation] Current URL: ${currentUrl}`);
  if (!currentUrl.includes('business.facebook.com') || !currentUrl.includes('inbox')) {
    console.warn('[Automation] ⚠️  Warning: Not on expected inbox page!');
  }
  
  // Refresh page to ensure clean state (especially if previous automation failed)
  console.log('[Automation] Refreshing page to ensure clean state...');
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await sleep(2000); // Wait for page to fully load
  console.log('[Automation] ✓ Page refreshed');
  console.log('[Automation] ========================================');

  try {
    // Step 1: Open WhatsApp modal
    await openWhatsappModal(page);

    // Step 2: Click "New WhatsApp number"
    await clickNewWhatsappNumber(page);

    // Step 3: Select extension
    await selectExtension(page, extension);

    // Step 4: Fill phone number
    await fillPhoneNumber(page, phoneNumber);

    // Step 5: Fill message
    await fillMessage(page, message);

    // Step 6: Click Send message (screenshot will be taken, but click is disabled inside function)
    await clickSendMessage(page);

    // Give the UI a short moment for send to process
    await sleep(800);
    console.log('[Automation] ========================================');
    console.log('[Automation] ✓ Automation completed successfully');
    console.log('[Automation] ========================================');
  } catch (error) {
    console.error('[Automation] ========================================');
    console.error('[Automation] ✗ Automation failed');
    console.error(`[Automation] Error: ${error.message}`);
    
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
    if (error instanceof AutomationError) {
      throw error;
    }
    throw new AutomationError(`Automation failed: ${error.message}`, error);
  }
}

