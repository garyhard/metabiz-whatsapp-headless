import test from 'node:test';
import assert from 'node:assert/strict';

import {
  automatedBehaviorIndicator,
  isExplicitTwoFactorUrl,
} from '../src/utils/authCheckpoint.js';

test('recognizes the Indonesian automated-behavior checkpoint', () => {
  const text = `
    Kami mencurigai perilaku otomatis di akun Anda
    To prevent your account from being temporarily restricted or permanently disabled,
    ensure that no other users or tools have access to your account.
    Tutup
  `;

  assert.ok(automatedBehaviorIndicator(text));
});

test('does not classify a generic Facebook checkpoint URL as two-factor', () => {
  const url = 'https://www.facebook.com/checkpoint/601051028565049/?next=https%3A%2F%2Fwww.facebook.com%2F';

  assert.equal(isExplicitTwoFactorUrl(url), false);
});

test('recognizes an explicit two-factor URL', () => {
  assert.equal(isExplicitTwoFactorUrl('https://www.facebook.com/twofactor/reauth/'), true);
});
