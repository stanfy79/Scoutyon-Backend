import type { AuthorizationContext } from '@privy-io/node';
import { encodeFunctionData, isAddress, isHash, parseAbi } from 'viem';
import { config } from '../config.js';
import { getPrivyClient } from './privy.js';
import type { IPaymentAttempt } from '../models/PaymentAttempt.js';

const transferAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);

interface PrivyWalletSnapshot {
  id: string;
  owner_id: string | null;
  address: string;
  chain_type: string;
  additional_signers?: Array<{
    signer_id: string;
    override_policy_ids?: string[];
  }>;
}

type WalletLookup = (walletId: string) => Promise<PrivyWalletSnapshot>;

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const failure = error as { status?: number; statusCode?: number };
  return failure.status ?? failure.statusCode;
}

export async function assertServerSignerConfigured(
  walletId: string,
  expectedAddress: string,
  privyUserId: string,
  walletLookup: WalletLookup = async (id) => await getPrivyClient().wallets().get(id),
): Promise<void> {
  if (
    !config.PRIVY_KEY_QUORUM_ID ||
    !config.PRIVY_TRANSFER_POLICY_ID ||
    !config.PRIVY_AUTHORIZATION_PRIVATE_KEY
  ) {
    throw Object.assign(new Error('The server signer is not configured'), {
      code: 'SERVER_SIGNER_NOT_CONFIGURED',
      statusCode: 503,
    });
  }

  let wallet: PrivyWalletSnapshot;
  try {
    wallet = await walletLookup(walletId);
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 404 || (error instanceof Error && error.name === 'NotFoundError')) {
      throw Object.assign(new Error('The configured Privy wallet does not exist in this Privy application'), {
        code: 'PRIVY_WALLET_NOT_FOUND',
        statusCode: 404,
      });
    }
    if (status === 401) {
      throw Object.assign(new Error('Privy rejected the configured application credentials'), {
        code: 'PRIVY_APP_CREDENTIALS_INVALID',
        statusCode: 503,
      });
    }
    if (status === 403) {
      throw Object.assign(new Error('The configured Privy application cannot access this wallet'), {
        code: 'PRIVY_APP_ACCESS_DENIED',
        statusCode: 503,
      });
    }
    throw Object.assign(new Error('Unable to verify the payment wallet with Privy'), {
      code: 'PRIVY_WALLET_LOOKUP_FAILED',
      statusCode: 502,
      cause: error,
    });
  }

  const authorized = (wallet.additional_signers ?? []).some(
    (signer) =>
      signer.signer_id === config.PRIVY_KEY_QUORUM_ID &&
      signer.override_policy_ids?.includes(config.PRIVY_TRANSFER_POLICY_ID!),
  );
  if (wallet.id !== walletId) {
    throw Object.assign(new Error('Privy returned a different wallet ID than the stored wallet ID'), {
      code: 'WALLET_ID_MISMATCH',
      statusCode: 403,
    });
  }
  if (wallet.owner_id !== privyUserId) {
    throw Object.assign(new Error('The stored Privy user does not own the configured payment wallet'), {
      code: 'WALLET_OWNER_MISMATCH',
      statusCode: 403,
    });
  }
  if (wallet.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw Object.assign(new Error('The Privy wallet address does not match the stored wallet address'), {
      code: 'WALLET_ADDRESS_MISMATCH',
      statusCode: 403,
    });
  }
  if (wallet.chain_type !== 'ethereum') {
    throw Object.assign(new Error('The configured Privy wallet is not an Ethereum wallet'), {
      code: 'WALLET_CHAIN_MISMATCH',
      statusCode: 403,
    });
  }
  if (!authorized) {
    throw Object.assign(new Error('The user has not authorized the Scoutyon payment signer'), {
      code: 'WALLET_NOT_DELEGATED',
      statusCode: 403,
    });
  }
}

export async function sendErc20Deposit(input: {
  attempt: Pick<
    IPaymentAttempt,
    'privyWalletId' | 'originCaip2' | 'originTokenAddress' | 'idempotencyKey' | 'depositAddress' | 'amountIn'
  >;
  walletAddress: string;
  privyUserId: string;
}): Promise<{ transactionHash: string; walletActionId: string | null }> {
  if (!config.PAYMENTS_LIVE_ENABLED || config.SIMULATE_PAYMENTS) {
    throw Object.assign(new Error('Live payments are disabled'), {
      code: 'PAYMENTS_DISABLED',
      statusCode: 503,
    });
  }
  if (!isAddress(input.walletAddress) || !isAddress(input.attempt.depositAddress)) {
    throw Object.assign(new Error('Invalid EVM wallet or deposit address'), {
      code: 'PAYMENT_ADDRESS_INVALID',
      statusCode: 400,
    });
  }
  await assertServerSignerConfigured(input.attempt.privyWalletId, input.walletAddress, input.privyUserId);
  const authorizationContext: AuthorizationContext = {
    authorization_private_keys: [config.PRIVY_AUTHORIZATION_PRIVATE_KEY!],
  };
  const calldata = encodeFunctionData({
    abi: transferAbi,
    functionName: 'transfer',
    args: [input.attempt.depositAddress, BigInt(input.attempt.amountIn)],
  });

  try {
    const result = await getPrivyClient().wallets().ethereum().sendTransaction(
      input.attempt.privyWalletId,
      {
        caip2: input.attempt.originCaip2 as `eip155:${number}`,
        params: {
          transaction: {
            to: input.attempt.originTokenAddress,
            data: calldata,
            value: '0x0',
          },
        },
        authorization_context: authorizationContext,
        idempotency_key: input.attempt.idempotencyKey,
        reference_id: input.attempt.idempotencyKey,
      },
    );
    if (!isHash(result.hash)) {
      throw Object.assign(new Error('Privy returned an invalid transaction hash'), {
        code: 'SUBMISSION_UNKNOWN',
        statusCode: 504,
      });
    }
    return {
      transactionHash: result.hash,
      walletActionId: result.transaction_id ?? result.reference_id ?? null,
    };
  } catch (error) {
    const responseStatus = (error as { status?: number; statusCode?: number }).status ??
      (error as { statusCode?: number }).statusCode;
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message))
    ) {
      throw Object.assign(new Error('Privy submission outcome is unknown; reconcile before retrying'), {
        code: 'SUBMISSION_UNKNOWN',
        statusCode: 504,
      });
    }
    if (responseStatus === undefined || responseStatus >= 500) {
      throw Object.assign(new Error('Privy submission outcome is unknown; reconcile before retrying'), {
        code: 'SUBMISSION_UNKNOWN',
        statusCode: 504,
      });
    }
    throw Object.assign(new Error('Privy could not submit the payment transaction'), {
      code: 'PRIVY_TRANSACTION_FAILED',
      statusCode: 502,
    });
  }
}
