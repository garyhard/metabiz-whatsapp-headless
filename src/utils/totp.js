import crypto from 'crypto';

function normalizeBase32Secret(secret) {
  return String(secret || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
}

function decodeBase32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = normalizeBase32Secret(secret);
  if (!normalized) return Buffer.alloc(0);

  let bits = '';
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotpCode(secret, options = {}) {
  const digits = Number(options.digits || 6);
  const period = Number(options.period || 30);
  const timestamp = Number(options.timestamp || Date.now());

  if (!Number.isInteger(digits) || digits <= 0) {
    throw new Error('digits must be a positive integer');
  }
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error('period must be a positive integer');
  }

  const key = decodeBase32(secret);
  if (!key.length) {
    throw new Error('twofaSecret is required');
  }

  const counter = Math.floor(timestamp / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const modulo = 10 ** digits;
  const code = String(binary % modulo).padStart(digits, '0');
  const secondsRemaining = period - (Math.floor(timestamp / 1000) % period);

  return {
    code,
    digits,
    period,
    counter,
    timestamp,
    secondsRemaining,
  };
}
