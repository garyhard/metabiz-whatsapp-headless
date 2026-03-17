function looksLikeHtmlResponse(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes('<!doctype html') ||
    text.includes('<html') ||
    text.includes('</html>') ||
    text.includes('<body') ||
    /^syntaxerror:\s*unexpected token </i.test(text)
  );
}

function extractHttpStatusHint(value) {
  const match = String(value || '').match(/\b(?:http\s+)?(\d{3})\b/i);
  return match ? match[1] : null;
}

function detectHtmlResponseKind(value) {
  const text = String(value || '').toLowerCase();
  if (
    text.includes('loginpage') ||
    text.includes('checkpoint') ||
    text.includes('redirected to auth') ||
    text.includes('business/loginpage') ||
    text.includes('confirm your identity') ||
    text.includes('video selfie')
  ) {
    return 'meta_auth_html';
  }

  if (
    text.includes('cloudflare') ||
    text.includes('nginx') ||
    text.includes('bad gateway') ||
    text.includes('service unavailable') ||
    text.includes('gateway timeout')
  ) {
    return 'proxy_html';
  }

  return 'unexpected_html';
}

export function sanitizeApiErrorMessage(value, fallback = 'Unexpected error') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!looksLikeHtmlResponse(raw)) return raw;

  const statusHint = extractHttpStatusHint(raw);
  const suffix = statusHint ? ` (HTTP ${statusHint})` : '';

  switch (detectHtmlResponseKind(raw)) {
    case 'meta_auth_html':
      return `Unexpected HTML login/checkpoint page detected. Meta likely redirected automation back to auth.${suffix}`;
    case 'proxy_html':
      return `Unexpected HTML error page detected before JSON response. Check reverse proxy or upstream health.${suffix}`;
    default:
      return `Unexpected HTML response detected. API should return JSON only.${suffix}`;
  }
}

export function buildApiErrorMeta(value) {
  const raw = String(value || '').trim();
  if (!raw || !looksLikeHtmlResponse(raw)) {
    return {};
  }

  const statusHint = extractHttpStatusHint(raw);
  return {
    responseFormat: 'html',
    responseKind: detectHtmlResponseKind(raw),
    ...(statusHint ? { httpStatusHint: statusHint } : {}),
  };
}

export function buildJsonErrorBody(error, fallback = 'Unexpected error', extra = {}) {
  const rawMessage = error?.message || error;
  const body = {
    ok: false,
    error: sanitizeApiErrorMessage(rawMessage, fallback),
    ...extra,
  };
  const meta = buildApiErrorMeta(rawMessage);
  if (Object.keys(meta).length > 0) {
    const existingDetails = extra?.details && typeof extra.details === 'object' ? extra.details : {};
    body.details = { ...existingDetails, ...meta };
  }
  return body;
}

