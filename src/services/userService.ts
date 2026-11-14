import { createHash } from 'node:crypto';
import { User, IUser } from '../models/User.js';
import { getPrivyClient } from './privy.js';
import { config } from '../config.js';
import { getPaymentSignerSettings } from './privyPaymentSigner.js';
import type { User as PrivyUser, LinkedAccount } from '@privy-io/node';
import {
  assertPrivyUserIdentity,
  assertUniqueLinkedWallet,
  assertWalletBelongsToUser,
  type PrivyWalletRecord,
} from './privyWalletOwnership.js';

export interface SyncPrivyUserResult {
  user: IUser;
  created: boolean;
  wallet: {
    id: string | null;
    address: string | null;
    chainType: string | null;
    provisioningStatus: string;
  };
}

export async function getVerifiedStoredWallet(
  localUser: Pick<IUser, 'privyUserId' | 'walletId' | 'walletAddress' | 'walletProvisioningStatus'>,
  expectedPrivyUserId: string,
  walletLookup: (walletId: string) => Promise<PrivyWalletRecord>,
): Promise<PrivyWalletRecord | null> {
  assertPrivyUserIdentity(localUser.privyUserId, expectedPrivyUserId);
  const mappingExists =
    !!localUser.walletId || !!localUser.walletAddress || localUser.walletProvisioningStatus === 'completed';
  if (!mappingExists) return null;

  if (!localUser.walletId || !localUser.walletAddress) {
    throw Object.assign(new Error('The stored Privy wallet mapping is incomplete and requires recovery'), {
      code: 'PRIVY_WALLET_MAPPING_INCOMPLETE',
      statusCode: 409,
    });
  }

  let wallet: PrivyWalletRecord;
  try {
    wallet = await walletLookup(localUser.walletId);
  } catch (error) {
    const failure = error as { status?: number; statusCode?: number };
    if (failure.status === 404 || failure.statusCode === 404) {
      throw Object.assign(new Error('The stored Privy wallet no longer exists and requires recovery'), {
        code: 'PRIVY_WALLET_NOT_FOUND',
        statusCode: 409,
      });
    }
    throw error;
  }

  assertWalletBelongsToUser(wallet, localUser.walletId, expectedPrivyUserId, localUser.walletAddress);
  return wallet;
}

function getPaymentSignerSettingsSafe() {
  if (!config.PAYMENTS_LIVE_ENABLED || config.SIMULATE_PAYMENTS) return null;
  try {
    return getPaymentSignerSettings({ requirePolicyId: true });
  } catch {
    return null;
  }
}

function hasScoutyonSigner(wallet: unknown, signerId: string, policyId: string): boolean {
  if (typeof wallet !== 'object' || wallet === null) return false;
  const signers = (wallet as { additional_signers?: Array<{ signer_id: string; override_policy_ids?: string[] }> }).additional_signers;
  return Array.isArray(signers) && signers.some(
    (s) => s.signer_id === signerId && (s.override_policy_ids ?? []).includes(policyId),
  );
}

/**
 * Finds or provisions an Ethereum embedded wallet for a Privy user.
 * Automatically delegates the Scoutyon payment signer and policy server-side,
 * ensuring seamless and secure payment authorization without client-side key exposure.
 */
export async function ensureEthereumEmbeddedWallet(
  privyUser: PrivyUser,
  localUser: IUser,
): Promise<{
  walletId: string;
  walletAddress: string;
  chainType: string;
  provisioningStatus: 'completed' | 'failed';
}> {
  assertPrivyUserIdentity(localUser.privyUserId, privyUser.id);
  const client = getPrivyClient();
  const signerSettings = getPaymentSignerSettingsSafe();

  const walletLookup = async (walletId: string): Promise<PrivyWalletRecord> =>
    await client.wallets().get(walletId);

  // 1. Check verified stored wallet
  const storedWallet = await getVerifiedStoredWallet(localUser, privyUser.id, walletLookup);
  if (storedWallet) {
    const isAuthorized = !signerSettings || hasScoutyonSigner(storedWallet, signerSettings.signerId, signerSettings.policyId);
    if (isAuthorized) {
      if (signerSettings && localUser.paymentSignerAuthorization?.status !== 'authorized') {
        await User.findByIdAndUpdate(localUser._id, {
          $set: {
            'paymentSignerAuthorization.status': 'authorized',
            'paymentSignerAuthorization.walletId': storedWallet.id,
            'paymentSignerAuthorization.signerId': signerSettings.signerId,
            'paymentSignerAuthorization.policyId': signerSettings.policyId,
            'paymentSignerAuthorization.verifiedAt': new Date(),
          },
        });
      }
      return {
        walletId: storedWallet.id,
        walletAddress: storedWallet.address,
        chainType: localUser.walletChainType || 'ethereum',
        provisioningStatus: 'completed',
      };
    }
  }

  // 2. Search active wallets for user
  const activeWallets: Array<PrivyWalletRecord & { additional_signers?: Array<{ signer_id: string; override_policy_ids?: string[] }> }> = [];
  try {
    for await (const wallet of client.wallets().list({
      user_id: privyUser.id,
      chain_type: 'ethereum',
    })) {
      activeWallets.push(wallet as any);
    }
  } catch (err) {
    console.warn('[ensureEthereumEmbeddedWallet] Could not list active wallets:', err);
  }

  // If a wallet already has the Scoutyon signer, adopt it immediately
  if (signerSettings) {
    const authorizedWallet = activeWallets.find((w) =>
      hasScoutyonSigner(w, signerSettings.signerId, signerSettings.policyId),
    );
    if (authorizedWallet) {
      assertWalletBelongsToUser(authorizedWallet, authorizedWallet.id, privyUser.id);
      await User.findByIdAndUpdate(localUser._id, {
        $set: {
          walletId: authorizedWallet.id,
          walletAddress: authorizedWallet.address,
          walletChainType: 'ethereum',
          walletProvisioningStatus: 'completed',
          'paymentSignerAuthorization.status': 'authorized',
          'paymentSignerAuthorization.walletId': authorizedWallet.id,
          'paymentSignerAuthorization.signerId': signerSettings.signerId,
          'paymentSignerAuthorization.policyId': signerSettings.policyId,
          'paymentSignerAuthorization.verifiedAt': new Date(),
        },
      });
      return {
        walletId: authorizedWallet.id,
        walletAddress: authorizedWallet.address,
        chainType: 'ethereum',
        provisioningStatus: 'completed',
      };
    }
  } else if (activeWallets.length === 1) {
    const singleWallet = activeWallets[0];
    assertWalletBelongsToUser(singleWallet, singleWallet.id, privyUser.id);
    await User.findByIdAndUpdate(localUser._id, {
      $set: {
        walletId: singleWallet.id,
        walletAddress: singleWallet.address,
        walletChainType: 'ethereum',
        walletProvisioningStatus: 'completed',
      },
    });
    return {
      walletId: singleWallet.id,
      walletAddress: singleWallet.address,
      chainType: 'ethereum',
      provisioningStatus: 'completed',
    };
  }

  // 3. If signerSettings is active, archive any old un-authorized wallets
  // so the user only has the authorized wallet active.
  if (signerSettings && activeWallets.length > 0) {
    for (const oldW of activeWallets) {
      try {
        await (client.wallets() as any).archive(oldW.id, { body: {} });
      } catch (err) {
        console.warn(`[ensureEthereumEmbeddedWallet] Could not archive wallet ${oldW.id}:`, err);
      }
    }
  }

  // 4. Create new embedded Ethereum wallet with additional_signers pre-attached
  let createdWallet;
  try {
    createdWallet = await client.wallets().create({
      chain_type: 'ethereum',
      owner: {
        user_id: privyUser.id,
      },
      ...(signerSettings && {
        additional_signers: [
          {
            signer_id: signerSettings.signerId,
            override_policy_ids: [signerSettings.policyId],
          },
        ],
      }),
      idempotency_key: createHash('sha256')
        .update(`scoutyon-auth-wallet:${privyUser.id}:${signerSettings?.signerId ?? 'default'}`)
        .digest('hex'),
    });
  } catch (error) {
    await User.findByIdAndUpdate(localUser._id, {
      $set: {
        walletProvisioningStatus: 'failed',
      },
    });
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to provision embedded Ethereum wallet: ${errorMsg}`);
  }

  assertWalletBelongsToUser(createdWallet, createdWallet.id, privyUser.id);
  await User.findByIdAndUpdate(localUser._id, {
    $set: {
      walletId: createdWallet.id,
      walletAddress: createdWallet.address,
      walletChainType: 'ethereum',
      walletProvisioningStatus: 'completed',
      ...(signerSettings && {
        'paymentSignerAuthorization.status': 'authorized',
        'paymentSignerAuthorization.walletId': createdWallet.id,
        'paymentSignerAuthorization.signerId': signerSettings.signerId,
        'paymentSignerAuthorization.policyId': signerSettings.policyId,
        'paymentSignerAuthorization.verifiedAt': new Date(),
      }),
    },
  });

  return {
    walletId: createdWallet.id,
    walletAddress: createdWallet.address,
    chainType: 'ethereum',
    provisioningStatus: 'completed',
  };
}

function isEthereumEmbeddedWallet(account: LinkedAccount): account is LinkedAccount & {
  id: string | null;
  address: string;
  chain_type: 'ethereum';
  connector_type: 'embedded';
} {
  return (
    account.type === 'wallet' &&
    'chain_type' in account &&
    account.chain_type === 'ethereum' &&
    'connector_type' in account &&
    account.connector_type === 'embedded' &&
    'id' in account &&
    typeof account.address === 'string'
  );
}

/**
 * Extracts and verifies the primary email address from Privy user linked accounts.
 */
export function extractVerifiedEmail(privyUser: PrivyUser): {
  email: string;
  verifiedAt: Date;
} {
  const emailAccount = (privyUser.linked_accounts || []).find(
    (acc: LinkedAccount) => acc.type === 'email',
  ) as any;

  if (!emailAccount || !emailAccount.address) {
    throw new Error('User does not have a linked email account in Privy');
  }

  const rawVerifiedAt =
    emailAccount.verified_at ||
    emailAccount.latest_verified_at ||
    emailAccount.first_verified_at;

  const verifiedAt = rawVerifiedAt
    ? new Date(typeof rawVerifiedAt === 'number' ? rawVerifiedAt * 1000 : rawVerifiedAt)
    : new Date();

  return {
    email: emailAccount.address.trim().toLowerCase(),
    verifiedAt,
  };
}

/**
 * Synchronizes the verified Privy user with the MongoDB User collection.
 */
export async function syncPrivyUserWithDatabase(
  privyUser: PrivyUser,
): Promise<SyncPrivyUserResult> {
  const { email, verifiedAt } = extractVerifiedEmail(privyUser);

  // Look up existing local user by privyUserId
  let localUser = await User.findOne({ privyUserId: privyUser.id });
  let created = false;

  if (!localUser) {
    localUser = await User.create({
      privyUserId: privyUser.id,
      email,
      emailVerifiedAt: verifiedAt,
      accountStatus: 'active',
      walletProvisioningStatus: 'pending',
      lastLoginAt: new Date(),
    });
    created = true;
  } else {
    localUser.email = email;
    localUser.emailVerifiedAt = verifiedAt;
    localUser.lastLoginAt = new Date();
    await localUser.save();
  }

  // Ensure embedded wallet is provisioned
  const walletResult = await ensureEthereumEmbeddedWallet(privyUser, localUser);

  const reloadedUser = (await User.findById(localUser._id)) || localUser;

  return {
    user: reloadedUser,
    created,
    wallet: {
      id: walletResult.walletId,
      address: walletResult.walletAddress,
      chainType: walletResult.chainType,
      provisioningStatus: walletResult.provisioningStatus,
    },
  };
}
