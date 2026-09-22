const META_SEND_LIMIT_TOASTS = [
  'something went wrong. please try again.',
  'terjadi kesalahan. silakan coba lagi.',
];

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isMetaSendLimitToast(text) {
  const normalized = normalize(text);
  return META_SEND_LIMIT_TOASTS.some((toast) => normalized.includes(toast));
}
