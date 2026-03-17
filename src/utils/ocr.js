import fs from 'fs';
import { config } from '../config.js';

const OCR_TIMEOUT_MS = 15000;
const OCR_RETRY_PATTERN = [1000, 3000];
const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise((_, reject) => {
      const timeoutError = new Error('Request timed out');
      timeoutError.code = 'ETIMEOUT';
      timer = setTimeout(() => reject(timeoutError), OCR_TIMEOUT_MS);
    }),
  ]);
}

function getErrorCode(error) {
  return String(error?.code || error?.cause?.code || '').trim().toUpperCase();
}

function getRequestHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'API-key': apiKey,
  };
}

async function getImageBase64(imagePath) {
  const buffer = await fs.promises.readFile(imagePath);
  if (!buffer || buffer.length === 0) {
    throw new Error(`OCR image file is empty: ${imagePath}`);
  }
  return buffer.toString('base64');
}

function extractBase64Payload(imageInput) {
  const value = String(imageInput || '').trim();
  if (!value) {
    throw new Error('OCR image input is required');
  }
  if (value.includes('base64,')) {
    return value.split('base64,')[1];
  }
  return value;
}

export function isOcrConfigured() {
  return Boolean(config.ocrUrl && config.ocrApikey);
}

export async function easyOCR(imageCropPath) {
  const apiUrl = config.ocrUrl;
  const apiKey = config.ocrApikey;

  if (!apiUrl || !apiKey) {
    console.warn('[OCR] easyOCR skipped: OCR_URL or OCR_API_KEY missing');
    return null;
  }

  const headers = getRequestHeaders(apiKey);

  let base64Image;
  try {
    if (fs.existsSync(imageCropPath)) {
      await fs.promises.access(imageCropPath, fs.constants.F_OK);
      console.log(`[OCR] File ada: ${imageCropPath}`);
      base64Image = await getImageBase64(imageCropPath);
    } else {
      base64Image = extractBase64Payload(imageCropPath);
    }
  } catch (prepErr) {
    console.error('[OCR] easyOCR prep error:', prepErr);
    throw prepErr;
  }

  const payload = JSON.stringify({
    base64: base64Image,
  });

  let attempt = 1;
  const maxAttempts = OCR_RETRY_PATTERN.length + 1;

  while (attempt <= maxAttempts) {
    try {
      const response = await withTimeout(fetch(apiUrl, {
        method: 'POST',
        headers,
        body: payload,
      }));

      if (!response.ok) {
        const httpError = new Error(`HTTP error! Status: ${response.status}`);
        httpError.status = response.status;
        throw httpError;
      }

      const data = await response.json();
      const responseCaptcha = String(data?.result || '').trim();
      console.log('[OCR] Captcha result:', responseCaptcha);
      if (!responseCaptcha) {
        console.warn('[OCR] easyOCR returned empty result');
      }
      return responseCaptcha;
    } catch (err) {
      const errorCode = getErrorCode(err);
      const transient = TRANSIENT_ERROR_CODES.has(errorCode);

      if (!transient) {
        console.error('[OCR] easyOCR non-retriable error:', err);
        throw err;
      }

      if (attempt >= maxAttempts) {
        console.error(`[OCR] easyOCR retry exhausted (${attempt} attempts):`, err);
        throw err;
      }

      const delay = OCR_RETRY_PATTERN[attempt - 1];
      console.warn(
        `[OCR] easyOCR transient error (${errorCode || err.message}) retry ${attempt}/${maxAttempts - 1} in ${delay / 1000}s`
      );
      await sleep(delay);
      attempt += 1;
    }
  }

  return null;
}
