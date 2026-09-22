import assert from 'node:assert/strict';
import test from 'node:test';

import { isMetaSendLimitToast } from '../src/utils/metaSendLimit.js';

test('recognizes the Meta send limit toast in English and Indonesian', () => {
  assert.equal(isMetaSendLimitToast('Something went wrong. Please try again.'), true);
  assert.equal(isMetaSendLimitToast('  TERJADI KESALAHAN.   SILAKAN COBA LAGI.  '), true);
});

test('does not classify unrelated send errors as the Meta send limit toast', () => {
  assert.equal(isMetaSendLimitToast('Could not send this message.'), false);
  assert.equal(isMetaSendLimitToast('Session not authenticated.'), false);
});
