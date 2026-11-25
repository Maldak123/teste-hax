import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminAuthenticator } from '../src/server/admin-auth.js';

test('admin password requires an authenticated identity and locks repeated failures', () => {
  let now = 0;
  const auth = new AdminAuthenticator('long-test-password-123', () => now);
  assert.equal(auth.verify('guest', 'long-test-password-123', false).ok, false);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(auth.verify('player', 'wrong-password-123', true).ok, false);
  assert.equal(auth.verify('player', 'long-test-password-123', true).reason, 'locked');
  now = 15 * 60_000 + 1;
  assert.equal(auth.verify('player', 'long-test-password-123', true).ok, true);
});
