/**
 * Configuration for the headless WhatsApp automation service
 */

import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const API_KEY = process.env.API_KEY;
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';
const FLOW_TIMEOUT_MS = parseInt(process.env.FLOW_TIMEOUT_MS || '60000', 10);
const IDLE_TIMEOUT_MINUTES = parseInt(process.env.IDLE_TIMEOUT_MINUTES || '0', 10);

function parseEnvList(value, fallback = []) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

if (!API_KEY) {
  throw new Error('API_KEY environment variable is required');
}

// Proxy configuration from environment variables
let defaultProxy = null;
if (process.env.PROXY_SERVER) {
  defaultProxy = {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME || undefined,
    password: process.env.PROXY_PASSWORD || undefined,
  };
}

export const config = {
  apiKey: API_KEY,
  port: PORT,
  devMode: DEV_MODE,
  flowTimeoutMs: Number.isFinite(FLOW_TIMEOUT_MS) && FLOW_TIMEOUT_MS > 0 ? FLOW_TIMEOUT_MS : 60000,
  idleTimeoutMs: Number.isFinite(IDLE_TIMEOUT_MINUTES) && IDLE_TIMEOUT_MINUTES > 0
    ? IDLE_TIMEOUT_MINUTES * 60 * 1000
    : 0,
  proxy: defaultProxy,
  texts: {
    openWhatsappModal: parseEnvList(
      process.env.WA_TEXT_OPEN_WHATSAPP_MODAL,
      ['Send a Message on WhatsApp', 'Send message on WhatsApp']
    ),
    newWhatsappNumber: parseEnvList(
      process.env.WA_TEXT_NEW_WHATSAPP_NUMBER,
      ['New WhatsApp number', 'New WhatsApp']
    ),
    sendMessage: parseEnvList(
      process.env.WA_TEXT_SEND_MESSAGE,
      ['Send Message', 'Send message']
    ),
  },
  browser: {
    // Allow non-headless mode for debugging (set HEADLESS=false in .env)
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  },
};
