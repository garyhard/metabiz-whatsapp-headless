/**
 * WhatsApp automation service - replicates the flow from content.js
 */

import { AutomationError } from '../errors.js';
import { config } from '../config.js';
import { generateTotpCode } from '../utils/totp.js';
import { easyOCR, isOcrConfigured } from '../utils/ocr.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INBOX_URL = 'https://business.facebook.com/latest/inbox';
const DEBUG_DIR = path.join(__dirname, '../../profiles/debug');
const REQUEST_LOG_DIR = path.join(DEBUG_DIR, 'requests');
const CAPTCHA_DIR = path.join(DEBUG_DIR, 'captcha');
const RELOAD_TIMEOUT_MS = 60000;
const SPINNER_TIMEOUT_MS = 15000;
const SAVE_LOGIN_INFO_HINTS = normalizeList([
  'save login info',
  'save your login info',
  'simpan info login',
  'simpan info masuk',
]);
const NOT_NOW_LABELS = normalizeList(['not now', 'nanti', 'tidak sekarang', 'jangan sekarang', 'skip', 'lewati']);
const INBOX_DISMISS_LABELS = normalizeList(['dismiss', 'tutup', 'close', 'abaikan']);
const AUTOMATED_BEHAVIOR_NOTICE_HINTS = normalizeList([
  'we suspect automated behavior on your account',
  'to prevent your account from being temporarily restricted or permanently disabled',
  'make sure that no other users or tools have access to your account',
]);
const AUTOMATED_BEHAVIOR_DISMISS_LABELS = normalizeList(['dismiss']);
const CONNECT_INSTAGRAM_HINTS = normalizeList(['connect to instagram', 'hubungkan ke instagram']);
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
  'coba cara lain',
  'cara lain untuk mengautentikasi',
  'periksa notifikasi anda di perangkat lain',
  'menunggu persetujuan',
  'aplikasi autentikasi',
  'konfirmasikan bahwa anda adalah manusia',
  'konfirmasikan bahwa anda adalah manusia untuk menggunakan akun anda',
  'manusia untuk menggunakan akun anda',
  'manusia untuk menggunakan akun ini',
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
const TRUST_DEVICE_LABELS = normalizeList(['trust this device', 'percayai perangkat ini']);
const ALWAYS_CONFIRM_LABELS = normalizeList([
  "always confirm it's me",
  'always confirm it’s me',
  'selalu konfirmasikan ini saya',
  'selalu konfirmasi ini saya',
]);
const CODE_HINTS = normalizeList([
  'code',
  'kode',
  'otp',
  'security',
  'verification',
  'verifikasi',
  'keamanan',
  'authenticator',
  'autentikasi',
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
  'konfirmasikan anda manusia',
  'konfirmasikan bahwa anda manusia',
  'konfirmasikan bahwa anda adalah manusia',
  'konfirmasikan bahwa anda adalah manusia untuk menggunakan akun anda',
  'manusia untuk menggunakan akun anda',
  'manusia untuk menggunakan akun ini',
  'pastikan anda manusia',
  'kami perlu memastikan anda manusia',
]);
const CAPTCHA_TEXT_HINTS = normalizeList([
  'enter the text from the image',
  'enter the code from the image',
  "can't read this text?",
  'hear this code',
  'confirm you\'re human',
  'confirm you’re human',
  'security check',
  'captcha',
  'masukkan teks dari gambar',
  'masukkan kode dari gambar',
  'masukkan karakter dari gambar',
  'tidak bisa membaca teks ini?',
  'tak bisa membaca teks ini?',
  'dengarkan kode ini',
  'konfirmasikan anda manusia',
  'konfirmasikan bahwa anda manusia',
  'pemeriksaan keamanan',
  'cek keamanan',
]);
const CAPTCHA_DESCRIPTION_HINTS = normalizeList([
  'enter the text from the image',
  'enter the code from the image',
  'masukkan teks dari gambar',
  'masukkan kode dari gambar',
  'masukkan karakter dari gambar',
]);
const CAPTCHA_HELPER_HINTS = normalizeList([
  "can't read this text?",
  'hear this code',
  'tidak bisa membaca teks ini?',
  'tak bisa membaca teks ini?',
  'dengarkan kode ini',
]);
const CAPTCHA_MISMATCH_TEXT_HINTS = normalizeList([
  "the text you entered didn't match the security check. please try again.",
  'the text you entered didn’t match the security check. please try again.',
  "didn't match the security check",
  'didn’t match the security check',
  'teks yang anda masukkan tidak cocok dengan pemeriksaan keamanan. silakan coba lagi.',
  'teks yang anda masukkan tidak cocok dengan cek keamanan. silakan coba lagi.',
  'tidak cocok dengan pemeriksaan keamanan',
  'tidak cocok dengan cek keamanan',
]);
const CAPTCHA_AUTO_SUBMIT_MAX_ATTEMPTS = 3;
const NEED_NEW_COOKIES_TEXT_HINTS = normalizeList([
  'confirm your identity',
  "confirm you're a real person with a video selfie",
  'confirm you’re a real person with a video selfie',
  "we need more info to make sure you're human",
  'we need more info to make sure you’re human',
  'start video selfie',
  'konfirmasikan identitas anda',
  'konfirmasi identitas anda',
  'pastikan anda orang sungguhan dengan video selfie',
  'kami memerlukan info lebih lanjut untuk memastikan anda manusia',
  'mulai video selfie',
]);
const NEED_NEW_COOKIES_VIDEO_HINTS = normalizeList([
  "confirm you're a real person with a video selfie",
  'confirm you’re a real person with a video selfie',
  'start video selfie',
  'pastikan anda orang sungguhan dengan video selfie',
  'mulai video selfie',
]);
const NEED_NEW_COOKIES_IDENTITY_HINTS = normalizeList([
  'confirm your identity',
  "we need more info to make sure you're human",
  'we need more info to make sure you’re human',
  'konfirmasikan identitas anda',
  'konfirmasi identitas anda',
  'kami memerlukan info lebih lanjut untuk memastikan anda manusia',
]);
const NEED_NEW_COOKIES_TEMP_BLOCK_TITLE_HINTS = normalizeList([
  'you are temporarily blocked',
  "you're temporarily blocked",
  'anda diblokir sementara',
]);
const NEED_NEW_COOKIES_TEMP_BLOCK_REASON_HINTS = normalizeList([
  'you seem to have misused this feature by going too fast',
  'you seem to have misused this feature by using it too fast',
  'this feature is temporarily unavailable to you',
  'using this feature too quickly',
  'misused this feature by going too fast',
  'sepertinya anda menyalahgunakan fitur ini dengan menggunakannya terlalu cepat',
  'menggunakannya terlalu cepat',
  'fitur ini untuk sementara tidak tersedia',
  'dilarang menggunakan fitur ini untuk sementara',
]);
const BUSINESS_ACCESS_MISSING_HINTS = normalizeList([
  'unable to access meta business suite with this account',
  'does not have access to any facebook pages or instagram accounts',
  'that can be managed in meta business suite',
  'create a facebook page',
  'log in with instagram',
  'log in with another account',
  'tidak dapat mengakses meta business suite dengan akun ini',
  'tidak memiliki akses ke halaman facebook atau akun instagram',
  'yang dapat dikelola di meta business suite',
  'buat halaman facebook',
  'masuk dengan instagram',
  'masuk dengan akun lain',
]);
const OPEN_WHATSAPP_MODAL_LABELS = uniqueNormalizedList([
  ...(config?.texts?.openWhatsappModal || []),
  'send a message on whatsapp',
  'send message on whatsapp',
  'kirim pesan di whatsapp',
  'kirim pesan lewat whatsapp',
]);
const NEW_WHATSAPP_NUMBER_LABELS = uniqueNormalizedList([
  ...(config?.texts?.newWhatsappNumber || []),
  'new whatsapp number',
  'new whatsapp',
  'nomor whatsapp baru',
  'nomor baru whatsapp',
]);
const SEND_MESSAGE_LABELS = uniqueNormalizedList([
  ...(config?.texts?.sendMessage || []),
  'send message',
  'kirim pesan',
]);
const REPLY_SEND_LABELS = normalizeList([
  'send',
  'submit',
  'kirim',
  'kirimkan',
  'balas',
  'kirim balasan',
]);
const REPLY_INPUT_HINTS = normalizeList([
  'reply on whatsapp',
  'reply',
  'balas',
  'whatsapp',
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

export async function dismissAutomatedBehaviorNotice(page, label = 'Automation') {
  try {
    const bodyText = normalizeText(await page.evaluate(() => document.body?.innerText || ''));
    if (!AUTOMATED_BEHAVIOR_NOTICE_HINTS.some((hint) => bodyText.includes(hint))) {
      return false;
    }

    const clicked = await clickFirstMatchingText(page, AUTOMATED_BEHAVIOR_DISMISS_LABELS, {
      selector: '[role="button"],button,a,[role="link"]',
    });
    if (!clicked) {
      return false;
    }

    await sleep(500);
    console.log(`[${label}] Dismissed automated behavior notice`);
    return true;
  } catch {
    // Ignore prompt dismissal failures
  }
  return false;
}

async function dismissInboxBlockingPrompts(page, label = 'Automation') {
  let dismissed = false;
  try {
    const bodyText = normalizeText(await page.evaluate(() => document.body?.innerText || ''));

    // "Connect to Instagram" card in inbox left pane.
    if (CONNECT_INSTAGRAM_HINTS.some((hint) => bodyText.includes(hint))) {
      const dismissedConnectInstagram = await clickFirstMatchingText(page, NOT_NOW_LABELS, {
        selector: '[role="button"],button,a,[role="link"]',
      });
      if (dismissedConnectInstagram) {
        await sleep(350);
        dismissed = true;
      }
    }

    // Security notice at top of list that has a "Dismiss" link.
    const dismissedNotice = await clickFirstMatchingText(page, INBOX_DISMISS_LABELS, {
      selector: 'a,[role="link"],[role="button"],button',
    });
    if (dismissedNotice) {
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

async function prepareDebugCapture(page, { hideRails = true } = {}) {
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  try {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width < 1600) {
      await page.setViewportSize({ width: 1600, height: viewport?.height || 900 });
    }
  } catch {
    // Ignore viewport resize errors for debug captures
  }
  if (!hideRails) {
    return;
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
    // Ignore style injection errors for debug captures
  }
}

function buildDebugImagePath(dirPath, label, cUser = 'unknown') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = String(label || 'error').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `cuser-${cUser}-${safeLabel}-${ts}.png`;
  return {
    filename,
    filePath: path.join(dirPath, filename),
  };
}

async function appendCaptchaDebugLog(entry) {
  try {
    await fs.mkdir(CAPTCHA_DIR, { recursive: true });
    const logPath = path.join(CAPTCHA_DIR, '_debug.jsonl');
    const payload = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`);
  } catch {
    // Ignore captcha debug log write failures
  }
}

async function writeCaptchaArtifactMetadata(imagePath, metadata = {}) {
  if (!imagePath) return null;
  try {
    const metaPath = `${imagePath}.json`;
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
    await appendCaptchaDebugLog({
      type: 'captcha_artifact',
      imagePath,
      metaPath,
      ...metadata,
    });
    return metaPath;
  } catch {
    return null;
  }
}

async function getCaptchaClip(page) {
  try {
    return await page.evaluate((captchaHints, continueLabels, descriptionHints, helperHints) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const isTextEntryCandidate = (el) => {
        if (!isVisible(el)) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
          const type = String(el.getAttribute('type') || 'text').toLowerCase();
          return ['text', 'search', 'tel', 'email', 'number', ''].includes(type);
        }
        return String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true';
      };

      const rectOf = (el) => {
        if (!isVisible(el)) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      };

      const mergeRects = (rects) => {
        const valid = rects.filter(Boolean);
        if (valid.length === 0) return null;
        const left = Math.min(...valid.map((rect) => rect.x));
        const top = Math.min(...valid.map((rect) => rect.y));
        const right = Math.max(...valid.map((rect) => rect.x + rect.width));
        const bottom = Math.max(...valid.map((rect) => rect.y + rect.height));
        return {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        };
      };

      const expandRect = (rect, padding = 8) => {
        if (!rect) return null;
        return {
          x: Math.max(0, rect.x - padding),
          y: Math.max(0, rect.y - padding),
          width: Math.max(1, rect.width + padding * 2),
          height: Math.max(1, rect.height + padding * 2),
        };
      };

      const areaOf = (rect) => {
        if (!rect) return 0;
        return rect.width * rect.height;
      };

      const containedIn = (rect, container, tolerance = 12) => {
        if (!rect || !container) return false;
        return (
          rect.x >= container.x - tolerance &&
          rect.y >= container.y - tolerance &&
          rect.x + rect.width <= container.x + container.width + tolerance &&
          rect.y + rect.height <= container.y + container.height + tolerance
        );
      };

      const findVisibleTextElement = (hints, root = document) => {
        const candidates = Array.from(root.querySelectorAll('h1,h2,h3,h4,p,div,span,label,a,button,strong,b'));
        let best = null;
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const text = normalize(el.textContent || el.innerText || '');
          if (!text) continue;
          if (!hints.some((hint) => text.includes(hint))) continue;
          const rect = rectOf(el);
          if (!rect) continue;
          const area = areaOf(rect);
          if (!best || area < best.area) {
            best = { el, rect, area };
          }
        }
        return best;
      };

      const findContainerFor = (seed, allSeeds) => {
        let current = seed?.parentElement || null;
        while (current) {
          const rect = rectOf(current);
          if (rect && rect.width >= 220 && rect.height >= 120 && rect.width <= window.innerWidth * 0.95) {
            const containedSeeds = allSeeds.filter((node) => node && current.contains(node)).length;
            if (containedSeeds >= Math.min(2, allSeeds.length)) {
              return { el: current, rect };
            }
          }
          current = current.parentElement;
        }
        return null;
      };

      const isVisualCaptchaCandidate = (el) => {
        if (!isVisible(el)) return false;
        const rect = rectOf(el);
        if (!rect || rect.width < 60 || rect.height < 20) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (['img', 'canvas', 'svg', 'iframe'].includes(tag)) return true;
        if (normalize(el.getAttribute('role') || '') === 'img') return true;
        const style = window.getComputedStyle(el);
        return Boolean(style?.backgroundImage && style.backgroundImage !== 'none');
      };

      const bodyText = normalize(document.body?.innerText || '');
      const hasCaptchaHint = captchaHints.some((hint) => bodyText.includes(hint));

      const input = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'))
        .find((el) => isTextEntryCandidate(el)) || null;
      const descriptionMatch = findVisibleTextElement(descriptionHints);
      const helperMatch = findVisibleTextElement(helperHints);

      const continueButton = Array.from(document.querySelectorAll('[role="button"],button,a,[role="link"]')).find((el) => {
        if (!isVisible(el)) return false;
        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        return continueLabels.some((continueLabel) => label === continueLabel || label.includes(continueLabel));
      }) || null;

      const seedNodes = [input, descriptionMatch?.el || null, helperMatch?.el || null, continueButton].filter(Boolean);
      const container =
        findContainerFor(input, seedNodes) ||
        findContainerFor(descriptionMatch?.el || null, seedNodes) ||
        findContainerFor(helperMatch?.el || null, seedNodes) ||
        null;

      const containerRect = container?.rect || null;
      const inputRect = rectOf(input);
      const descriptionRect = descriptionMatch?.rect || null;
      const helperRect = helperMatch?.rect || null;
      const continueRect = rectOf(continueButton);

      const challengeVisual = Array.from((container?.el || document.body).querySelectorAll('img,canvas,svg,iframe,[role="img"],[style*="background-image"]'))
        .filter((el) => isVisualCaptchaCandidate(el))
        .map((el) => ({ el, rect: rectOf(el) }))
        .filter(({ rect }) => rect)
        .filter(({ rect }) => !containerRect || containedIn(rect, containerRect))
        .filter(({ rect }) => !inputRect || rect.y + rect.height <= inputRect.y + 8)
        .filter(({ rect }) => !descriptionRect || rect.y + rect.height >= descriptionRect.y + Math.min(descriptionRect.height, 24))
        .sort((a, b) => areaOf(b.rect) - areaOf(a.rect))[0]?.rect || null;

      let clip = challengeVisual ? expandRect(challengeVisual, 8) : null;

      if (!clip) {
        const fallbackTop = descriptionRect
          ? descriptionRect.y + descriptionRect.height + 8
          : containerRect
            ? containerRect.y + 48
            : null;
        const fallbackBottom = helperRect
          ? helperRect.y - 8
          : inputRect
            ? inputRect.y - 8
            : continueRect
              ? continueRect.y - 8
              : null;
        const fallbackLeft = containerRect
          ? containerRect.x + 24
          : inputRect
            ? inputRect.x
            : null;
        const fallbackRight = containerRect
          ? containerRect.x + containerRect.width - 24
          : inputRect
            ? inputRect.x + inputRect.width
            : null;

        if (
          fallbackTop !== null &&
          fallbackBottom !== null &&
          fallbackLeft !== null &&
          fallbackRight !== null &&
          fallbackBottom > fallbackTop &&
          fallbackRight > fallbackLeft
        ) {
          clip = {
            x: Math.max(0, fallbackLeft),
            y: Math.max(0, fallbackTop),
            width: Math.max(1, fallbackRight - fallbackLeft),
            height: Math.max(1, fallbackBottom - fallbackTop),
          };
        }
      }

      if (!clip) {
        const containerImageLike = container?.el
          ? Array.from(container.el.querySelectorAll('img,canvas,svg,iframe,[role="img"],[style*="background-image"]'))
            .filter((el) => isVisualCaptchaCandidate(el))
            .map((el) => rectOf(el))
          : [];
        clip = mergeRects([
          ...containerImageLike,
          descriptionRect,
          helperRect,
          inputRect,
        ]);
      }

      if (!clip && inputRect) {
        const inferredBottom = helperRect
          ? helperRect.y - 6
          : inputRect.y - 12;
        const inferredHeight = helperRect
          ? Math.max(56, Math.min(120, Math.round(inputRect.height * 1.6)))
          : Math.max(72, Math.min(132, Math.round(inputRect.height * 2.2)));
        const inferredTop = Math.max(0, inferredBottom - inferredHeight);
        if (inferredBottom > inferredTop) {
          clip = {
            x: Math.max(0, inputRect.x),
            y: inferredTop,
            width: Math.max(1, inputRect.width),
            height: Math.max(1, inferredBottom - inferredTop),
          };
        }
      }

      if (!clip && containerRect) {
        const bandTop = Math.max(0, containerRect.y + Math.round(containerRect.height * 0.18));
        const bandBottom = inputRect
          ? Math.max(bandTop + 40, inputRect.y - 10)
          : containerRect.y + Math.round(containerRect.height * 0.56);
        const bandWidth = Math.max(180, Math.min(containerRect.width - 48, Math.round(containerRect.width * 0.72)));
        if (bandBottom > bandTop && bandWidth > 0) {
          clip = {
            x: Math.max(0, containerRect.x + 24),
            y: bandTop,
            width: Math.max(1, bandWidth),
            height: Math.max(1, bandBottom - bandTop),
          };
        }
      }

      if (!clip) {
        const viewportCenterX = window.scrollX + window.innerWidth / 2;
        const viewportCenterY = window.scrollY + window.innerHeight / 2;
        const genericCard = Array.from(document.querySelectorAll('[role="dialog"],div,form,section,article,main'))
          .filter((el) => isVisible(el))
          .map((el) => {
            const rect = rectOf(el);
            if (!rect) return null;
            if (rect.width < 240 || rect.height < 160) return null;
            if (rect.width > Math.min(window.innerWidth * 0.94, 980)) return null;
            if (rect.height > Math.min(window.innerHeight * 0.95, 900)) return null;
            const textFields = Array.from(el.querySelectorAll('input,textarea,[contenteditable="true"]'))
              .filter((node) => isTextEntryCandidate(node));
            const buttons = Array.from(el.querySelectorAll('[role="button"],button,a,[role="link"]'))
              .filter((node) => isVisible(node));
            const textLength = normalize(el.innerText || '').length;
            const style = window.getComputedStyle(el);
            const hasSurface = Boolean(
              style &&
              (
                (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') ||
                style.boxShadow !== 'none' ||
                parseFloat(style.borderWidth || '0') > 0
              )
            );
            if (!hasCaptchaHint && textFields.length === 0 && buttons.length === 0) return null;
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;
            const centerDistance = Math.abs(centerX - viewportCenterX) + Math.abs(centerY - viewportCenterY);
            const score =
              (textFields.length ? 260 : 0) +
              Math.min(buttons.length, 4) * 18 +
              Math.min(textLength, 280) +
              (hasSurface ? 100 : 0) -
              centerDistance * 0.18 -
              Math.abs(rect.width - 520) * 0.1;
            return {
              rect,
              score,
              fieldRect: rectOf(textFields[0] || null),
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)[0] || null;

        if (genericCard) {
          const top = descriptionRect && containedIn(descriptionRect, genericCard.rect)
            ? descriptionRect.y + descriptionRect.height + 8
            : genericCard.rect.y + Math.max(28, Math.round(genericCard.rect.height * 0.18));
          const bottom = genericCard.fieldRect && containedIn(genericCard.fieldRect, genericCard.rect)
            ? genericCard.fieldRect.y - 8
            : genericCard.rect.y + Math.round(genericCard.rect.height * 0.56);
          const horizontalPadding = Math.max(18, Math.round(genericCard.rect.width * 0.06));
          if (bottom > top && genericCard.rect.width - horizontalPadding * 2 > 80) {
            clip = {
              x: Math.max(0, genericCard.rect.x + horizontalPadding),
              y: Math.max(0, top),
              width: Math.max(1, genericCard.rect.width - horizontalPadding * 2),
              height: Math.max(1, bottom - top),
            };
          }
        }
      }

      if (!clip) {
        return null;
      }

      const padding = 16;
      return {
        x: Math.max(0, clip.x - padding),
        y: Math.max(0, clip.y - padding),
        width: Math.max(1, clip.width + padding * 2),
        height: Math.max(1, clip.height + padding * 2),
      };
    }, CAPTCHA_TEXT_HINTS, CONTINUE_LABELS, CAPTCHA_DESCRIPTION_HINTS, CAPTCHA_HELPER_HINTS);
  } catch {
    return null;
  }
}

async function getSimpleCaptchaClip(page) {
  try {
    return await page.evaluate((descriptionHints) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const isTextEntryCandidate = (el) => {
        if (!isVisible(el)) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
          const type = String(el.getAttribute('type') || 'text').toLowerCase();
          return ['text', 'search', 'tel', 'email', 'number', ''].includes(type);
        }
        return String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true';
      };

      const rectOf = (el) => {
        if (!isVisible(el)) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      };

      const field = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'))
        .find((el) => isTextEntryCandidate(el));
      if (!field) return null;

      const fieldRect = rectOf(field);
      if (!fieldRect) return null;

      const findDescriptionRect = (root) => {
        const candidates = Array.from((root || document).querySelectorAll('h1,h2,h3,h4,p,div,span,label,strong,b'));
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const text = normalize(el.textContent || el.innerText || '');
          if (!text) continue;
          if (!descriptionHints.some((hint) => text.includes(hint))) continue;
          const rect = rectOf(el);
          if (rect) return rect;
        }
        return null;
      };

      let containerRect = null;
      let containerEl = null;
      let current = field.parentElement;
      while (current) {
        const rect = rectOf(current);
        if (
          rect &&
          rect.width >= 240 &&
          rect.height >= 160 &&
          rect.width <= Math.min(window.innerWidth * 0.95, 980) &&
          rect.height <= Math.min(window.innerHeight * 0.95, 900)
        ) {
          const text = normalize(current.innerText || '');
          const buttons = Array.from(current.querySelectorAll('[role="button"],button,a,[role="link"]')).filter((el) => isVisible(el)).length;
          if (text.length >= 20 || buttons > 0) {
            containerRect = rect;
            containerEl = current;
            break;
          }
        }
        current = current.parentElement;
      }

      if (!containerRect) {
        containerRect = {
          x: Math.max(0, fieldRect.x - 20),
          y: Math.max(0, fieldRect.y - 170),
          width: Math.min(window.innerWidth - Math.max(0, fieldRect.x - 20), fieldRect.width + 40),
          height: Math.min(window.innerHeight - Math.max(0, fieldRect.y - 170), fieldRect.height + 240),
        };
      }

      const descriptionRect = findDescriptionRect(containerEl);
      const horizontalPadding = Math.max(18, Math.round(containerRect.width * 0.04));
      let top = descriptionRect
        ? descriptionRect.y + descriptionRect.height + 8
        : containerRect.y + Math.max(42, Math.round(containerRect.height * 0.16));
      let bottom = fieldRect.y - 10;

      if (bottom <= top) {
        top = Math.max(0, fieldRect.y - Math.max(80, Math.min(180, Math.round(containerRect.height * 0.32))));
        bottom = fieldRect.y - 8;
      }

      if (bottom <= top) return null;

      return {
        x: Math.max(0, containerRect.x + horizontalPadding - 12),
        y: Math.max(0, top - 12),
        width: Math.max(1, containerRect.width - horizontalPadding * 2 + 24),
        height: Math.max(1, bottom - top + 24),
      };
    }, CAPTCHA_DESCRIPTION_HINTS);
  } catch {
    return null;
  }
}

async function findCaptchaChallengeElement(page) {
  try {
    const handle = await page.evaluateHandle((descriptionHints, helperHints, continueLabels) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const rectOf = (el) => {
        if (!isVisible(el)) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      };

      const areaOf = (rect) => {
        if (!rect) return 0;
        return rect.width * rect.height;
      };

      const containedIn = (rect, container, tolerance = 12) => {
        if (!rect || !container) return false;
        return (
          rect.x >= container.x - tolerance &&
          rect.y >= container.y - tolerance &&
          rect.x + rect.width <= container.x + container.width + tolerance &&
          rect.y + rect.height <= container.y + container.height + tolerance
        );
      };

      const isTextEntryCandidate = (el) => {
        if (!isVisible(el)) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
          const type = String(el.getAttribute('type') || 'text').toLowerCase();
          return ['text', 'search', 'tel', 'email', 'number', ''].includes(type);
        }
        return String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true';
      };

      const findVisibleTextElement = (hints, root = document) => {
        const candidates = Array.from(root.querySelectorAll('h1,h2,h3,h4,p,div,span,label,a,button,strong,b'));
        let best = null;
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const text = normalize(el.textContent || el.innerText || '');
          if (!text) continue;
          if (!hints.some((hint) => text.includes(hint))) continue;
          const rect = rectOf(el);
          if (!rect) continue;
          const area = areaOf(rect);
          if (!best || area < best.area) {
            best = { el, rect, area };
          }
        }
        return best;
      };

      const findContainerFor = (seed, allSeeds) => {
        let current = seed?.parentElement || null;
        while (current) {
          const rect = rectOf(current);
          if (rect && rect.width >= 220 && rect.height >= 120 && rect.width <= window.innerWidth * 0.95) {
            const containedSeeds = allSeeds.filter((node) => node && current.contains(node)).length;
            if (containedSeeds >= Math.min(2, allSeeds.length)) {
              return { el: current, rect };
            }
          }
          current = current.parentElement;
        }
        return null;
      };

      const input = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'))
        .find((el) => isTextEntryCandidate(el)) || null;
      const descriptionMatch = findVisibleTextElement(descriptionHints);
      const helperMatch = findVisibleTextElement(helperHints);
      const continueButton = Array.from(document.querySelectorAll('[role="button"],button,a,[role="link"]')).find((el) => {
        if (!isVisible(el)) return false;
        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        return continueLabels.some((continueLabel) => label === continueLabel || label.includes(continueLabel));
      }) || null;

      const seedNodes = [input, descriptionMatch?.el || null, helperMatch?.el || null, continueButton].filter(Boolean);
      const container =
        findContainerFor(input, seedNodes) ||
        findContainerFor(descriptionMatch?.el || null, seedNodes) ||
        findContainerFor(helperMatch?.el || null, seedNodes) ||
        null;

      const containerRect = container?.rect || null;
      const inputRect = rectOf(input);
      const descriptionRect = descriptionMatch?.rect || null;

      const candidates = Array.from((container?.el || document).querySelectorAll('img,canvas,svg,iframe,[role="img"],[style*="background-image"]'))
        .filter((el) => isVisible(el))
        .map((el) => ({ el, rect: rectOf(el) }))
        .filter(({ rect }) => rect && rect.width >= 60 && rect.height >= 20)
        .filter(({ rect }) => !containerRect || containedIn(rect, containerRect))
        .filter(({ rect }) => !inputRect || rect.y + rect.height <= inputRect.y + 12)
        .filter(({ rect }) => !descriptionRect || rect.y + rect.height >= descriptionRect.y + Math.min(descriptionRect.height, 24))
        .sort((a, b) => areaOf(b.rect) - areaOf(a.rect));

      return candidates[0]?.el || null;
    }, CAPTCHA_DESCRIPTION_HINTS, CAPTCHA_HELPER_HINTS, CONTINUE_LABELS);

    return handle.asElement();
  } catch {
    return null;
  }
}

async function getFixedCaptchaClip(page) {
  try {
    return await page.evaluate(() => {
      const baseViewportWidth = 1600;
      const baseViewportHeight = 900;
      const baseClip = {
        x: 524,
        y: 202,
        width: 308,
        height: 76,
      };

      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || baseViewportWidth;
      const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || baseViewportHeight;
      const scaleX = viewportWidth / baseViewportWidth;
      const scaleY = viewportHeight / baseViewportHeight;

      return {
        x: Math.max(0, Math.round(baseClip.x * scaleX)),
        y: Math.max(0, Math.round(baseClip.y * scaleY)),
        width: Math.max(1, Math.round(baseClip.width * scaleX)),
        height: Math.max(1, Math.round(baseClip.height * scaleY)),
      };
    });
  } catch {
    return null;
  }
}

async function getAnchoredCaptchaClip(page) {
  try {
    return await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const isTextEntryCandidate = (el) => {
        if (!isVisible(el)) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
          const type = String(el.getAttribute('type') || 'text').toLowerCase();
          return ['text', 'search', 'tel', 'email', 'number', ''].includes(type);
        }
        return String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true';
      };

      const rectOf = (el) => {
        if (!isVisible(el)) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      };

      const input = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'))
        .find((el) => isTextEntryCandidate(el));
      if (!input) return null;

      const inputRect = rectOf(input);
      if (!inputRect) return null;

      let containerRect = null;
      let current = input.parentElement;
      while (current) {
        const rect = rectOf(current);
        if (
          rect &&
          rect.width >= 240 &&
          rect.height >= 160 &&
          rect.width <= Math.min(window.innerWidth * 0.95, 980) &&
          rect.height <= Math.min(window.innerHeight * 0.95, 900)
        ) {
          containerRect = rect;
          break;
        }
        current = current.parentElement;
      }

      const width = Math.max(
        280,
        Math.min(
          340,
          Math.round(inputRect.width * 0.58),
          containerRect ? Math.max(240, containerRect.width - 56) : 340
        )
      );
      const height = Math.max(72, Math.min(90, Math.round(inputRect.height * 1.45)));
      const topGap = Math.max(118, Math.min(150, Math.round(inputRect.height * 2.38)));

      let x = Math.round(inputRect.x - 8);
      let y = Math.round(inputRect.y - topGap);

      if (containerRect) {
        x = Math.max(containerRect.x + 16, x);
        y = Math.max(containerRect.y + 54, y);
      }

      const maxBottom = Math.round(inputRect.y - 34);
      if (y + height > maxBottom) {
        y = Math.max(0, maxBottom - height);
      }

      return {
        x: Math.max(0, x - 10),
        y: Math.max(0, y),
        width: Math.max(1, width),
        height: Math.max(1, height),
      };
    });
  } catch {
    return null;
  }
}

async function captureCaptchaImage(page, cUser = 'unknown') {
  try {
    await prepareDebugCapture(page, { hideRails: false });
    await fs.mkdir(CAPTCHA_DIR, { recursive: true });

    let clip = await getAnchoredCaptchaClip(page);
    if (clip) {
      const method = 'anchored';
      const { filename, filePath } = buildDebugImagePath(CAPTCHA_DIR, `captcha-${method}`, cUser);
      console.log('[Automation] Captcha crop anchored clip:', JSON.stringify({
        url: page.url(),
        cUser,
        clip,
      }));
      await page.screenshot({ path: filePath, clip });
      console.log('[Automation] Captcha crop saved:', JSON.stringify({
        path: filePath,
        filename,
        method,
        clip,
        url: page.url(),
      }));
      await writeCaptchaArtifactMetadata(filePath, {
        filename,
        artifactType: 'captcha_crop',
        method,
        clip,
        url: page.url(),
        cUser,
      });
      return { path: filePath, filename, url: page.url(), clip, method };
    }

    let method = null;
    if (!clip) {
      clip = await getFixedCaptchaClip(page);
      if (clip) {
        method = 'fixed';
        console.log('[Automation] Captcha crop fixed clip:', JSON.stringify({
          url: page.url(),
          cUser,
          clip,
        }));
      }
    }
    if (!clip) {
      clip = await getCaptchaClip(page);
      if (clip) {
        method = 'dynamic';
        console.log('[Automation] Captcha crop dynamic clip:', JSON.stringify({
          url: page.url(),
          cUser,
          clip,
        }));
      }
    }
    if (!clip) {
      clip = await getSimpleCaptchaClip(page);
      if (clip) {
        method = 'simple';
        console.log('[Automation] Captcha crop fallback clip:', JSON.stringify({
          url: page.url(),
          cUser,
          clip,
        }));
      }
    }
    if (!clip) {
      const challengeElement = await findCaptchaChallengeElement(page);
      if (challengeElement) {
        try {
          method = 'element';
          const { filename, filePath } = buildDebugImagePath(CAPTCHA_DIR, `captcha-${method}`, cUser);
          await challengeElement.scrollIntoViewIfNeeded().catch(() => null);
          await challengeElement.screenshot({ path: filePath });
          console.log('[Automation] Captcha element screenshot saved:', JSON.stringify({
            path: filePath,
            filename,
            method,
            url: page.url(),
          }));
          await writeCaptchaArtifactMetadata(filePath, {
            filename,
            artifactType: 'captcha_crop',
            method,
            clip: null,
            url: page.url(),
            cUser,
          });
          return { path: filePath, filename, url: page.url(), clip: null, method };
        } catch (elementError) {
          console.warn('[Automation] Captcha element screenshot failed:', JSON.stringify({
            url: page.url(),
            cUser,
            error: elementError?.message || String(elementError),
          }));
        }
      }
    }
    if (!clip) {
      const diagnostics = await page.evaluate((captchaHints) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (!style) return false;
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const rectSummary = (el) => {
          if (!isVisible(el)) return null;
          const rect = el.getBoundingClientRect();
          return {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };
        const bodyText = normalize(document.body?.innerText || '');
        const cardCandidates = Array.from(document.querySelectorAll('[role="dialog"],div,form,section,article,main'))
          .filter((el) => isVisible(el))
          .map((el) => {
            const rect = rectSummary(el);
            if (!rect) return null;
            if (rect.width < 240 || rect.height < 160) return null;
            if (rect.width > Math.min(window.innerWidth * 0.94, 980)) return null;
            if (rect.height > Math.min(window.innerHeight * 0.95, 900)) return null;
            const textFields = Array.from(el.querySelectorAll('input,textarea,[contenteditable="true"]')).filter((node) => isVisible(node)).length;
            const images = Array.from(el.querySelectorAll('img,canvas,svg,iframe,[role="img"],[style*="background-image"]')).filter((node) => isVisible(node)).length;
            const buttons = Array.from(el.querySelectorAll('[role="button"],button,a,[role="link"]')).filter((node) => isVisible(node)).length;
            const text = normalize(el.innerText || '').slice(0, 160);
            return { rect, textFields, images, buttons, text };
          })
          .filter(Boolean)
          .slice(0, 5);
        return {
          bodyTextSample: bodyText.slice(0, 280),
          hasCaptchaHint: captchaHints.some((hint) => bodyText.includes(hint)),
          counts: {
            inputs: Array.from(document.querySelectorAll('input')).filter((el) => isVisible(el)).length,
            textareas: Array.from(document.querySelectorAll('textarea')).filter((el) => isVisible(el)).length,
            contenteditables: Array.from(document.querySelectorAll('[contenteditable="true"]')).filter((el) => isVisible(el)).length,
            images: Array.from(document.querySelectorAll('img')).filter((el) => isVisible(el)).length,
            canvases: Array.from(document.querySelectorAll('canvas')).filter((el) => isVisible(el)).length,
            svgs: Array.from(document.querySelectorAll('svg')).filter((el) => isVisible(el)).length,
            iframes: Array.from(document.querySelectorAll('iframe')).filter((el) => isVisible(el)).length,
          },
          firstVisibleTextField:
            rectSummary(Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).find((el) => isVisible(el))) || null,
          cardCandidates,
        };
      }, CAPTCHA_TEXT_HINTS).catch(() => null);
      console.warn('[Automation] Captcha crop not found:', JSON.stringify({
        url: page.url(),
        cUser,
      }));
      if (diagnostics) {
        console.warn('[Automation] Captcha crop diagnostics:', JSON.stringify({
          url: page.url(),
          cUser,
          diagnostics,
        }));
      }
      await appendCaptchaDebugLog({
        type: 'captcha_no_clip',
        url: page.url(),
        cUser,
        diagnostics,
      });
      return { path: null, url: page.url(), clip: null };
    }
    const { filename, filePath } = buildDebugImagePath(CAPTCHA_DIR, `captcha-${method || 'clip'}`, cUser);
    await page.screenshot({ path: filePath, clip });
    console.log('[Automation] Captcha crop saved:', JSON.stringify({
      path: filePath,
      filename,
      method: method || 'clip',
      clip,
      url: page.url(),
    }));
    await writeCaptchaArtifactMetadata(filePath, {
      filename,
      artifactType: 'captcha_crop',
      method: method || 'clip',
      clip,
      url: page.url(),
      cUser,
    });
    return { path: filePath, filename, url: page.url(), clip, method: method || 'clip' };
  } catch (error) {
    console.warn('[Automation] Captcha crop failed:', JSON.stringify({
      url: page?.url?.() || null,
      cUser,
      error: error?.message || String(error),
    }));
    await appendCaptchaDebugLog({
      type: 'captcha_crop_failed',
      url: page?.url?.() || null,
      cUser,
      error: error?.message || String(error),
    });
    return { path: null, url: page?.url?.() || null, error: error?.message || String(error), clip: null };
  }
}

export async function captureDebugScreenshot(page, label, cUser = 'unknown', dirPath = DEBUG_DIR) {
  try {
    await prepareDebugCapture(page, { hideRails: true });
    await fs.mkdir(dirPath, { recursive: true });
    const { filename, filePath } = buildDebugImagePath(dirPath, label, cUser);
    await page.screenshot({ path: filePath, fullPage: true });
    if (dirPath === CAPTCHA_DIR) {
      await writeCaptchaArtifactMetadata(filePath, {
        filename,
        artifactType: 'checkpoint_fullpage',
        label,
        method: 'fullpage',
        clip: null,
        url: page.url(),
        cUser,
      });
    }
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

export async function readRequestLog(requestId) {
  const normalized = String(requestId || '').trim();
  if (!normalized) return null;

  try {
    const filePath = path.join(REQUEST_LOG_DIR, `request-${normalized}.json`);
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function normalizeRequestId(sessionId = null, requestId = null) {
  const explicit = String(requestId || '').trim();
  if (explicit) {
    return explicit.replace(/[^a-zA-Z0-9._:-]/g, '-');
  }

  const sessionPart = String(sessionId || 'unknown').trim().replace(/[^a-zA-Z0-9._:-]/g, '-') || 'unknown';
  return `${sessionPart}-${Date.now()}`;
}

function getCaptchaLogDetails(details) {
  if (String(details?.type || '').toLowerCase() !== 'captcha_required') {
    return null;
  }
  return {
    captcha: {
      imagePath: details?.captchaImagePath || null,
      imageFilename: details?.captchaImageFilename || null,
      imageMethod: details?.captchaImageMethod || null,
      imageClip: details?.captchaImageClip || null,
      ocrText: details?.captchaOcrText || null,
      ocrProvider: details?.captchaOcrProvider || null,
      ocrError: details?.captchaOcrError || null,
      autoSubmitAttempted: details?.captchaAutoSubmitAttempted === true,
      autoSubmitSucceeded: details?.captchaAutoSubmitSucceeded === true,
      submittedText: details?.captchaSubmittedText || null,
      continueClicked: details?.captchaContinueClicked === true,
      autoResolveError: details?.captchaAutoResolveError || null,
      attemptCount: details?.captchaAttemptCount || 0,
      retryTriggered: details?.captchaRetryTriggered === true,
      mismatchMessageDetected: details?.captchaMismatchMessageDetected === true,
      pageDidNotMove: details?.captchaPageDidNotMove === true,
    },
  };
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

function uniqueNormalizedList(list) {
  return Array.from(new Set(normalizeList(list)));
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
  const type = String(error?.details?.type || '').toLowerCase();
  return (
    type === 'account_restricted' ||
    type === 'need_new_cookies' ||
    type === 'captcha_required' ||
    message.includes('redirected to auth') ||
    message.includes('checkpoint') ||
    message.includes('captcha') ||
    message.includes('login') ||
    message.includes('twofactor') ||
    message.includes('account restricted') ||
    message.includes('need new cookies')
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
    'input[aria-label*="kode" i]',
    'input[aria-label*="security" i]',
    'input[aria-label*="keamanan" i]',
    'input[aria-label*="verification" i]',
    'input[aria-label*="verifikasi" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="kode" i]',
    'input[placeholder*="security" i]',
    'input[placeholder*="keamanan" i]',
    'input[placeholder*="verification" i]',
    'input[placeholder*="verifikasi" i]',
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

async function getAuthPageDiagnostics(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const title = document.title || '';
      return {
        title,
        text: text.slice(0, 400),
        url: window.location.href,
      };
    });
  } catch {
    return {
      title: '',
      text: '',
      url: page.url(),
    };
  }
}

async function detectCaptchaCheckpoint(page) {
  try {
    return await page.evaluate((hints) => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const hasHint = hints.some((hint) => text.includes(hint));
      if (!hasHint) return false;

      const hasImage = !!document.querySelector('img');
      const hasTextInput = !!Array.from(document.querySelectorAll('input')).find((el) => {
        const type = String(el.getAttribute('type') || 'text').toLowerCase();
        return ['text', 'search', 'tel', ''].includes(type);
      });

      return hasTextInput || hasImage;
    }, CAPTCHA_TEXT_HINTS);
  } catch {
    return false;
  }
}

async function hasCaptchaMismatchMessage(page) {
  try {
    return await page.evaluate((hints) => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return hints.some((hint) => text.includes(hint));
    }, CAPTCHA_MISMATCH_TEXT_HINTS);
  } catch {
    return false;
  }
}

export async function detectNeedNewCookiesPage(page) {
  try {
    return await page.evaluate(({ hints, videoHints, identityHints, tempBlockTitleHints, tempBlockReasonHints, businessAccessMissingHints }) => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const matchedHints = hints.filter((hint) => text.includes(hint));
      const matchedBusinessAccessMissingHints = businessAccessMissingHints.filter((hint) => text.includes(hint));
      const hasStrongVideoHint = videoHints.some((hint) => text.includes(hint));
      const hasIdentityHint = identityHints.some((hint) => text.includes(hint));
      const matchedTempBlockTitleHints = tempBlockTitleHints.filter((hint) => text.includes(hint));
      const matchedTempBlockReasonHints = tempBlockReasonHints.filter((hint) => text.includes(hint));
      const hasTempBlockTitleHint = matchedTempBlockTitleHints.length > 0;
      const hasTempBlockReasonHint = matchedTempBlockReasonHints.length > 0;
      const businessAccessMissingDetected = matchedBusinessAccessMissingHints.length >= 2;
      const identityVerificationDetected = hasStrongVideoHint && hasIdentityHint;
      const temporaryBlockDetected = hasTempBlockTitleHint && hasTempBlockReasonHint;
      const reason =
        businessAccessMissingDetected ? 'business_access_missing' :
          (identityVerificationDetected ? 'identity_verification' : (temporaryBlockDetected ? 'temporary_block' : null));
      return {
        detected: businessAccessMissingDetected || identityVerificationDetected || temporaryBlockDetected,
        matchedHints: [
          ...matchedHints,
          ...matchedBusinessAccessMissingHints,
          ...matchedTempBlockTitleHints,
          ...matchedTempBlockReasonHints,
        ],
        reason,
      };
    }, {
      hints: NEED_NEW_COOKIES_TEXT_HINTS,
      videoHints: NEED_NEW_COOKIES_VIDEO_HINTS,
      identityHints: NEED_NEW_COOKIES_IDENTITY_HINTS,
      tempBlockTitleHints: NEED_NEW_COOKIES_TEMP_BLOCK_TITLE_HINTS,
      tempBlockReasonHints: NEED_NEW_COOKIES_TEMP_BLOCK_REASON_HINTS,
      businessAccessMissingHints: BUSINESS_ACCESS_MISSING_HINTS,
    });
  } catch {
    return { detected: false, matchedHints: [], reason: null };
  }
}

async function collectCaptchaCheckpointDetails(page, label = 'Automation', cUser = 'unknown') {
  const captchaImage = await captureCaptchaImage(page, cUser).catch(() => null);
  const diag = await getAuthPageDiagnostics(page);
  const ocrConfigured = isOcrConfigured();
  let captchaOcrText = null;
  let captchaOcrError = null;

  console.warn(
    `[${label}] Captcha checkpoint detected`,
    JSON.stringify({
      url: diag.url || page.url(),
      title: diag.title,
      screenshotPath: null,
      captchaImagePath: captchaImage?.path || null,
      captchaImageMethod: captchaImage?.method || null,
      ocrConfigured,
    })
  );

  if (!captchaImage?.path) {
    console.warn(`[${label}] Captcha OCR skipped: crop image not available`);
  } else if (!ocrConfigured) {
    console.warn(`[${label}] Captcha OCR skipped: OCR config missing`);
  }

  if (captchaImage?.path && ocrConfigured) {
    try {
      captchaOcrText = await easyOCR(captchaImage.path);
      if (!captchaOcrText) {
        console.warn(`[${label}] Captcha OCR returned empty text`);
      }
    } catch (error) {
      captchaOcrError = error?.message || String(error);
      console.warn(`[${label}] OCR failed: ${captchaOcrError}`);
    }
  }

  await appendCaptchaDebugLog({
    type: 'captcha_checkpoint',
    label,
    cUser,
    url: diag.url || page.url(),
    title: diag.title,
    screenshotPath: null,
    captchaImagePath: captchaImage?.path || null,
    captchaImageFilename: captchaImage?.filename || null,
    captchaImageMethod: captchaImage?.method || null,
    captchaImageClip: captchaImage?.clip || null,
    ocrConfigured,
    captchaOcrText: captchaOcrText || null,
    captchaOcrError: captchaOcrError || null,
  });

  return {
    type: 'captcha_required',
    url: diag.url || page.url(),
    title: diag.title,
    text: diag.text,
    screenshotPath: null,
    captchaImagePath: captchaImage?.path || null,
    captchaImageFilename: captchaImage?.filename || null,
    captchaImageClip: captchaImage?.clip || null,
    captchaImageMethod: captchaImage?.method || null,
    captchaOcrText: captchaOcrText || null,
    captchaOcrProvider: ocrConfigured ? 'easyOCR' : null,
    captchaOcrError,
  };
}

async function collectAccountRestrictedDetails(page, label = 'Automation', extraDetails = {}) {
  const { cUser = 'unknown', ...restDetails } = extraDetails || {};
  const debug = await captureDebugScreenshot(page, 'account-restricted', cUser).catch(() => null);
  const diag = await getAuthPageDiagnostics(page);
  console.warn(
    `[${label}] Account restricted detected`,
    JSON.stringify({
      url: diag.url || page.url(),
      title: diag.title,
      indicator: restDetails?.indicator || null,
      debugPath: debug?.path || null,
    })
  );
  return {
    type: 'account_restricted',
    url: diag.url || page.url(),
    title: diag.title,
    text: diag.text,
    screenshotPath: debug?.path || null,
    screenshotFilename: debug?.filename || null,
    ...restDetails,
  };
}

async function collectNeedNewCookiesDetails(page, label = 'Automation', extraDetails = {}) {
  const detected = await detectNeedNewCookiesPage(page);
  const { cUser = 'unknown', ...restDetails } = extraDetails || {};
  const debug = await captureDebugScreenshot(page, 'need-new-cookies', cUser).catch(() => null);
  const diag = await getAuthPageDiagnostics(page);
  console.warn(
    `[${label}] Need new cookies detected`,
    JSON.stringify({
      url: diag.url || page.url(),
      title: diag.title,
      indicator: detected?.reason || null,
      debugPath: debug?.path || null,
    })
  );
  return {
    type: 'need_new_cookies',
    url: diag.url || page.url(),
    title: diag.title,
    text: diag.text,
    screenshotPath: debug?.path || null,
    screenshotFilename: debug?.filename || null,
    indicator: detected?.reason || 'need_new_cookies',
    matchedHints: detected?.matchedHints || [],
    ...restDetails,
  };
}

async function getNeedNewCookiesDetailsIfPresent(page, label = 'Automation', extraDetails = {}) {
  const detected = await detectNeedNewCookiesPage(page);
  if (!detected?.detected) {
    return null;
  }
  return collectNeedNewCookiesDetails(page, label, extraDetails);
}

async function getAuthBlockDetailsIfPresent(page, label = 'Automation', { cUser = 'unknown', stage = null } = {}) {
  const needNewCookiesDetails = await getNeedNewCookiesDetailsIfPresent(page, label, { cUser, stage });
  if (needNewCookiesDetails) {
    return needNewCookiesDetails;
  }

  if (await detectCaptchaCheckpoint(page)) {
    const details = await collectCaptchaCheckpointDetails(page, label, cUser);
    return {
      ...(details || {}),
      type: 'captcha_required',
      reason: 'captcha_checkpoint',
      stage,
      cUser,
    };
  }

  const url = page.url();
  const badAuthUrl = isBadAuthUrl(url);
  let hasLoginForm = false;
  try {
    hasLoginForm = await page.evaluate(() => (
      !!document.querySelector('input[name="email"], input#email, input[name="pass"], #pass') ||
      !!document.querySelector('[data-testid="royal_login_form"], form[action*="login"]')
    ));
  } catch {
    hasLoginForm = false;
  }

  if (!badAuthUrl && !hasLoginForm) {
    return null;
  }

  const debug = await captureDebugScreenshot(page, 'auth-blocked', cUser).catch(() => null);
  return {
    type: 'need_new_cookies',
    reason: badAuthUrl ? 'auth_url' : 'login_form',
    stage,
    url,
    screenshotPath: debug?.path || null,
    debugPath: debug?.path || null,
    cUser,
  };
}

async function throwIfAuthBlocked(page, label = 'Automation', { cUser = 'unknown', stage = null } = {}) {
  const details = await getAuthBlockDetailsIfPresent(page, label, { cUser, stage });
  if (!details) {
    return;
  }
  const type = String(details.type || '').toLowerCase();
  const reason = String(details.reason || type || 'auth_blocked');
  throw new AutomationError(`${label}: Auth blocked (${reason})`, details);
}

async function findCaptchaInput(page) {
  const candidates = await page.$$('input, textarea');
  for (const candidate of candidates) {
    const visible = await isVisible(page, candidate);
    if (!visible) continue;
    const accepted = await candidate.evaluate((el) => {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'textarea') return true;
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'tel', ''].includes(type);
    }).catch(() => false);
    if (accepted) {
      return candidate;
    }
  }
  return null;
}

async function tryResolveCaptchaCheckpoint(page, label = 'Automation', cUser = 'unknown') {
  let lastFailure = null;

  for (let attempt = 1; attempt <= CAPTCHA_AUTO_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
    console.log(`[${label}] Captcha auto-resolve attempt ${attempt}/${CAPTCHA_AUTO_SUBMIT_MAX_ATTEMPTS}`);
    const details = await collectCaptchaCheckpointDetails(page, label, cUser);
    const captchaText = String(details?.captchaOcrText || '').trim();

    if (!captchaText) {
      console.warn(`[${label}] Captcha auto-resolve stopped: OCR text empty`);
      return {
        resolved: false,
        details: {
          ...details,
          captchaAutoSubmitAttempted: false,
          captchaAutoSubmitSucceeded: false,
          captchaAttemptCount: attempt,
          captchaAutoResolveError: 'OCR returned empty result',
        },
      };
    }

    const input = await findCaptchaInput(page);
    if (!input) {
      console.warn(`[${label}] Captcha auto-resolve stopped: captcha input not found`);
      return {
        resolved: false,
        details: {
          ...details,
          captchaAutoSubmitAttempted: false,
          captchaAutoSubmitSucceeded: false,
          captchaSubmittedText: captchaText,
          captchaAttemptCount: attempt,
          captchaAutoResolveError: 'Captcha input not found',
        },
      };
    }

    const urlBeforeSubmit = page.url();

    await input.focus().catch(() => {});
    await sleep(100);
    await setNativeValue(page, input, '');
    await sleep(100);
    await setNativeValue(page, input, captchaText);
    await sleep(250);

    const clickedContinue = await clickFirstMatchingText(page, CONTINUE_LABELS).catch(() => false);
    if (!clickedContinue) {
      console.warn(`[${label}] Captcha continue button not found, fallback to Enter`);
      await page.keyboard.press('Enter').catch(() => {});
    } else {
      console.log(`[${label}] Captcha continue button clicked`);
    }

    console.log(`[${label}] Captcha OCR text submitted (attempt ${attempt}): ${captchaText}`);

    const cleared = await waitFor(
      page,
      async () => {
        const stillCaptcha = await detectCaptchaCheckpoint(page);
        return stillCaptcha ? null : true;
      },
      { timeoutMs: 10000, intervalMs: 400 }
    ).catch(() => null);

    if (cleared) {
      console.log(`[${label}] Captcha cleared after submit (attempt ${attempt})`);
      const needNewCookies = await detectNeedNewCookiesPage(page);
      if (needNewCookies?.detected) {
        return {
          resolved: false,
          details: await collectNeedNewCookiesDetails(page, label, {
            captchaAutoSubmitAttempted: true,
            captchaAutoSubmitSucceeded: true,
            captchaSubmittedText: captchaText,
            captchaContinueClicked: clickedContinue === true,
            captchaAttemptCount: attempt,
            captchaRetryTriggered: attempt > 1,
            captchaMismatchMessageDetected: false,
            captchaPageDidNotMove: false,
          }),
        };
      }

      return {
        resolved: true,
        details: {
          ...details,
          captchaAutoSubmitAttempted: true,
          captchaAutoSubmitSucceeded: true,
          captchaSubmittedText: captchaText,
          captchaContinueClicked: clickedContinue === true,
          captchaAttemptCount: attempt,
          captchaRetryTriggered: attempt > 1,
          captchaAutoResolveError: null,
        },
      };
    }

    const urlAfterSubmit = page.url();
    const pageDidNotMove = urlAfterSubmit === urlBeforeSubmit;
    const mismatchDetected = await hasCaptchaMismatchMessage(page);
    const shouldRetry =
      attempt < CAPTCHA_AUTO_SUBMIT_MAX_ATTEMPTS &&
      pageDidNotMove &&
      mismatchDetected;

    console.warn(
      `[${label}] Captcha still present after submit`,
      JSON.stringify({
        attempt,
        pageDidNotMove,
        mismatchDetected,
        shouldRetry,
        urlBeforeSubmit,
        urlAfterSubmit,
      })
    );

    const latestDetails = await collectCaptchaCheckpointDetails(page, label, cUser);
    lastFailure = {
      resolved: false,
      details: {
        ...latestDetails,
        captchaAutoSubmitAttempted: true,
        captchaAutoSubmitSucceeded: false,
        captchaSubmittedText: captchaText,
        captchaContinueClicked: clickedContinue === true,
        captchaAttemptCount: attempt,
        captchaRetryTriggered: shouldRetry,
        captchaMismatchMessageDetected: mismatchDetected,
        captchaPageDidNotMove: pageDidNotMove,
        captchaAutoResolveError: shouldRetry
          ? 'Captcha mismatch detected, retrying OCR submit'
          : 'Captcha still present after OCR submit',
      },
    };

    if (shouldRetry) {
      console.warn(
        `[${label}] Captcha mismatch detected and page did not move, retrying OCR submit (${attempt + 1}/${CAPTCHA_AUTO_SUBMIT_MAX_ATTEMPTS})`
      );
      await sleep(500);
      continue;
    }

    return lastFailure;
  }

  return lastFailure || {
    resolved: false,
    details: {
      type: 'captcha_required',
      captchaAutoSubmitAttempted: true,
      captchaAutoSubmitSucceeded: false,
      captchaAutoResolveError: 'Captcha retry exhausted',
    },
  };
}

async function resolveCaptchaCheckpointIfPresent(page, label = 'Automation', cUser = 'unknown') {
  if (!(await detectCaptchaCheckpoint(page))) {
    return false;
  }

  const result = await tryResolveCaptchaCheckpoint(page, label, cUser);
  if (result?.resolved) {
    console.log(`[${label}] Captcha checkpoint resolved via OCR`);
    return true;
  }

  const errorType = String(result?.details?.type || '').toLowerCase();
  if (errorType === 'need_new_cookies') {
    throw new AutomationError(`${label}: Need new cookies`, result?.details || null);
  }
  if (errorType === 'account_restricted') {
    throw new AutomationError(`${label}: Account restricted detected`, result?.details || null);
  }

  throw new AutomationError(`${label}: Captcha checkpoint detected`, result?.details || null);
}

async function resolveTwoFactorChallenge(page, { twofaSecret = null, label = 'Automation', cUser = 'unknown' } = {}) {
  const challengeDetected = await hasTwoFactorChallenge(page);
  if (!challengeDetected) return false;

  console.log(`[${label}] Two-factor challenge detected, resolving via TOTP...`);

  const initialRestricted = await getNeedNewCookiesDetailsIfPresent(page, label, {
    authStage: 'twofactor_initial',
  });
  if (initialRestricted) {
    throw new AutomationError(`${label}: Need new cookies`, initialRestricted);
  }

  await advanceHumanConfirmation(page, label).catch(() => false);

  const postHumanRestricted = await getNeedNewCookiesDetailsIfPresent(page, label, {
    authStage: 'twofactor_post_human_confirmation',
  });
  if (postHumanRestricted) {
    throw new AutomationError(`${label}: Need new cookies`, postHumanRestricted);
  }

  await resolveCaptchaCheckpointIfPresent(page, label, cUser);

  const postCaptchaRestricted = await getNeedNewCookiesDetailsIfPresent(page, label, {
    authStage: 'twofactor_post_captcha',
  });
  if (postCaptchaRestricted) {
    throw new AutomationError(`${label}: Need new cookies`, postCaptchaRestricted);
  }

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

  await resolveCaptchaCheckpointIfPresent(page, label, cUser);

  const postMethodRestricted = await getNeedNewCookiesDetailsIfPresent(page, label, {
    authStage: 'twofactor_post_method_selection',
  });
  if (postMethodRestricted) {
    throw new AutomationError(`${label}: Need new cookies`, postMethodRestricted);
  }

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

      if (await detectCaptchaCheckpoint(page)) {
        return 'captcha';
      }

      const restricted = await detectNeedNewCookiesPage(page);
      if (restricted?.detected) {
        return 'restricted';
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

  if (input === 'captcha') {
    await resolveCaptchaCheckpointIfPresent(page, label, cUser);
    return resolveTwoFactorChallenge(page, { twofaSecret, label, cUser });
  }

  if (input === 'restricted') {
    const restrictedDetails = await collectNeedNewCookiesDetails(page, label, {
      authStage: 'twofactor_wait_for_input',
    });
    throw new AutomationError(`${label}: Need new cookies`, restrictedDetails);
  }

  if (!input) {
    const restrictedDetails = await getNeedNewCookiesDetailsIfPresent(page, label, {
      authStage: 'twofactor_input_missing',
    });
    if (restrictedDetails) {
      throw new AutomationError(`${label}: Need new cookies`, restrictedDetails);
    }

    const debug = await captureDebugScreenshot(page, 'twofa-input-not-found', cUser).catch(() => null);
    const diag = await getAuthPageDiagnostics(page);
    const details = {
      type: 'twofa_input_not_found',
      url: diag.url || page.url(),
      title: diag.title,
      text: diag.text,
      screenshotPath: debug?.path || null,
      debugPath: debug?.path || null,
      cUser: cUser || null,
    };
    console.warn(
      `[${label}] Two-factor code input not found`,
      JSON.stringify(details)
    );
    throw new AutomationError(`${label}: Two-factor code input not found`, details);
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
          !!document.querySelector('[aria-label="Inbox"], [aria-label="Kotak Masuk"], [aria-label*="Inbox" i], [aria-label*="Kotak Masuk" i]')
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

async function detectAccountRestricted(page, label = 'Automation', cUser = 'unknown') {
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
      'akun dibatasi',
      'pesan dibatasi',
      'anda tidak dapat mengirim atau menerima pesan',
      'tidak dapat mengirim atau menerima pesan',
      'fitur pesan akun anda',
      'tidak mematuhi whatsapp',
      'minta peninjauan',
      'ajukan peninjauan',
    ];
    const hit = indicators.find((entry) => text.includes(entry));
    if (hit) {
      const details = await collectAccountRestrictedDetails(page, label, { cUser, indicator: hit });
      throw new AutomationError(`${label}: Account restricted detected`, details);
    }
  } catch (error) {
    if (error instanceof AutomationError) {
      throw error;
    }
    // Ignore detection failures
  }
}

async function ensureOnInbox(page, label = 'Automation', { twofaSecret = null, cUser = 'unknown' } = {}) {
  await dismissSaveLoginInfo(page, label);
  await dismissAutomatedBehaviorNotice(page, label);

  let url = page.url();
  if (isBadAuthUrl(url)) {
    const resolved = await resolveTwoFactorChallenge(page, { twofaSecret, label, cUser });
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
      const resolved = await resolveTwoFactorChallenge(page, { twofaSecret, label, cUser });
      if (!resolved) {
        throw new AutomationError(
          `${label}: Redirected to auth/checkpoint URL: ${nextUrl}`,
          { url: nextUrl }
        );
      }
      nextUrl = page.url();
    }
    const dismissedAutomatedBehavior = await dismissAutomatedBehaviorNotice(page, label);
    if (dismissedAutomatedBehavior && !nextUrl.includes('business.facebook.com')) {
      await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(800);
      nextUrl = page.url();
    }
    if (!nextUrl.includes('business.facebook.com') || (!nextUrl.includes('inbox') && !nextUrl.includes('messages'))) {
      throw new AutomationError(`${label}: Unexpected URL after reload: ${nextUrl}`, { url: nextUrl });
    }
  }
  await dismissSaveLoginInfo(page, label);
  await dismissAutomatedBehaviorNotice(page, label);
  await dismissInboxBlockingPrompts(page, label);
  await detectAccountRestricted(page, label, cUser);
  const needNewCookiesDetails = await getNeedNewCookiesDetailsIfPresent(page, label, { cUser });
  if (needNewCookiesDetails) {
    const reason = String(needNewCookiesDetails.reason || needNewCookiesDetails.indicator || '');
    const message = reason === 'business_access_missing'
      ? `${label}: Meta Business Suite access missing`
      : `${label}: Need new cookies`;
    throw new AutomationError(message, needNewCookiesDetails);
  }
}

async function waitForMainSpinner(page, { timeoutMs = 30000 } = {}) {
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const visible = await page.evaluate(() => {
        const spinner = document.querySelector('[role="progressbar"], [data-testid*="spinner"], [aria-label*="Loading" i], [aria-label*="Memuat" i]');
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
  let spinnerOk = await waitForMainSpinner(page, { timeoutMs: SPINNER_TIMEOUT_MS });
  let spinnerRefreshAttempted = false;
  if (!spinnerOk && options.refreshOnSpinnerTimeout !== false) {
    spinnerRefreshAttempted = true;
    console.warn(`[${label}] Inbox spinner still visible after ${SPINNER_TIMEOUT_MS}ms; refreshing once`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(1500);
      await ensureOnInbox(page, label, options);
      spinnerOk = await waitForMainSpinner(page, { timeoutMs: SPINNER_TIMEOUT_MS });
    } catch (error) {
      throw new AutomationError(`${label}: Inbox refresh after spinner timeout failed`, {
        type: 'inbox_not_ready',
        reason: 'spinner_refresh_failed',
        stage: 'ensure_inbox_ready.spinner_refresh',
        label,
        url: page.url(),
        error: error?.message || String(error),
      });
    }
  }
  if (!spinnerOk) {
    throw new AutomationError(`${label}: Inbox still loading (spinner timeout)`, {
      type: 'inbox_not_ready',
      reason: spinnerRefreshAttempted ? 'spinner_timeout_after_refresh' : 'spinner_timeout',
      stage: 'ensure_inbox_ready.spinner',
      label,
      spinnerWaitMs: SPINNER_TIMEOUT_MS,
      spinnerRefreshAttempted,
      url: page.url(),
    });
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

async function findFirstVisibleInRoot(page, root, selector) {
  if (!root || !root.$$) return null;
  const elements = await root.$$(selector);
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
    if (!(await isVisible(page, row))) continue;
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
        const heading =
          node.querySelector('[role="heading"]') ||
          node.querySelector('h1,h2,h3,h4,h5,h6') ||
          node.querySelector('div._ohe');
        if (heading && (heading.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase() === 'PEOPLE') {
          return true;
        }
        const previousText = (node.previousElementSibling?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toUpperCase();
        if (previousText === 'PEOPLE') {
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

async function findSearchResultByNumber(page, searchInput, digits) {
  const roots = [];

  if (searchInput) {
    const controlsId = await searchInput.evaluate((el) => el.getAttribute('aria-controls') || '');
    if (controlsId) {
      const controlled = await page.$(`#${controlsId}`);
      if (controlled && await isVisible(page, controlled)) {
        roots.push(controlled);
      }
    }
  }

  const fallbackRoots = await page.$$('[role="listbox"], [data-testid="ContextualLayerRoot"]');
  for (const root of fallbackRoots) {
    if (await isVisible(page, root)) {
      roots.push(root);
    }
  }

  let firstMatch = null;
  for (const root of roots) {
    const candidates = await root.$$('[role="option"], li, [role="row"], [role="button"], a');
    for (const candidate of candidates) {
      if (!(await isVisible(page, candidate))) continue;
      const text = await candidate.evaluate((el) => (el.textContent || el.innerText || '').trim());
      if (!normalizeDigits(text).includes(digits)) continue;
      if (await isPeopleSectionItem(page, candidate)) {
        return candidate;
      }
      if (!firstMatch) {
        firstMatch = candidate;
      }
    }
  }

  return firstMatch;
}

async function findPeopleResultByNumber(page, digits, searchInput = null) {
  const genericResult = await findSearchResultByNumber(page, searchInput, digits);
  if (genericResult) {
    return genericResult;
  }

  const items = await page.$$('li._7znk');
  for (const item of items) {
    if (!(await isVisible(page, item))) continue;
    const text = await page.evaluate((el) => el.textContent || '', item);
    if (normalizeDigits(text).includes(digits) && (await isPeopleSectionItem(page, item))) {
      return item;
    }
  }
  return null;
}

async function findReplyInput(page) {
  const candidates = await page.$$('[contenteditable="true"][role="textbox"], textarea');
  let fallback = null;

  for (const candidate of candidates) {
    if (!(await isVisible(page, candidate))) continue;
    const bag = await candidate.evaluate((el) => {
      return [
        el.getAttribute('aria-placeholder') || '',
        el.getAttribute('placeholder') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
      ].join(' ');
    });
    const normalizedBag = normalizeText(bag);
    if (REPLY_INPUT_HINTS.some((hint) => normalizedBag.includes(hint))) {
      return candidate;
    }
    if (!fallback) {
      fallback = candidate;
    }
  }

  return fallback;
}

async function fillReplyMessage(page, message) {
  console.log('[Automation] Reply flow: waiting for reply box');
  const replyBox = await waitFor(
    page,
    async () => findReplyInput(page),
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
  const handle = await replyBox.evaluateHandle((el, replySendLabels) => {
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i += 1) {
      const btn =
        node.querySelector('div[role="button"][aria-label="Send"]') ||
        node.querySelector('div[role="button"][aria-label="Submit"]') ||
        node.querySelector('div[role="button"][aria-label*="Send"]') ||
        node.querySelector('div[role="button"][aria-label*="Kirim" i]') ||
        node.querySelector('div[role="button"][aria-label*="Balas" i]') ||
        Array.from(node.querySelectorAll('div[role="button"],button')).find((candidate) => {
          const bag = `${candidate.textContent || ''} ${candidate.getAttribute('aria-label') || ''} ${candidate.getAttribute('title') || ''}`
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          return replySendLabels.some((label) => bag === label || bag.includes(label));
        });
      if (btn) return btn;
      node = node.parentElement;
    }
    return null;
  }, REPLY_SEND_LABELS);
  return handle.asElement();
}

async function clickReplySend(page, replyBox) {
  console.log('[Automation] Reply flow: waiting for submit button');
  const button = await waitFor(
    page,
    async () => {
      const candidate = await findScopedReplyButton(page, replyBox);
      if (!candidate) return null;
      if (!(await isVisible(page, candidate))) return null;
      if (!(await isElementEnabled(candidate))) return null;
      return candidate;
    },
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
      async () => findPeopleResultByNumber(page, phoneDigits, searchInput),
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

async function isElementEnabled(elementHandle) {
  if (!elementHandle) return false;
  try {
    return await elementHandle.evaluate((el) => {
      if (el.hasAttribute('disabled')) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      if (el.getAttribute('data-disabled') === 'true') return false;
      return true;
    });
  } catch {
    return false;
  }
}

async function findVisibleThreadRow(page) {
  const rows = await page.$$('span[data-surface="/bizweb:all/thread_row"]');
  for (const row of rows) {
    if (await isVisible(page, row)) {
      return row;
    }
  }
  return null;
}

async function findDialogPhoneInput(page, dialog) {
  if (!dialog) return null;
  return findFirstVisibleInRoot(page, dialog, 'input[type="tel"], input[inputmode="tel"]');
}

async function findDialogMessageInput(page, dialog) {
  if (!dialog) {
    return { textarea: null, editable: null };
  }
  const textarea = await findFirstVisibleInRoot(page, dialog, 'textarea');
  if (textarea) {
    return { textarea, editable: null };
  }
  const editable = await findFirstVisibleInRoot(page, dialog, '[contenteditable="true"]');
  return { textarea: null, editable };
}

async function findDialogSendButton(page, dialog, { requireEnabled = false } = {}) {
  if (!dialog) return null;

  let btn = null;
  for (const label of SEND_MESSAGE_LABELS) {
    btn = await findByText(page, {
      root: dialog,
      text: label,
      selector: '[role="button"],button,div[role="button"]',
    });
    if (btn) break;
  }

  if (!btn) return null;

  const role = await btn.evaluate((el) => el.getAttribute('role'));
  if (role !== 'button') {
    const parentBtnHandle = await btn.evaluateHandle((el) => el.closest('[role="button"],button'));
    const parentBtn = await parentBtnHandle.asElement();
    if (parentBtn) {
      btn = parentBtn;
    }
  }

  if (!(await isVisible(page, btn))) {
    return null;
  }
  if (requireEnabled && !(await isElementEnabled(btn))) {
    return null;
  }
  return btn;
}

async function findWhatsappModalTrigger(page) {
  let btn = await findFirstVisible(
    page,
    'div[role="button"][data-surface*="whatsapp_biz_init_thread_header_button"]'
  );
  if (btn) {
    return btn;
  }

  for (const label of OPEN_WHATSAPP_MODAL_LABELS) {
    btn = await findByText(page, {
      text: label,
      selector: '[role="button"],button,div[role],a',
    });
    if (btn) {
      return btn;
    }
  }

  return null;
}

async function logWhatsappModalTriggerDebug(page) {
  try {
    const pageState = await page.evaluate(() => {
      const visibleButtons = Array.from(document.querySelectorAll('[role="button"],button,a'))
        .map((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            text: (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim(),
            ariaLabel: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            dataSurface: el.getAttribute('data-surface') || '',
            role: el.getAttribute('role') || '',
            tagName: el.tagName || '',
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0',
          };
        })
        .filter((item) => item.visible && (item.text || item.ariaLabel || item.dataSurface))
        .slice(0, 25);

      return {
        title: document.title,
        url: window.location.href,
        dialogCount: document.querySelectorAll('[role="dialog"]').length,
        threadRowCount: document.querySelectorAll('span[data-surface="/bizweb:all/thread_row"]').length,
        headerTriggerCount: document.querySelectorAll('div[role="button"][data-surface*="whatsapp_biz_init_thread_header_button"]').length,
        visibleButtons,
      };
    });
    console.error('[Automation] Step 1: Debug page state:', JSON.stringify(pageState, null, 2));
  } catch (error) {
    console.error('[Automation] Step 1: Failed to capture debug state:', error.message);
  }
}

/**
 * Open WhatsApp modal
 */
async function openWhatsappModal(page) {
  console.log('[Automation] Step 1: Opening WhatsApp modal...');

  let btn = await waitFor(
    page,
    async () => findWhatsappModalTrigger(page),
    { timeoutMs: 5000, intervalMs: 200 }
  ).catch(() => null);

  if (!btn) {
    console.log('[Automation] Step 1: Trigger button not ready, trying to activate thread header...');
    const firstRow = await waitFor(
      page,
      async () => findVisibleThreadRow(page),
      { timeoutMs: 3000, intervalMs: 200 }
    ).catch(() => null);

    if (firstRow) {
      await clickElement(page, firstRow, 'Step 1: Activate thread row');
      await sleep(500);
      btn = await waitFor(
        page,
        async () => findWhatsappModalTrigger(page),
        { timeoutMs: 8000, intervalMs: 200 }
      ).catch(() => null);
    } else {
      console.log('[Automation] Step 1: No visible thread row available for fallback');
    }
  }

  if (!btn) {
    await logWhatsappModalTriggerDebug(page);
    throw new AutomationError('Step 1: Could not find WhatsApp modal trigger button');
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

async function isDirectComposeFormVisible(page, dialog = null) {
  const currentDialog = dialog || await findFirstVisible(page, '[role="dialog"]');
  if (!currentDialog) return false;

  const comboBoxes = await currentDialog.$$('[role="combobox"][aria-haspopup="listbox"]');
  let hasExtensionCombo = false;
  for (const combo of comboBoxes) {
    if (!(await isVisible(page, combo))) continue;

    const text = await combo.evaluate((el) => (el.textContent || el.innerText || '').trim());
    if (text.includes('+')) {
      hasExtensionCombo = true;
      break;
    }
  }

  const phoneInput = await findDialogPhoneInput(page, currentDialog);
  const { textarea, editable } = await findDialogMessageInput(page, currentDialog);

  return hasExtensionCombo && phoneInput !== null && (textarea !== null || editable !== null);
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

  if (await isDirectComposeFormVisible(page, dialog)) {
    console.log('[Automation] Step 2: Compose form already visible, skipping "New WhatsApp number" click');
    return { skipped: true, reason: 'compose_form_visible' };
  }

  // Strategy 1: Use data-surface attribute (most reliable)
  let target = await findFirstVisibleInRoot(
    page,
    dialog,
    'div[role="button"][data-surface*="business-initiate-thread-search-contacts-button"]'
  );

  if (target) {
    console.log('[Automation] Step 2: Found button by data-surface attribute');
  }

  // Strategy 2: Find by exact text match
  if (!target) {
    console.log('[Automation] Step 2: Trying exact text...');
    for (const label of NEW_WHATSAPP_NUMBER_LABELS) {
      target = await findByText(page, {
        root: dialog,
        text: label,
        selector: '[role="button"],button,div[role="button"]',
      });
      if (target) break;
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
  return { skipped: false, reason: 'clicked_new_whatsapp_number' };
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

  let selectedOption = null;
  for (const option of options) {
    if (!(await isVisible(page, option))) continue;
    const optionText = await option.evaluate((el) => (el.textContent || el.innerText || '').trim());
    const optionDigits = normalizeDigits(optionText);
    const normalizedOptionText = normalizeText(optionText);
    if (
      normalizedOptionText.includes(`+${wantDigits}`) ||
      optionDigits === wantDigits ||
      optionDigits.startsWith(wantDigits)
    ) {
      selectedOption = option;
      break;
    }
  }

  if (!selectedOption) {
    throw new AutomationError(`Step 3: No matching option found for extension "${wantDigits}"`);
  }

  await selectedOption.scrollIntoViewIfNeeded();
  await sleep(200);
  await clickElement(page, selectedOption, 'Step 3: Select extension option');
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
      const input = await findDialogPhoneInput(page, dialog);
      return input !== null;
    },
    { timeoutMs: 10000 }
  );

  const input = await findDialogPhoneInput(page, dialog);

  if (!input) {
    throw new AutomationError('Step 4: Could not find phone input in dialog');
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
      const { textarea, editable } = await findDialogMessageInput(page, dialog);
      return textarea !== null || editable !== null;
    },
    { timeoutMs: 10000 }
  );

  // Try textarea first
  const { textarea, editable } = await findDialogMessageInput(page, dialog);
  if (textarea) {
    console.log('[Automation] Step 5: Found textarea, filling...');
    await setNativeValue(page, textarea, message);
    await sleep(200);
    console.log('[Automation] Step 5: ✓ Message filled successfully (textarea)');
    return;
  }

  // Some Meta inputs use contenteditable divs
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

  const btn = await waitFor(
    page,
    async () => findDialogSendButton(page, dialog, { requireEnabled: true }),
    { timeoutMs: 10000, intervalMs: 200 }
  ).catch(() => null);

  if (!btn) {
    throw new AutomationError('Step 6: Could not find enabled "Send message" button');
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
    requestId = null,
  }
) {
  if (!extension || !phoneNumber || !message) {
    throw new AutomationError('Missing required fields: extension, phoneNumber, message');
  }

  const normalizedRequestId = normalizeRequestId(sessionId, requestId);
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
    const newNumberResult = await clickNewWhatsappNumber(page);
    logStep('send:new_number', newNumberResult);

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
      await writeRequestLog(normalizedRequestId, {
        requestId: normalizedRequestId,
        type: 'send',
        steps,
        screenshotPath: successScreenshot?.path || null,
        url: successScreenshot?.url || null,
      });
      return {
        ok: true,
        screenshot: successScreenshot,
        requestId: normalizedRequestId,
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
    const captchaLog = getCaptchaLogDetails(lastError?.details || null);
    await writeRequestLog(normalizedRequestId, {
      requestId: normalizedRequestId,
      type: 'send',
      steps,
      error: lastError.message,
      screenshotPath: debug.path,
      url: debug.url,
      ...(captchaLog || {}),
    });
    if (lastError instanceof AutomationError) {
      lastError.details = {
        ...(lastError.details || {}),
        requestId: lastError?.details?.requestId || normalizedRequestId,
        url: lastError?.details?.url || debug.url,
        screenshotPath: lastError?.details?.screenshotPath || debug.path,
      };
      throw lastError;
    }
    throw new AutomationError(`Automation failed: ${lastError.message}`, {
      requestId: normalizedRequestId,
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
export async function checkSessionFlow(
  page,
  {
    sessionId = null,
    cUser = null,
    twofaSecret = null,
    requestId = null,
    maxAttempts: maxAttemptsOverride = null,
    skipInitialReload = false,
  } = {}
) {
  console.log('[Automation] ========================================');
  console.log('[Automation] Starting WhatsApp session check');
  console.log(`[Automation] Current URL: ${page.url()}`);

  const normalizedRequestId = normalizeRequestId(sessionId, requestId);
  const steps = [];
  const logStep = (label, extra = {}) => {
    steps.push({ at: new Date().toISOString(), label, ...extra });
  };
  logStep('check:start', { sessionId });

  const maxAttempts =
    Number.isFinite(Number(maxAttemptsOverride)) && Number(maxAttemptsOverride) > 0
      ? Number(maxAttemptsOverride)
      : 3;
  const backoffMs = [2000, 5000, 10000];
  const shouldRetry = (error) =>
    error instanceof AutomationError && !isAuthRelatedError(error);

  const refreshForCheck = async (label) => {
    console.log(`[Automation] Refreshing page for check${label ? ` (${label})` : ''}...`);
    try {
      await throwIfAuthBlocked(page, 'Check', {
        cUser,
        stage: 'check_session.before_reload',
      });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(1500);
      await throwIfAuthBlocked(page, 'Check', {
        cUser,
        stage: 'check_session.after_reload',
      });
      await ensureInboxReady(page, 'Check', { twofaSecret });
      console.log('[Automation] ✓ Page refreshed');
      logStep('check:refresh_ok', { label });
    } catch (error) {
      if (isAuthRelatedError(error)) {
        throw error;
      }
      console.warn(`[Automation] Refresh failed: ${error.message}. Retrying...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
      await sleep(1500);
      await throwIfAuthBlocked(page, 'Check', {
        cUser,
        stage: 'check_session.after_reload_retry',
      });
      await ensureInboxReady(page, 'Check', { twofaSecret });
      console.log('[Automation] ✓ Page refreshed (retry)');
      logStep('check:refresh_retry_ok', { label });
    }
  };

  const runCheck = async () => {
    await throwIfAuthBlocked(page, 'Check', {
      cUser,
      stage: 'check_session.before_indicators',
    });
    const inboxReady = await waitFor(
      page,
      async () => {
        const ready = await page.evaluate(() => {
          return (
            !!document.querySelector('span[data-surface="/bizweb:all/thread_row"]') ||
            !!document.querySelector('[data-pagelet*="BizInbox"]') ||
            !!document.querySelector('input[role="combobox"][placeholder="Search"]') ||
            !!document.querySelector('[aria-label="Inbox"], [aria-label="Kotak Masuk"], [aria-label*="Inbox" i], [aria-label*="Kotak Masuk" i]')
          );
        }).catch(() => false);
        return ready ? true : null;
      },
      { timeoutMs: 10000, intervalMs: 300 }
    ).catch(() => null);

    if (!inboxReady) {
      const needNewCookiesDetails = await getNeedNewCookiesDetailsIfPresent(page, 'Check', { cUser });
      if (needNewCookiesDetails) {
        const reason = String(needNewCookiesDetails.reason || needNewCookiesDetails.indicator || '');
        const message = reason === 'business_access_missing'
          ? 'Check: Meta Business Suite access missing'
          : 'Check: Need new cookies';
        throw new AutomationError(message, needNewCookiesDetails);
      }

      throw new AutomationError('Check: Inbox indicators not found', {
        type: 'inbox_not_ready',
        reason: 'inbox_indicators_not_found',
        stage: 'check_session.inbox_indicators',
        sessionId,
        url: page.url(),
      });
    }

    logStep('check:inbox_ready');
  };

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt === 1 && skipInitialReload) {
        await ensureInboxReady(page, 'Check', { twofaSecret, cUser });
        logStep('check:reload_skipped', { reason: 'already_validated' });
      } else if (attempt === 1) {
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
      await writeRequestLog(normalizedRequestId, { requestId: normalizedRequestId, type: 'check', steps });
      return { ok: true, requestId: normalizedRequestId };
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
  const captchaLog = getCaptchaLogDetails(lastError?.details || null);
  await writeRequestLog(normalizedRequestId, {
    requestId: normalizedRequestId,
    type: 'check',
    steps,
    error: lastError?.message || 'unknown error',
    errorType: lastError?.details?.type || null,
    errorDetails: lastError?.details || null,
    screenshotPath: debug.path,
    url: debug.url,
    ...(captchaLog || {}),
  });
  if (lastError instanceof AutomationError) {
    lastError.details = {
      ...(lastError.details || {}),
      requestId: lastError?.details?.requestId || normalizedRequestId,
      url: lastError?.details?.url || debug.url,
      screenshotPath: lastError?.details?.screenshotPath || debug.path,
    };
    throw lastError;
  }
  throw new AutomationError(
    `Session check failed: ${lastError?.message || 'unknown error'}`,
    { requestId: normalizedRequestId, url: debug.url, screenshotPath: debug.path, cause: lastError }
  );
}
