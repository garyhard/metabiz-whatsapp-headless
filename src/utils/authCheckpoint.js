const AUTOMATED_BEHAVIOR_HINTS = [
  'we suspect automated behavior on your account',
  'to prevent your account from being temporarily restricted or permanently disabled',
  'make sure that no other users or tools have access to your account',
  'kami mencurigai perilaku otomatis di akun anda',
  'kami mendeteksi perilaku otomatis di akun anda',
];

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function automatedBehaviorIndicator(text) {
  const normalized = normalize(text);
  return AUTOMATED_BEHAVIOR_HINTS.find((hint) => normalized.includes(hint)) || null;
}

export function isExplicitTwoFactorUrl(url) {
  const normalized = normalize(url);
  return (
    normalized.includes('/twofactor') ||
    normalized.includes('/two-factor') ||
    normalized.includes('/two_factor')
  );
}
