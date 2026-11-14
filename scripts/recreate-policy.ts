/**
 * Recreates the Scoutyon Privy payment policy with the exact conditions
 * the validator expects. Run this once; then update PRIVY_TRANSFER_POLICY_ID
 * in .env with the returned policy ID.
 *
 * Usage: npx tsx --env-file .env scripts/recreate-policy.ts
 */
import 'dotenv/config';
import { getPrivyClient } from '../src/services/privy.js';
import { getPaymentSignerSettings, createBasePaymentPolicyParams } from '../src/services/privyPaymentSigner.js';

const OLD_POLICY_ID = process.env.PRIVY_TRANSFER_POLICY_ID;
const POLICY_NAME = 'Scoutyon Base ERC-20 payment signer';

async function main() {
  const settings = getPaymentSignerSettings();
  const client = getPrivyClient();

  console.log('=== Scoutyon Policy Recreator ===');
  console.log('signerId (quorum):', settings.signerId);
  console.log('baseTokenLimits:', JSON.stringify(settings.baseTokenLimits));
  console.log('old policyId:', OLD_POLICY_ID);

  // Check whether a correctly-named policy already exists for this quorum
  console.log('\n--- Checking for existing policies ---');
  let existingPolicyId: string | null = null;
  try {
    const listResult = await client.policies().list();
    // The SDK may return { data: [...] } or similar — unwrap accordingly
    const items: Array<{ id: string; name: string; owner_id: string }> = Array.isArray(listResult)
      ? (listResult as unknown as Array<{ id: string; name: string; owner_id: string }>)
      : Array.isArray((listResult as unknown as { data?: unknown }).data)
        ? ((listResult as unknown as { data: Array<{ id: string; name: string; owner_id: string }> }).data)
        : [];
    const existing = items.filter((p) => p.name === POLICY_NAME && p.owner_id === settings.signerId);
    if (existing.length > 0) {
      existingPolicyId = existing[0].id;
      console.log('Found existing policy with correct name:', existingPolicyId);
    } else {
      console.log('No matching policy found. Will create a new one.');
    }
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number };
    console.warn('Could not list policies (skipping idempotency check):', err.message, 'status:', err.status);
  }

  if (existingPolicyId) {
    console.log('\nPolicy already exists with ID:', existingPolicyId);
    console.log('Update your .env:');
    console.log(`  PRIVY_TRANSFER_POLICY_ID=${existingPolicyId}`);
    return;
  }

  // Build the policy params
  const params = createBasePaymentPolicyParams(settings);
  console.log('\n--- Policy params to be created ---');
  console.log(JSON.stringify(params, null, 2));

  // Create the new policy
  console.log('\n--- Creating policy ---');
  const newPolicy = await client.policies().create(params);
  console.log('\n✅ Policy created successfully!');
  console.log('New policy ID:', (newPolicy as unknown as { id: string }).id);
  console.log(JSON.stringify(newPolicy, null, 2));

  console.log('\n=== ACTION REQUIRED ===');
  console.log('Update .env:');
  console.log(`  PRIVY_TRANSFER_POLICY_ID=${(newPolicy as unknown as { id: string }).id}`);

  // Optionally delete old policy if it's different and was set
  if (OLD_POLICY_ID && OLD_POLICY_ID !== (newPolicy as unknown as { id: string }).id) {
    console.log('\n--- Old policy ID was:', OLD_POLICY_ID, '---');
    console.log('You may delete it from the Privy Dashboard if no longer needed.');
  }
}

main().catch((e) => {
  const err = e as { message?: string; body?: unknown; status?: number };
  console.error('Fatal error:', err.message, 'status:', err.status, 'body:', JSON.stringify(err.body ?? {}));
  process.exit(1);
});
