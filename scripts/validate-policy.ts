/**
 * Runs the actual assertPaymentPolicyIsRestrictive validator against the
 * currently configured policy to confirm startup would pass.
 */
import 'dotenv/config';
import { getPrivyClient } from '../src/services/privy.js';
import {
  getPaymentSignerSettings,
  assertPaymentPolicyIsRestrictive,
  assertPaymentSignerKeyQuorum,
} from '../src/services/privyPaymentSigner.js';

async function main() {
  const settings = getPaymentSignerSettings();
  const client = getPrivyClient();

  console.log('=== Validating Policy ===');
  console.log('policyId:', settings.policyId);
  console.log('signerId:', settings.signerId);
  console.log('baseTokenLimits:', JSON.stringify(settings.baseTokenLimits));

  const policy = await client.policies().get(settings.policyId);
  console.log('\nFetched policy:');
  console.log(JSON.stringify(policy, null, 2));

  console.log('\n--- Running assertPaymentPolicyIsRestrictive ---');
  assertPaymentPolicyIsRestrictive(policy, settings);
  console.log('✅ Policy validator: PASS');

  console.log('\n=== Validating Key Quorum ===');
  try {
    const quorum = await client.keyQuorums().get(settings.signerId);
    console.log('Fetched quorum:', JSON.stringify(quorum, null, 2));
    assertPaymentSignerKeyQuorum(quorum, settings);
    console.log('✅ Key quorum validator: PASS');
  } catch (e: unknown) {
    const err = e as { message?: string; code?: string; status?: number };
    if (err.code === 'PRIVY_AUTHORIZATION_FAILED' || err.code === 'SIGNER_CONFIGURATION_MISSING') {
      console.error('❌ Key quorum validator FAIL:', err.message);
    } else {
      console.error('⚠️  Key quorum fetch error (may be network/timeout):', err.message, 'status:', err.status);
    }
  }
}

main().catch((e) => {
  const err = e as { message?: string; code?: string; body?: unknown; status?: number };
  console.error('❌ FAIL:', err.code ?? 'Error', '-', err.message, 'body:', JSON.stringify(err.body ?? {}));
  process.exit(1);
});
