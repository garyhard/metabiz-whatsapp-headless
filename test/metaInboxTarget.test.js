import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_META_INBOX_URL,
  buildMetaInboxUrl,
  metaInboxTargetMatchesUrl,
  normalizeMetaInboxTarget,
} from '../src/utils/metaInboxTarget.js';

test('normalizes Meta inbox target from explicit business and asset IDs', () => {
  assert.deepEqual(
    normalizeMetaInboxTarget({ business_id: '1093463046527174', asset_id: '2241082110008102' }),
    {
      businessId: '1093463046527174',
      assetId: '2241082110008102',
      inboxUrl: 'https://business.facebook.com/latest/inbox/all/?business_id=1093463046527174&asset_id=2241082110008102',
    }
  );
});

test('normalizes Meta inbox target from full inbox URL in context', () => {
  assert.deepEqual(
    normalizeMetaInboxTarget({
      context: {
        meta_inbox_url: 'https://business.facebook.com/latest/inbox/all/?business_id=2296399947785866&asset_id=1731392681343638&selected_item_id=ignored',
      },
    }),
    {
      businessId: '2296399947785866',
      assetId: '1731392681343638',
      inboxUrl: 'https://business.facebook.com/latest/inbox/all/?business_id=2296399947785866&asset_id=1731392681343638',
    }
  );
});

test('returns null when no Meta inbox target is supplied', () => {
  assert.equal(normalizeMetaInboxTarget({}), null);
});

test('uses default inbox URL when target IDs are missing', () => {
  assert.equal(buildMetaInboxUrl({}), DEFAULT_META_INBOX_URL);
});

test('checks whether an inbox URL points at the same business and asset', () => {
  const target = normalizeMetaInboxTarget({
    businessId: '1',
    assetId: '2',
  });

  assert.equal(
    metaInboxTargetMatchesUrl(target, 'https://business.facebook.com/latest/inbox/all/?business_id=1&asset_id=2&mailbox_id=3'),
    true
  );
  assert.equal(
    metaInboxTargetMatchesUrl(target, 'https://business.facebook.com/latest/inbox/all/?business_id=1&asset_id=9'),
    false
  );
});

test('rejects partial or non-Meta inbox targets', () => {
  assert.throws(
    () => normalizeMetaInboxTarget({ business_id: '1093463046527174' }),
    /requires both business_id and asset_id/
  );
  assert.throws(
    () => normalizeMetaInboxTarget({ meta_inbox_url: 'https://example.com/latest/inbox?business_id=1&asset_id=2' }),
    /business\.facebook\.com/
  );
});
