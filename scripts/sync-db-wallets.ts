import 'dotenv/config';
import { connectDB } from '../src/db/connect.js';
import { User } from '../src/models/User.js';
import { getPrivyClient } from '../src/services/privy.js';
import { getPaymentSignerSettings, getPaymentSignerStatus } from '../src/services/privyPaymentSigner.js';

async function main() {
  await connectDB();
  const client = getPrivyClient();
  const settings = getPaymentSignerSettings();

  const users = await User.find();
  console.log(`Checking ${users.length} users in DB...`);

  for (const user of users) {
    console.log(`User: ${user.email} (${user.privyUserId})`);
    // Find active wallets with signer
    const active: any[] = [];
    for await (const w of client.wallets().list({ user_id: user.privyUserId, chain_type: 'ethereum' })) {
      active.push(w);
    }
    const authorized = active.find((w) =>
      (w.additional_signers ?? []).some(
        (s: any) => s.signer_id === settings.signerId && (s.override_policy_ids ?? []).includes(settings.policyId),
      ),
    );

    if (authorized) {
      console.log(`Found authorized wallet for ${user.email}: ${authorized.id} (${authorized.address})`);
      user.walletId = authorized.id;
      user.walletAddress = authorized.address;
      user.walletChainType = 'ethereum';
      user.walletProvisioningStatus = 'completed';
      user.paymentSignerAuthorization = {
        status: 'authorized',
        walletId: authorized.id,
        signerId: settings.signerId,
        policyId: settings.policyId,
        verifiedAt: new Date(),
      };
      await user.save();

      const verification = await getPaymentSignerStatus({
        privyUserId: user.privyUserId,
        walletId: authorized.id,
        walletAddress: authorized.address,
      });
      console.log(`Verification for ${user.email}:`, verification.authorized ? 'AUTHORIZED ✅' : 'NOT AUTHORIZED ❌');
    } else {
      console.log(`No authorized wallet found for ${user.email}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
