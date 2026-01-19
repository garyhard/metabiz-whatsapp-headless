/**
 * Generate unique but realistic browser fingerprints
 * Language and timezone are fixed to English/US to ensure consistent button text matching
 */

const COMMON_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];

const CHROME_VERSIONS = [
  '120.0.0.0',
  '121.0.0.0',
  '120.0.6099.109',
  '121.0.6167.85',
];

const HARDWARE_CONCURRENCY_OPTIONS = [2, 4, 8, 16];
const DEVICE_MEMORY_OPTIONS = [4, 8, 16];

const PLATFORMS = [
  'Win32',
  'MacIntel',
  'Linux x86_64',
];

/**
 * Get a random element from an array
 */
function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * Generate a unique browser fingerprint
 * @returns {Object} Fingerprint object with viewport, userAgent, and other properties
 */
export function generateFingerprint() {
  const resolution = randomChoice(COMMON_RESOLUTIONS);
  const chromeVersion = randomChoice(CHROME_VERSIONS);
  const platform = randomChoice(PLATFORMS);
  const hardwareConcurrency = randomChoice(HARDWARE_CONCURRENCY_OPTIONS);
  const deviceMemory = randomChoice(DEVICE_MEMORY_OPTIONS);

  // Build user agent string
  let userAgent;
  if (platform === 'Win32') {
    userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  } else if (platform === 'MacIntel') {
    userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  } else {
    userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  return {
    viewport: {
      width: resolution.width,
      height: resolution.height,
    },
    userAgent,
    locale: 'en-US', // Fixed to English
    timezoneId: 'America/New_York', // Fixed to US timezone
    platform,
    hardwareConcurrency,
    deviceMemory,
  };
}

