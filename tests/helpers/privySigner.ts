import { generateP256KeyPair, type KeyQuorum, type Policy } from '@privy-io/node';
import { config } from '../../src/config.js';
import {
  createBasePaymentPolicyParams,
  getPaymentSignerSettings,
  type PrivySignerDependencies,
} from '../../src/services/privyPaymentSigner.js';

export const testTokenAddress = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

export async function configureTestSigner(
  tokenLimits: Record<string, string> = { [testTokenAddress]: '5000000' },
): Promise<{
  dependencies: PrivySignerDependencies;
  quorum: KeyQuorum;
  policy: Policy;
}> {
  const keyPair = await generateP256KeyPair();
  Object.assign(config, {
    PRIVY_APP_ID: 'test-privy-app',
    PRIVY_KEY_QUORUM_ID: 'test-key-quorum',
    PRIVY_TRANSFER_POLICY_ID: 'test-transfer-policy',
    PRIVY_AUTHORIZATION_PRIVATE_KEY: keyPair.privateKey,
    PRIVY_BASE_TOKEN_LIMITS: Object.fromEntries(
      Object.entries(tokenLimits).map(([address, amount]) => [address.toLowerCase(), amount]),
    ),
  });
  const settings = getPaymentSignerSettings();
  const quorum: KeyQuorum = {
    id: settings.signerId,
    authorization_threshold: 1,
    authorization_keys: [{ public_key: keyPair.publicKey, display_name: 'test' }],
    display_name: 'test',
    user_ids: null,
  };
  const policyParams = createBasePaymentPolicyParams(settings);
  const policy: Policy = {
    ...policyParams,
    id: settings.policyId,
    owner_id: settings.signerId,
    created_at: Date.now(),
    rules: policyParams.rules.map((rule, index) => ({ ...rule, id: `rule-${index}` })),
  };
  const dependencies: PrivySignerDependencies = {
    walletLookup: async () => {
      throw new Error('Test wallet lookup was not configured');
    },
    keyQuorumLookup: async () => quorum,
    policyLookup: async () => policy,
  };
  return { dependencies, quorum, policy };
}
