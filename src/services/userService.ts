import { User, IUser } from '../models/User.js';
import { getPrivyClient } from './privy.js';
import type { User as PrivyUser, LinkedAccount } from '@privy-io/node';

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

/**
 * Finds or provisions an Ethereum embedded wallet for a Privy user.
 * Ensures duplicate prevention, idempotency, and safe retry handling.
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
  // If local user already has a completed wallet, return it
  if (localUser.walletAddress && localUser.walletProvisioningStatus === 'completed') {
    return {
      walletId: localUser.walletId || '',
      walletAddress: localUser.walletAddress,
      chainType: localUser.walletChainType || 'ethereum',
      provisioningStatus: 'completed',
    };
  }

  const client = getPrivyClient();

  // 1. Inspect existing linked accounts on the Privy user for an Ethereum embedded wallet
  const existingWalletAccount = (privyUser.linked_accounts || []).find((acc: LinkedAccount) => {
    return (
      acc.type === 'wallet' &&
      'chain_type' in acc &&
      (acc as any).chain_type === 'ethereum' &&
      'connector_type' in acc &&
      (acc as any).connector_type === 'embedded'
    );
  }) as any;

  if (existingWalletAccount && existingWalletAccount.address) {
    const walletId = existingWalletAccount.id || existingWalletAccount.address;
    const walletAddress = existingWalletAccount.address;

    await User.findByIdAndUpdate(localUser._id, {
      $set: {
        walletId,
        walletAddress,
        walletChainType: 'ethereum',
        walletProvisioningStatus: 'completed',
      },
    });

    return {
      walletId,
      walletAddress,
      chainType: 'ethereum',
      provisioningStatus: 'completed',
    };
  }

  // 2. Provision a new Ethereum embedded wallet via Privy SDK
  try {
    const createdWallet = await client.wallets().create({
      chain_type: 'ethereum',
      owner: {
        user_id: privyUser.id,
      },
    });

    await User.findByIdAndUpdate(localUser._id, {
      $set: {
        walletId: createdWallet.id,
        walletAddress: createdWallet.address,
        walletChainType: 'ethereum',
        walletProvisioningStatus: 'completed',
      },
    });

    return {
      walletId: createdWallet.id,
      walletAddress: createdWallet.address,
      chainType: 'ethereum',
      provisioningStatus: 'completed',
    };
  } catch (error) {
    // If creation failed, mark as failed for safe retry
    await User.findByIdAndUpdate(localUser._id, {
      $set: {
        walletProvisioningStatus: 'failed',
      },
    });

    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to provision embedded Ethereum wallet: ${errorMsg}`);
  }
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
  let walletResult;
  try {
    walletResult = await ensureEthereumEmbeddedWallet(privyUser, localUser);
  } catch (walletError) {
    walletResult = {
      walletId: localUser.walletId,
      walletAddress: localUser.walletAddress,
      chainType: localUser.walletChainType || 'ethereum',
      provisioningStatus: 'failed',
    };
  }

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
