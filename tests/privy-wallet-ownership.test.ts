import assert from 'node:assert/strict';
import test from 'node:test';
import { User } from '../src/models/User.js';
import { assertPrivyAppIdMatches } from '../src/services/privy.js';
import {
  assertUniqueLinkedWallet,
  assertWalletBelongsToUser,
  type PrivyWalletRecord,
} from '../src/services/privyWalletOwnership.js';
import { getVerifiedStoredWallet } from '../src/services/userService.js';

const wallet: PrivyWalletRecord = {
  id: 'wallet-1',
  owner_id: 'did:privy:user-1',
  address: '0xa3eBeE5ef77258FB070716cB668f22f43A123F36',
  chain_type: 'ethereum',
};

const localUser = {
  privyUserId: 'did:privy:user-1',
  walletId: wallet.id,
  walletAddress: wallet.address,
  walletProvisioningStatus: 'completed' as const,
};

test('accepts a stored wallet only when the authenticated Privy user owns the matching wallet', async () => {
  const resolved = await getVerifiedStoredWallet(localUser, wallet.owner_id!, async (id) => {
    assert.equal(id, wallet.id);
    return wallet;
  });
  assert.deepEqual(resolved, wallet);
});

test('rejects a wallet owned by another Privy user without changing the stored mapping', async () => {
  await assert.rejects(
    getVerifiedStoredWallet(localUser, wallet.owner_id!, async () => ({
      ...wallet,
      owner_id: 'did:privy:another-user',
    })),
    { code: 'WALLET_OWNER_MISMATCH' },
  );
});

test('rejects a stale wallet ID/address mapping rather than silently replacing it', async () => {
  let lookupCount = 0;
  await assert.rejects(
    getVerifiedStoredWallet(localUser, wallet.owner_id!, async () => {
      lookupCount += 1;
      return { ...wallet, address: '0x0000000000000000000000000000000000000001' };
    }),
    { code: 'WALLET_ADDRESS_MISMATCH' },
  );
  assert.equal(lookupCount, 1);
});

test('rejects MongoDB wallet mappings whose Privy user differs from the verified identity', async () => {
  await assert.rejects(
    getVerifiedStoredWallet(
      { ...localUser, privyUserId: 'did:privy:another-user' },
      wallet.owner_id!,
      async () => wallet,
    ),
    { code: 'PRIVY_USER_MAPPING_MISMATCH' },
  );
});

test('reports a missing stored Privy wallet and does not treat it as a new wallet', async () => {
  await assert.rejects(
    getVerifiedStoredWallet(localUser, wallet.owner_id!, async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    }),
    { code: 'PRIVY_WALLET_NOT_FOUND' },
  );
});

test('rejects an incomplete stored wallet mapping instead of provisioning a replacement', async () => {
  await assert.rejects(
    getVerifiedStoredWallet({ ...localUser, walletId: null }, wallet.owner_id!, async () => wallet),
    { code: 'PRIVY_WALLET_MAPPING_INCOMPLETE' },
  );
});

test('rejects tokens issued for a different configured Privy application', () => {
  assert.throws(() => assertPrivyAppIdMatches('frontend-app', 'backend-app'), {
    code: 'PRIVY_APP_ID_MISMATCH',
  });
  assert.doesNotThrow(() => assertPrivyAppIdMatches('same-app', 'same-app'));
});

test('rejects ambiguous duplicate embedded wallet links', () => {
  assert.throws(() => assertUniqueLinkedWallet([wallet, wallet]), {
    code: 'PRIVY_WALLET_MAPPING_AMBIGUOUS',
  });
});

test('keeps Privy user IDs unique in MongoDB rather than merging duplicate accounts by email', () => {
  const identityIndex = User.schema.indexes().find(
    ([keys]) => keys.privyUserId === 1,
  );
  assert.ok(identityIndex);
  assert.equal(identityIndex[1].unique, true);
});

test('rejects a wallet resource ID that does not match the stored ID', () => {
  assert.throws(
    () => assertWalletBelongsToUser({ ...wallet, id: 'different-wallet' }, wallet.id, wallet.owner_id!),
    { code: 'WALLET_ID_MISMATCH' },
  );
});
