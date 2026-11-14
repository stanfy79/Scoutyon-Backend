export interface PrivyWalletRecord {
  id: string;
  owner_id: string | null;
  address: string;
  chain_type: string;
}

function ownershipError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, statusCode: 403 });
}

export function assertPrivyUserIdentity(expectedUserId: string, actualUserId: string): void {
  if (!expectedUserId || expectedUserId !== actualUserId) {
    throw ownershipError('The Privy user profile does not match the authenticated user', 'PRIVY_USER_MAPPING_MISMATCH');
  }
}

export function assertWalletBelongsToUser(
  wallet: PrivyWalletRecord,
  expectedWalletId: string,
  expectedUserId: string,
  expectedAddress?: string,
): void {
  if (wallet.id && expectedWalletId && wallet.id !== expectedWalletId) {
    throw ownershipError('Privy returned a different wallet ID than the stored wallet ID', 'WALLET_ID_MISMATCH');
  }
  if (wallet.owner_id) {
    if (wallet.owner_id !== expectedUserId) {
      if (wallet.owner_id.startsWith('did:privy:') || !expectedUserId.startsWith('did:privy:')) {
        throw ownershipError('The stored Privy user does not own the configured payment wallet', 'WALLET_OWNER_MISMATCH');
      }
    }
  }
  if (expectedAddress && wallet.address && wallet.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw ownershipError('The Privy wallet address does not match the stored wallet address', 'WALLET_ADDRESS_MISMATCH');
  }
  if (wallet.chain_type && wallet.chain_type !== 'ethereum') {
    throw ownershipError('The configured Privy wallet is not an Ethereum wallet', 'WALLET_CHAIN_MISMATCH');
  }
}

export function assertUniqueLinkedWallet(accounts: unknown[]): void {
  if (accounts.length > 1) {
    throw ownershipError(
      'Multiple embedded Ethereum wallets are linked to this Privy user; wallet selection requires recovery',
      'PRIVY_WALLET_MAPPING_AMBIGUOUS',
    );
  }
}
