import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
} from 'viem';
import { config } from '../src/config.js';
import { Session } from '../src/models/Session.js';
import { SwapQuote } from '../src/models/SwapQuote.js';
import { SwapTransfer } from '../src/models/SwapTransfer.js';
import { User } from '../src/models/User.js';
import { getExecutionStatus, createExactInputExecutableQuote } from '../src/services/nearIntents.js';
import {
  decodeTransferAction,
  prepareSwapTransfer,
  requestSwapWalletAuthorization,
  submitSwapSourceTransaction,
} from '../src/services/swapTransferService.js';
import { configureTestSigner } from './helpers/privySigner.js';

const walletAddress = '0xa3eBeE5ef77258FB070716cB668f22f43A123F36';
const tokenAddress = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const depositAddress = '0x0000000000000000000000000000000000000002';
const destinationHash = `0x${'2'.repeat(64)}`;
const sourceHash = `0x${'1'.repeat(64)}` as `0x${string}`;
const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const sessionId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const previewId = 'cccccccccccccccccccccccc';
const transferId = 'dddddddddddddddddddddddd';
const transferAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
const erc20Abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const baseUsdc = {
  assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  decimals: 6,
  blockchain: 'base',
  symbol: 'USDC',
  contractAddress: tokenAddress,
};
const ethUsdc = {
  assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  decimals: 6,
  blockchain: 'eth',
  symbol: 'USDC',
  contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
};

const originalFetch = globalThis.fetch;
const originalConfig = { ...config };
const restores: Array<() => void> = [];

function install(target: object, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

function query<T>(value: T) {
  const result = {
    select() { return result; },
    lean() { return result; },
    then(resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return result;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(config, originalConfig);
  for (const restore of restores.splice(0).reverse()) restore();
});

test('creates an EXACT_INPUT executable quote from the reviewed atomic amount', async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/v0\/quote$/);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      correlationId: 'executable-correlation',
      quote: {
        depositAddress,
        amountIn: '1000000',
        amountOut: '699798',
        minAmountOut: '692800',
        amountOutFormatted: '0.699798',
        deadline: new Date(Date.now() + 120_000).toISOString(),
      },
    }), { status: 200 });
  };

  const quote = await createExactInputExecutableQuote({
    originAsset: baseUsdc.assetId,
    destinationAsset: ethUsdc.assetId,
    amountIn: '1000000',
    recipient: walletAddress,
    refundTo: walletAddress,
    slippageTolerance: 100,
  });
  assert.equal(requestBody?.dry, false);
  assert.equal(requestBody?.swapType, 'EXACT_INPUT');
  assert.equal(requestBody?.depositType, 'ORIGIN_CHAIN');
  assert.equal(requestBody?.amount, '1000000');
  assert.equal(quote.amountIn, '1000000');
  assert.equal(quote.minAmountOut, '692800');
});

test('rejects an executable quote that changes the reviewed input amount', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    correlationId: 'changed-amount',
    quote: {
      depositAddress,
      amountIn: '999999',
      amountOut: '699798',
      minAmountOut: '692800',
      deadline: new Date(Date.now() + 120_000).toISOString(),
    },
  }), { status: 200 });
  await assert.rejects(
    createExactInputExecutableQuote({
      originAsset: baseUsdc.assetId,
      destinationAsset: ethUsdc.assetId,
      amountIn: '1000000',
      recipient: walletAddress,
      refundTo: walletAddress,
    }),
    { code: 'NEAR_INTENTS_INVALID_RESPONSE' },
  );
});

test('decodes only the exact ERC-20 transfer target and amount for wallet authorization', () => {
  const calldata = encodeFunctionData({
    abi: transferAbi,
    functionName: 'transfer',
    args: [depositAddress, 1_000_000n],
  });
  assert.equal(decodeTransferAction({
    tokenAddress,
    calldata,
    recipient: depositAddress,
    amount: '1000000',
  }), true);
  assert.equal(decodeTransferAction({
    tokenAddress,
    calldata,
    recipient: walletAddress,
    amount: '1000000',
  }), false);
  assert.equal(decodeTransferAction({
    tokenAddress,
    calldata,
    recipient: depositAddress,
    amount: '1000001',
  }), false);
});

test('runs mocked preview → executable quote → wallet action → verified deposit → SUCCESS lifecycle', async () => {
  const { dependencies: testSignerDependencies } = await configureTestSigner();
  const signerDependencies = {
    ...testSignerDependencies,
    walletLookup: async () => ({
      id: 'wallet-1',
      owner_id: 'privy-user-1',
      address: walletAddress,
      chain_type: 'ethereum',
      additional_signers: [{
        signer_id: config.PRIVY_KEY_QUORUM_ID!,
        override_policy_ids: [config.PRIVY_TRANSFER_POLICY_ID!],
      }],
    }),
  };
  Object.assign(config, {
    PAYMENT_SOURCE_ASSET_ID: baseUsdc.assetId,
    PAYMENT_SOURCE_BLOCKCHAIN: 'base',
    PAYMENT_SOURCE_CHAIN_ID: 8453,
    PAYMENT_SOURCE_RPC_URL: 'https://rpc.test',
    PAYMENT_SOURCE_TOKEN_ADDRESS: tokenAddress,
    PAYMENTS_LIVE_ENABLED: true,
    SIMULATE_PAYMENTS: false,
  });

  const preview = {
    _id: { toString: () => previewId },
    userId,
    sessionId,
    correlationId: 'preview-correlation',
    sourceAssetId: baseUsdc.assetId,
    sourceSymbol: 'USDC',
    sourceBlockchain: 'base',
    sourceDecimals: 6,
    destinationAssetId: ethUsdc.assetId,
    destinationSymbol: 'USDC',
    destinationBlockchain: 'eth',
    destinationDecimals: 6,
    amountIn: '1000000',
    requestedAmount: '1',
    amountInFormatted: '1',
    amountOut: '699798',
    amountOutFormatted: '0.699798',
    minAmountOut: '692800',
    recipient: walletAddress,
    refundTo: walletAddress,
    expiresAt: new Date(Date.now() + 120_000),
    timeEstimateSeconds: 42,
    slippageTolerance: 100,
    providerResponse: {},
    status: 'preview',
    createdAt: new Date(),
    save: async () => preview,
  };
  const session = { _id: sessionId, userId };
  const user = {
    _id: userId,
    walletId: 'wallet-1',
    walletAddress,
    privyUserId: 'privy-user-1',
    walletProvisioningStatus: 'completed',
  };
  const memory = new Map<string, Record<string, any>>();
  const savedSessionUpdates: Record<string, unknown>[] = [];
  let executableQuoteRequests = 0;
  let statusRequests = 0;

  install(SwapQuote, 'findOne', () => Promise.resolve(preview));
  install(SwapQuote, 'updateOne', async (_filter: unknown, update: Record<string, any>) => {
    Object.assign(preview, update.$set ?? {});
    return { modifiedCount: 1 };
  });
  install(Session, 'findOne', () => query(session));
  install(Session, 'updateOne', async (_filter: unknown, update: Record<string, any>) => {
    savedSessionUpdates.push(update.$set ?? {});
    return { modifiedCount: 1 };
  });
  install(User, 'findById', () => query(user));
  install(User, 'updateOne', async () => ({ modifiedCount: 1 }));
  install(SwapTransfer, 'findOne', (filter: Record<string, any>) => {
    if (filter.sourceTransactionHash) {
      const owner = [...memory.values()].find((candidate) =>
        candidate.sourceTransactionHash?.toLowerCase() === filter.sourceTransactionHash.toLowerCase(),
      ) ?? null;
      return query(owner);
    }
    const item = [...memory.values()].find((candidate) =>
      (filter.previewId ? candidate.previewId.toString() === String(filter.previewId) : true) &&
      (filter._id ? candidate._id.toString() === String(filter._id) : true),
    );
    return Promise.resolve(item ?? null);
  });
  install(SwapTransfer, 'findById', (id: string) => Promise.resolve(memory.get(String(id)) ?? null));
  install(SwapTransfer, 'create', async (data: Record<string, any>) => {
    const record = {
      ...data,
      _id: { toString: () => transferId },
      previewId: { toString: () => previewId },
      sessionId: { toString: () => sessionId },
      createdAt: new Date(),
      updatedAt: new Date(),
      sourceTransactionHash: null,
      authorizationIssuedAt: null,
      save: async () => record,
    };
    memory.set(transferId, record);
    return record;
  });
  install(SwapTransfer, 'findOneAndUpdate', async (filter: Record<string, any>, update: Record<string, any>) => {
    const record = memory.get(String(filter._id));
    if (!record) return null;
    if (typeof filter.status === 'string' && record.status !== filter.status) return null;
    if (filter.status?.$in && !filter.status.$in.includes(record.status)) return null;
    if (filter.sourceTransactionHash === null && record.sourceTransactionHash !== null) return null;
    Object.assign(record, update.$set ?? {});
    record.updatedAt = new Date();
    return record;
  });
  install(SwapTransfer, 'updateOne', async (filter: Record<string, any>, update: Record<string, any>) => {
    const record = memory.get(String(filter._id));
    if (record) Object.assign(record, update.$set ?? {});
    return { modifiedCount: record ? 1 : 0 };
  });

  const erc20TransferData = encodeFunctionData({
    abi: transferAbi,
    functionName: 'transfer',
    args: [depositAddress, 1_000_000n],
  });
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { from: walletAddress, to: depositAddress },
  }) as `0x${string}`[];
  const eventData = encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v0/tokens') {
      return new Response(JSON.stringify([baseUsdc, ethUsdc]), { status: 200 });
    }
    if (url.pathname === '/v0/quote') {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      executableQuoteRequests++;
      assert.equal(request.dry, false);
      assert.equal(request.amount, '1000000');
      return new Response(JSON.stringify({
        correlationId: 'executable-correlation',
        quote: {
          depositAddress,
          amountIn: '1000000',
          amountOut: '699798',
          minAmountOut: '692800',
          deadline: new Date(Date.now() + 120_000).toISOString(),
        },
      }), { status: 200 });
    }
    if (url.pathname === '/v0/deposit/submit') return new Response(null, { status: 204 });
    if (url.pathname === '/v0/status') {
      statusRequests++;
      assert.equal(url.searchParams.get('depositAddress'), depositAddress);
      return new Response(JSON.stringify({
        status: 'SUCCESS',
        updatedAt: new Date().toISOString(),
        swapDetails: {
          amountIn: '1000000',
          amountOut: '699798',
          destinationChainTxHashes: [{ hash: destinationHash, explorerUrl: 'https://explorer.test/tx' }],
        },
      }), { status: 200 });
    }
    const rpc = JSON.parse(String(init?.body)) as { id: number; method: string };
    const results: Record<string, unknown> = {
      eth_chainId: '0x2105',
      eth_call: `0x${(10_000_000n).toString(16).padStart(64, '0')}`,
      eth_getBalance: '0xde0b6b3a7640000',
      eth_estimateGas: '0x186a0',
      eth_gasPrice: '0x3b9aca00',
      eth_blockNumber: '0x10',
      eth_getTransactionByHash: {
        hash: sourceHash,
        nonce: '0x0',
        blockHash: `0x${'3'.repeat(64)}`,
        blockNumber: '0x10',
        transactionIndex: '0x0',
        from: walletAddress,
        to: tokenAddress,
        value: '0x0',
        gas: '0x186a0',
        gasPrice: '0x3b9aca00',
        input: erc20TransferData,
        v: '0x1',
        r: `0x${'4'.repeat(64)}`,
        s: `0x${'5'.repeat(64)}`,
        type: '0x0',
        chainId: '0x2105',
      },
      eth_getTransactionReceipt: {
        transactionHash: sourceHash,
        transactionIndex: '0x0',
        blockHash: `0x${'3'.repeat(64)}`,
        blockNumber: '0x10',
        from: walletAddress,
        to: tokenAddress,
        cumulativeGasUsed: '0x186a0',
        gasUsed: '0x186a0',
        contractAddress: null,
        logs: [{
          address: tokenAddress,
          topics,
          data: eventData,
          logIndex: '0x0',
          transactionHash: sourceHash,
          transactionIndex: '0x0',
          blockHash: `0x${'3'.repeat(64)}`,
          blockNumber: '0x10',
          removed: false,
        }],
        logsBloom: `0x${'0'.repeat(512)}`,
        status: '0x1',
        effectiveGasPrice: '0x3b9aca00',
        type: '0x0',
      },
    };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: results[rpc.method] }), { status: 200 });
  };

  const prepared = await prepareSwapTransfer({ userId, sessionId, previewId, signerDependencies });
  assert.equal(prepared.status, 'pending_authorization');
  const preparedTransfer = prepared.transfer as Record<string, any>;
  assert.equal(preparedTransfer.depositAddress, depositAddress);
  assert.equal(preparedTransfer.source.amountAtomic, '1000000');
  assert.equal(preparedTransfer.destination.minimumAmountAtomic, '692800');
  const repeatedPreparation = await prepareSwapTransfer({ userId, sessionId, previewId });
  assert.equal(repeatedPreparation.status, 'pending_authorization');
  assert.equal(executableQuoteRequests, 1);

  const authorized = await requestSwapWalletAuthorization({
    userId,
    sessionId,
    transferId,
    confirm: true,
    walletLookup: async () => ({
      id: 'wallet-1',
      owner_id: 'privy-user-1',
      address: walletAddress,
      chain_type: 'ethereum',
      additional_signers: [{
        signer_id: config.PRIVY_KEY_QUORUM_ID!,
        override_policy_ids: [config.PRIVY_TRANSFER_POLICY_ID!],
      }],
    }),
    signerDependencies,
  });
  assert.equal(authorized.status, 'wallet_authorization_required');
  const action = authorized.walletAuthorization as {
    transaction: { to: string; data: `0x${string}`; value: string };
    reviewedTransfer: { recipient: string; amountAtomic: string };
  };
  assert.equal(action.transaction.to, tokenAddress);
  assert.equal(action.transaction.value, '0x0');
  assert.equal(action.reviewedTransfer.recipient, depositAddress);
  assert.equal(action.reviewedTransfer.amountAtomic, '1000000');
  assert.equal(decodeTransferAction({
    tokenAddress: action.transaction.to,
    calldata: action.transaction.data,
    recipient: depositAddress,
    amount: '1000000',
  }), true);

  const settled = await submitSwapSourceTransaction({
    userId,
    sessionId,
    transferId,
    transactionHash: sourceHash,
  });
  assert.equal(settled.status, 'success');
  const settledTransfer = settled.transfer as Record<string, any>;
  assert.equal(settledTransfer.sourceTransactionHash, sourceHash);
  assert.equal(settledTransfer.destinationTransactionHash, destinationHash);
  assert.equal(settledTransfer.destinationExplorerUrl, 'https://explorer.test/tx');
  assert.equal(settledTransfer.destination.receivedAmountAtomic, '699798');
  assert.ok(savedSessionUpdates.some((update) => update['transactionContext.transactionStatus'] === 'deposit_submitted'));
  const duplicateSubmit = await submitSwapSourceTransaction({
    userId,
    sessionId,
    transferId,
    transactionHash: sourceHash,
  });
  assert.equal(duplicateSubmit.status, 'success');
  assert.equal(statusRequests, 1);
});

test('parses nested provider settlement details and memo query parameter', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('depositMemo'), '12345');
    return new Response(JSON.stringify({
      status: 'PROCESSING',
      swapDetails: {
        amountIn: '1000000',
        amountOut: '699798',
        destinationChainTxHashes: [{ hash: destinationHash, explorerUrl: 'https://explorer.test/tx' }],
      },
    }), { status: 200 });
  };
  const status = await getExecutionStatus(depositAddress, '12345');
  assert.equal(status.status, 'PROCESSING');
  assert.equal(status.destinationTransactionHash, destinationHash);
  assert.equal(status.destinationExplorerUrl, 'https://explorer.test/tx');
  assert.equal(status.raw.amountOut, '699798');
});
