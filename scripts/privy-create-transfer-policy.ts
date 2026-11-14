import { createHash } from 'node:crypto';
import { getPrivyClient } from '../src/services/privy.js';
import {
  assertPaymentPolicyIsRestrictive,
  assertPaymentSignerKeyQuorum,
  createBasePaymentPolicyParams,
  getPaymentSignerSettings,
} from '../src/services/privyPaymentSigner.js';

async function main(): Promise<void> {
  const settings = getPaymentSignerSettings({ requirePolicyId: false });
  const client = getPrivyClient();
  const quorum = await client.keyQuorums().get(settings.signerId);
  assertPaymentSignerKeyQuorum(quorum, settings);

  if (settings.policyId) {
    const policy = await client.policies().get(settings.policyId);
    assertPaymentPolicyIsRestrictive(policy, settings);
    console.log(`Configured payment policy verified: ${policy.id}`);
    return;
  }

  const policy = await client.policies().create({
    ...createBasePaymentPolicyParams(settings),
    idempotency_key: createHash('sha256')
      .update(`${settings.appId}:scoutyon-base-erc20-payment-policy-v1`)
      .digest('hex'),
  });
  assertPaymentPolicyIsRestrictive(policy, { ...settings, policyId: policy.id });
  console.log(`Created restrictive Base payment policy. Set PRIVY_TRANSFER_POLICY_ID=${policy.id}`);
}

main().catch((error: unknown) => {
  const failure = error as { code?: string; message?: string };
  console.error(
    `Privy payment policy setup failed${failure.code ? ` (${failure.code})` : ''}: ${failure.message ?? 'Unknown error'}`,
  );
  process.exitCode = 1;
});
