import {
  createPublicClient,
  decodeEventLog,
  http,
  isAddress,
  parseAbi,
  type Address,
} from 'viem';
import { config } from '../config.js';
import type { IPaymentAttempt } from '../models/PaymentAttempt.js';
import type { NearIntentToken } from './nearIntents.js';

const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function getClient() {
  if (!config.PAYMENT_SOURCE_RPC_URL || !config.PAYMENT_SOURCE_CHAIN_ID) {
    throw Object.assign(new Error('Payment network is not configured'), {
      code: 'PAYMENTS_DISABLED',
      statusCode: 503,
    });
  }
  return createPublicClient({ transport: http(config.PAYMENT_SOURCE_RPC_URL) });
}

export async function assertConfiguredChain(): Promise<void> {
  const actual = await getClient().getChainId();
  if (actual !== config.PAYMENT_SOURCE_CHAIN_ID) {
    throw Object.assign(new Error('Payment RPC chain ID does not match configured chain'), {
      code: 'PAYMENT_CHAIN_MISMATCH',
      statusCode: 503,
    });
  }
}

export async function getWalletBalances(
  walletAddress: string,
  sourceToken: NearIntentToken,
): Promise<{
  tokenBalance: bigint;
  nativeBalance: bigint;
  estimatedGas: bigint | null;
  estimatedGasFee: bigint | null;
  gasEstimationError: string | null;
  gasEstimationErrorMessage: string | null;
}> {
  if (!isAddress(walletAddress) || !config.PAYMENT_SOURCE_TOKEN_ADDRESS) {
    throw Object.assign(new Error('Payment wallet or source token address is invalid'), {
      code: 'PAYMENT_ADDRESS_INVALID',
      statusCode: 400,
    });
  }
  if (
    !sourceToken.contractAddress ||
    sourceToken.contractAddress.toLowerCase() !== config.PAYMENT_SOURCE_TOKEN_ADDRESS.toLowerCase() ||
    sourceToken.blockchain.toLowerCase() !== config.PAYMENT_SOURCE_BLOCKCHAIN?.toLowerCase()
  ) {
    throw Object.assign(new Error('Resolved source token metadata does not match the configured payment network'), {
      code: 'PAYMENT_SOURCE_ASSET_MISMATCH',
      statusCode: 503,
    });
  }

  const client = getClient();
  let actualChainId: number;
  let tokenBalance: bigint;
  let nativeBalance: bigint;
  try {
    [actualChainId, tokenBalance, nativeBalance] = await Promise.all([
      client.getChainId(),
      client.readContract({
        address: config.PAYMENT_SOURCE_TOKEN_ADDRESS as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [walletAddress as Address],
      }),
      client.getBalance({ address: walletAddress as Address }),
    ]);
  } catch (error) {
    throw Object.assign(new Error('Payment RPC failed while reading the source-chain balances'), {
      code: 'PAYMENT_BALANCE_RPC_FAILED',
      statusCode: 503,
      cause: error,
    });
  }
  if (actualChainId !== config.PAYMENT_SOURCE_CHAIN_ID) {
    throw Object.assign(new Error('Payment RPC chain ID does not match configured chain'), {
      code: 'PAYMENT_CHAIN_MISMATCH',
      statusCode: 503,
    });
  }

  let estimatedGas: bigint;
  let gasPrice: bigint;
  try {
    [estimatedGas, gasPrice] = await Promise.all([
      client.estimateContractGas({
        address: config.PAYMENT_SOURCE_TOKEN_ADDRESS as Address,
        abi: erc20Abi,
        functionName: 'transfer',
        // A zero-value call remains estimable when readiness is checking an empty wallet.
        args: [walletAddress as Address, 0n],
        account: walletAddress as Address,
      }),
      client.getGasPrice(),
    ]);
  } catch {
    return {
      tokenBalance,
      nativeBalance,
      estimatedGas: null,
      estimatedGasFee: null,
      gasEstimationError: 'PAYMENT_GAS_ESTIMATION_FAILED',
      gasEstimationErrorMessage: 'Unable to estimate an ERC-20 transfer fee on the configured payment network',
    };
  }

  return {
    tokenBalance,
    nativeBalance,
    estimatedGas,
    estimatedGasFee: estimatedGas * gasPrice,
    gasEstimationError: null,
    gasEstimationErrorMessage: null,
  };
}

export async function assertSufficientBalance(
  attempt: Pick<IPaymentAttempt, 'originTokenAddress' | 'depositAddress' | 'amountIn' | 'originChainId'>,
  walletAddress: string,
  sourceToken: NearIntentToken,
): Promise<{ estimatedGasFee: bigint }> {
  if (!isAddress(walletAddress) || !isAddress(attempt.originTokenAddress)) {
    throw Object.assign(new Error('Invalid payment wallet or source token address'), {
      code: 'PAYMENT_ADDRESS_INVALID',
      statusCode: 400,
    });
  }
  if (!isAddress(attempt.depositAddress)) {
    throw Object.assign(new Error('NEAR Intents returned an invalid EVM deposit address'), {
      code: 'NEAR_INTENTS_INVALID_RESPONSE',
      statusCode: 502,
    });
  }

  const client = getClient();
  const wallet = walletAddress as Address;
  const tokenAddress = attempt.originTokenAddress as Address;
  let chainId: number;
  let tokenBalance: bigint;
  let nativeBalance: bigint;
  try {
    [chainId, tokenBalance, nativeBalance] = await Promise.all([
      client.getChainId(),
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet],
      }),
      client.getBalance({ address: wallet }),
    ]);
  } catch (error) {
    throw Object.assign(new Error('Payment RPC failed while reading the source-chain balances'), {
      code: 'PAYMENT_BALANCE_RPC_FAILED',
      statusCode: 503,
      cause: error,
    });
  }
  if (chainId !== attempt.originChainId) {
    throw Object.assign(new Error('Payment RPC chain ID does not match the stored payment route'), {
      code: 'PAYMENT_CHAIN_MISMATCH',
      statusCode: 503,
    });
  }

  const amountIn = BigInt(attempt.amountIn);
  if (tokenBalance < amountIn) {
    throw Object.assign(new Error(`Insufficient ${sourceToken.symbol} balance for this payment`), {
      code: 'INSUFFICIENT_TOKEN_BALANCE',
      statusCode: 402,
    });
  }

  let estimatedGas: bigint;
  let gasPrice: bigint;
  try {
    [estimatedGas, gasPrice] = await Promise.all([
      client.estimateContractGas({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [attempt.depositAddress as Address, amountIn],
        account: wallet,
      }),
      client.getGasPrice(),
    ]);
  } catch (error) {
    throw Object.assign(new Error('Payment RPC could not estimate the source transaction gas fee'), {
      code: 'PAYMENT_GAS_ESTIMATION_FAILED',
      statusCode: 503,
      cause: error,
    });
  }
  const estimatedGasFee = estimatedGas * gasPrice;
  if (nativeBalance < estimatedGasFee) {
    throw Object.assign(new Error('Insufficient native token balance to pay the network fee'), {
      code: 'INSUFFICIENT_GAS_BALANCE',
      statusCode: 402,
    });
  }
  return { estimatedGasFee };
}

export async function verifyTransferReceipt(input: {
  transactionHash: `0x${string}`;
  walletAddress: string;
  tokenAddress: string;
  depositAddress: string;
  amount: string;
  chainId: number;
}): Promise<void> {
  const client = getClient();
  if ((await client.getChainId()) !== input.chainId) {
    throw Object.assign(new Error('Payment RPC chain ID does not match the submitted transaction'), {
      code: 'PAYMENT_CHAIN_MISMATCH',
      statusCode: 503,
    });
  }
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: input.transactionHash,
      confirmations: 1,
      timeout: 45_000,
    });
  } catch (error) {
    if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
      throw Object.assign(new Error('Source transaction is not confirmed yet'), {
        code: 'SOURCE_TX_PENDING',
        statusCode: 202,
      });
    }
    throw error;
  }
  if (receipt.status !== 'success') {
    throw Object.assign(new Error('Source-chain transaction reverted'), {
      code: 'SOURCE_TRANSACTION_REVERTED',
      statusCode: 402,
    });
  }

  const transferLog = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== input.tokenAddress.toLowerCase()) return false;
    try {
      const event = decodeTransferLog(log);
      return (
        event.from.toLowerCase() === input.walletAddress.toLowerCase() &&
        event.to.toLowerCase() === input.depositAddress.toLowerCase() &&
        event.value === BigInt(input.amount)
      );
    } catch {
      return false;
    }
  });
  if (!transferLog) {
    throw Object.assign(new Error('Source-chain receipt does not contain the expected ERC-20 transfer'), {
      code: 'SOURCE_TRANSACTION_INVALID',
      statusCode: 502,
    });
  }
}

function decodeTransferLog(log: {
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}) {
  if (log.topics.length < 3) throw new Error('Malformed Transfer event');
  const topics = [...log.topics] as [`0x${string}`, ...`0x${string}`[]];
  const result = decodeEventLog({ abi: erc20Abi, data: log.data, topics });
  if (result.eventName !== 'Transfer') throw new Error('Unexpected event');
  return result.args;
}
