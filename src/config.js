/**
 * Configuration for the headless WhatsApp automation service
 */

import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const API_KEY = process.env.API_KEY;
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

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
  proxy: defaultProxy,
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

