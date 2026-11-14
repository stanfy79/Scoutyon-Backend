import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { config } from '../src/config.js';
import { assertServerSignerConfigured } from '../src/services/privyWalletSender.js';
import {
  assertAllowedBasePaymentTransaction,
  assertPaymentPolicyIsRestrictive,
  getPaymentSignerStatus,
  getPaymentSignerSettings,
  inspectWalletSigner,
  type PrivySignerDependencies,
} from '../src/services/privyPaymentSigner.js';
import { configureTestSigner, testTokenAddress } from './helpers/privySigner.js';

const walletAddress = '0xa3eBeE5ef77258FB070716cB668f22f43A123F36';
const originalSignerConfig = {
  PRIVY_APP_ID: config.PRIVY_APP_ID,
  PRIVY_KEY_QUORUM_ID: config.PRIVY_KEY_QUORUM_ID,
  PRIVY_TRANSFER_POLICY_ID: config.PRIVY_TRANSFER_POLICY_ID,
  PRIVY_AUTHORIZATION_PRIVATE_KEY: config.PRIVY_AUTHORIZATION_PRIVATE_KEY,
  PRIVY_BASE_TOKEN_LIMITS: config.PRIVY_BASE_TOKEN_LIMITS,
};
let dependencies: PrivySignerDependencies;
let policy: Awaited<ReturnType<typeof configureTestSigner>>['policy'];

beforeEach(async () => {
  ({ dependencies, policy } = await configureTestSigner());
});

afterEach(() => {
  Object.assign(config, originalSignerConfig);
});

function wallet(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wallet-1',
    owner_id: 'did:privy:user-1',
    address: walletAddress,
    chain_type: 'ethereum',
    additional_signers: [{
      signer_id: config.PRIVY_KEY_QUORUM_ID!,
      override_policy_ids: [config.PRIVY_TRANSFER_POLICY_ID!],
    }],
    ...overrides,
  };
}

test('accepts a user-authorized signer only when owner, key quorum and policy all match', async () => {
  const result = await assertServerSignerConfigured(
    'wallet-1',
    walletAddress,
    'did:privy:user-1',
    async () => wallet(),
    dependencies,
  );
  assert.equal(result.authorized, true);
  assert.equal(result.signerId, config.PRIVY_KEY_QUORUM_ID);
  assert.equal(result.policyId, config.PRIVY_TRANSFER_POLICY_ID);
});

test('reports the live wallet signer state and IDs without accepting client-supplied authorization', async () => {
  const authorized = await getPaymentSignerStatus({
    privyUserId: 'did:privy:user-1',
    walletId: 'wallet-1',
    walletAddress,
    dependencies: {
      ...dependencies,
      walletLookup: async () => wallet(),
    },
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.status, 'AUTHORIZED');

  const notYetAuthorized = await getPaymentSignerStatus({
    privyUserId: 'did:privy:user-1',
    walletId: 'wallet-1',
    walletAddress,
    dependencies: {
      ...dependencies,
      walletLookup: async () => wallet({ additional_signers: [] }),
    },
  });
  assert.equal(notYetAuthorized.authorized, false);
  assert.equal(notYetAuthorized.status, 'WALLET_NOT_DELEGATED');
});

test('reports an absent signer with an explicit user authorization instruction', () => {
  const result = inspectWalletSigner(
    wallet({ additional_signers: [] }),
    {
      signerId: config.PRIVY_KEY_QUORUM_ID!,
      policyId: config.PRIVY_TRANSFER_POLICY_ID!,
    },
  );
  assert.equal(result.code, 'WALLET_NOT_DELEGATED');
  assert.match(result.message, /Enable Scoutyon Payment Authorization/);
});

test('distinguishes a different registered signer from a missing signer', async () => {
  await assert.rejects(
    assertServerSignerConfigured(
      'wallet-1',
      walletAddress,
      'did:privy:user-1',
      async () => wallet({
        additional_signers: [{ signer_id: 'wrong-quorum', override_policy_ids: ['test-transfer-policy'] }],
      }),
      dependencies,
    ),
    { code: 'SIGNER_NOT_REGISTERED' },
  );
});

test('distinguishes a registered signer without the required policy', async () => {
  await assert.rejects(
    assertServerSignerConfigured(
      'wallet-1',
      walletAddress,
      'did:privy:user-1',
      async () => wallet({
        additional_signers: [{ signer_id: config.PRIVY_KEY_QUORUM_ID!, override_policy_ids: [] }],
      }),
      dependencies,
    ),
    { code: 'SIGNER_POLICY_REJECTED' },
  );
});

test('rejects a wallet owned by another authenticated Privy user', async () => {
  await assert.rejects(
    assertServerSignerConfigured(
      'wallet-1',
      walletAddress,
      'did:privy:user-1',
      async () => wallet({ owner_id: 'did:privy:user-2' }),
      dependencies,
    ),
    { code: 'WALLET_OWNER_MISMATCH' },
  );
});

test('fails closed when the authorization private key is missing', async () => {
  config.PRIVY_AUTHORIZATION_PRIVATE_KEY = undefined;
  await assert.rejects(
    assertServerSignerConfigured('wallet-1', walletAddress, 'did:privy:user-1', async () => wallet(), dependencies),
    { code: 'SIGNER_CONFIGURATION_MISSING' },
  );
});

test('fails when the configured private key does not match the registered key quorum', async () => {
  const mismatchedDependencies: PrivySignerDependencies = {
    ...dependencies,
    keyQuorumLookup: async (id) => {
      const quorum = await dependencies.keyQuorumLookup(id);
      return { ...quorum, authorization_keys: [{ public_key: 'different-key', display_name: null }] };
    },
  };
  await assert.rejects(
    assertServerSignerConfigured('wallet-1', walletAddress, 'did:privy:user-1', async () => wallet(), mismatchedDependencies),
    { code: 'PRIVY_AUTHORIZATION_FAILED' },
  );
});

test('requires a valid registered restrictive policy', async () => {
  const missingPolicy: PrivySignerDependencies = {
    ...dependencies,
    policyLookup: async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    },
  };
  await assert.rejects(
    assertServerSignerConfigured('wallet-1', walletAddress, 'did:privy:user-1', async () => wallet(), missingPolicy),
    { code: 'SIGNER_POLICY_REJECTED' },
  );

  assert.throws(
    () => assertPaymentPolicyIsRestrictive({ ...policy, rules: [] }, getPaymentSignerSettings()),
    { code: 'SIGNER_POLICY_REJECTED' },
  );
});

test('restricts signer authorization to Base, configured verified tokens and per-token atomic limits', () => {
  assert.doesNotThrow(() => assertAllowedBasePaymentTransaction(8453, testTokenAddress, '5000000'));
  assert.throws(() => assertAllowedBasePaymentTransaction(1, testTokenAddress, '1'), {
    code: 'SIGNER_POLICY_REJECTED',
  });
  assert.throws(
    () => assertAllowedBasePaymentTransaction(8453, '0x0000000000000000000000000000000000000001', '1'),
    { code: 'SIGNER_POLICY_REJECTED' },
  );
  assert.throws(() => assertAllowedBasePaymentTransaction(8453, testTokenAddress, '5000001'), {
    code: 'SIGNER_POLICY_REJECTED',
  });
});
