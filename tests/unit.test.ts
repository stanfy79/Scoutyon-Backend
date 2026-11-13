import assert from 'node:assert';
import { extractVerifiedEmail } from '../src/services/userService.js';

console.log('--- Starting Unit & Service Logic Tests ---');

// 1. Test extractVerifiedEmail with valid verified email
const mockPrivyUser1: any = {
  id: 'did:privy:user123',
  created_at: 1730000000,
  has_accepted_terms: true,
  is_guest: false,
  mfa_methods: [],
  linked_accounts: [
    {
      type: 'email',
      address: ' Test.User@EXAMPLE.COM ',
      verified_at: 1730000100,
      first_verified_at: 1730000100,
      latest_verified_at: 1730000100,
    },
  ],
};

const emailRes = extractVerifiedEmail(mockPrivyUser1);
assert.strictEqual(emailRes.email, 'test.user@example.com', 'Email must be trimmed and lowercased');
assert.ok(emailRes.verifiedAt instanceof Date, 'verifiedAt must be a valid Date object');
console.log('✓ extractVerifiedEmail normalization and timestamp extraction passed');

// 2. Test extractVerifiedEmail failure without email
const mockPrivyUserNoEmail: any = {
  id: 'did:privy:user_no_email',
  created_at: 1730000000,
  has_accepted_terms: true,
  is_guest: false,
  mfa_methods: [],
  linked_accounts: [],
};

assert.throws(
  () => extractVerifiedEmail(mockPrivyUserNoEmail),
  /User does not have a linked email account/,
  'Must throw error if user has no linked email'
);
console.log('✓ extractVerifiedEmail missing email rejection passed');

console.log('--- All Unit Tests Passed! ---');
