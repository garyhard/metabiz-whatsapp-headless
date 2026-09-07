const DEFAULT_META_INBOX_URL = 'https://business.facebook.com/latest/inbox';
const META_INBOX_ORIGIN = 'https://business.facebook.com';

function firstPresent(source, keys) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  for (const key of keys) {
    const value = String(source[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function digitsOnly(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function parseInboxUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('meta inbox URL is invalid');
  }

  if (url.hostname !== 'business.facebook.com' || !url.pathname.startsWith('/latest/inbox')) {
    throw new Error('meta inbox URL must point to business.facebook.com/latest/inbox');
  }

  const businessId = digitsOnly(url.searchParams.get('business_id'));
  const assetId = digitsOnly(url.searchParams.get('asset_id'));
  return { businessId, assetId };
}

export function buildMetaInboxUrl({ businessId, assetId } = {}) {
  const normalizedBusinessId = digitsOnly(businessId);
  const normalizedAssetId = digitsOnly(assetId);
  if (!normalizedBusinessId || !normalizedAssetId) return DEFAULT_META_INBOX_URL;

  const url = new URL('/latest/inbox/all/', META_INBOX_ORIGIN);
  url.searchParams.set('business_id', normalizedBusinessId);
  url.searchParams.set('asset_id', normalizedAssetId);
  return url.toString();
}

export function normalizeMetaInboxTarget(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const context = source.context && typeof source.context === 'object' && !Array.isArray(source.context)
    ? source.context
    : {};

  const rawUrl = firstPresent(source, ['targetInboxUrl', 'metaInboxUrl', 'inboxUrl', 'meta_inbox_url']) ||
    firstPresent(context, ['targetInboxUrl', 'metaInboxUrl', 'inboxUrl', 'meta_inbox_url']);
  const parsed = rawUrl ? parseInboxUrl(rawUrl) : null;

  const businessId =
    digitsOnly(firstPresent(source, ['businessId', 'business_id', 'metaBusinessId', 'meta_business_id'])) ||
    digitsOnly(firstPresent(context, ['businessId', 'business_id', 'metaBusinessId', 'meta_business_id'])) ||
    parsed?.businessId ||
    '';
  const assetId =
    digitsOnly(firstPresent(source, ['assetId', 'asset_id', 'metaAssetId', 'meta_asset_id'])) ||
    digitsOnly(firstPresent(context, ['assetId', 'asset_id', 'metaAssetId', 'meta_asset_id'])) ||
    parsed?.assetId ||
    '';

  if (!businessId && !assetId && !rawUrl) return null;
  if (!businessId || !assetId) {
    throw new Error('meta inbox target requires both business_id and asset_id');
  }

  return {
    businessId,
    assetId,
    inboxUrl: buildMetaInboxUrl({ businessId, assetId }),
  };
}

export function metaInboxTargetMatchesUrl(target, value) {
  if (!target?.businessId || !target?.assetId || !value) return true;

  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }

  if (url.hostname !== 'business.facebook.com' || !url.pathname.startsWith('/latest/inbox')) {
    return false;
  }

  return url.searchParams.get('business_id') === target.businessId &&
    url.searchParams.get('asset_id') === target.assetId;
}

export { DEFAULT_META_INBOX_URL };
