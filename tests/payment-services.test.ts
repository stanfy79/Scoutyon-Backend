import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createExecutableQuote,
  getSupportedTokens,
  submitDepositTransaction,
} from '../src/services/nearIntents.js';
import { canTransitionPayment } from '../src/services/paymentStateMachine.js';
import { config } from '../src/config.js';
import { getConfiguredSourceToken } from '../src/services/nearTokenRegistry.js';
import { assertServerSignerConfigured, sendErc20Deposit } from '../src/services/privyWalletSender.js';
import { assertSufficientBalance, getWalletBalances } from '../src/services/walletBalance.js';

const originalFetch = globalThis.fetch;
const originalPaymentConfig = {
  PAYMENT_SOURCE_ASSET_ID: config.PAYMENT_SOURCE_ASSET_ID,
  PAYMENT_SOURCE_BLOCKCHAIN: config.PAYMENT_SOURCE_BLOCKCHAIN,
  PAYMENT_SOURCE_CHAIN_ID: config.PAYMENT_SOURCE_CHAIN_ID,
  PAYMENT_SOURCE_TOKEN_ADDRESS: config.PAYMENT_SOURCE_TOKEN_ADDRESS,
  PAYMENTS_LIVE_ENABLED: config.PAYMENTS_LIVE_ENABLED,
  SIMULATE_PAYMENTS: config.SIMULATE_PAYMENTS,
};

const walletAddress = '0xa3eBeE5ef77258FB070716cB668f22f43A123F36';
const baseUsdc = {
  assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  decimals: 6,
  blockchain: 'base',
  symbol: 'USDC',
  contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(config, originalPaymentConfig);
});

test('rejects a Privy wallet ID that does not exist in the configured app', async () => {
  await assert.rejects(
    assertServerSignerConfigured('missing-wallet', walletAddress, 'user-1', async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    }),
    { code: 'PRIVY_WALLET_NOT_FOUND' },
  );
});

test('distinguishes rejected Privy application credentials from a missing wallet', async () => {
  await assert.rejects(
    assertServerSignerConfigured('wallet-1', walletAddress, 'user-1', async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    }),
    { code: 'PRIVY_APP_CREDENTIALS_INVALID' },
  );
});

test('rejects an existing wallet that has no delegated payment signer', async () => {
  await assert.rejects(
    assertServerSignerConfigured('wallet-1', walletAddress, 'user-1', async () => ({
      id: 'wallet-1',
      owner_id: 'user-1',
      address: walletAddress,
      chain_type: 'ethereum',
      additional_signers: [],
    })),
    { code: 'WALLET_NOT_DELEGATED' },
  );
});

test('accepts a wallet delegated to the configured key quorum and transfer policy', async () => {
  await assertServerSignerConfigured('wallet-1', walletAddress, 'user-1', async () => ({
    id: 'wallet-1',
    owner_id: 'user-1',
    address: walletAddress,
    chain_type: 'ethereum',
    additional_signers: [
      {
        signer_id: config.PRIVY_KEY_QUORUM_ID!,
        override_policy_ids: [config.PRIVY_TRANSFER_POLICY_ID!],
      },
    ],
  }));
});

test('rejects a wallet owned by a different Privy user', async () => {
  await assert.rejects(
    assertServerSignerConfigured('wallet-1', walletAddress, 'user-1', async () => ({
      id: 'wallet-1',
      owner_id: 'user-2',
      address: walletAddress,
      chain_type: 'ethereum',
      additional_signers: [],
    })),
    { code: 'WALLET_OWNER_MISMATCH' },
  );
});

test('refreshes a fresh but stale token catalogue before rejecting the configured source asset', async () => {
  let catalogueResponse: typeof baseUsdc[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify(catalogueResponse), { status: 200 });
  Object.assign(config, {
    PAYMENT_SOURCE_ASSET_ID: baseUsdc.assetId,
    PAYMENT_SOURCE_BLOCKCHAIN: 'base',
    PAYMENT_SOURCE_CHAIN_ID: 8453,
    PAYMENT_SOURCE_TOKEN_ADDRESS: baseUsdc.contractAddress,
  });

  await assert.rejects(getConfiguredSourceToken(), { code: 'PAYMENT_SOURCE_ASSET_UNSUPPORTED' });
  catalogueResponse = [baseUsdc];

  const token = await getConfiguredSourceToken();
  assert.equal(token.assetId, baseUsdc.assetId);
});

test('reports a configured source asset missing from the token catalogue', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify([baseUsdc]), { status: 200 });
  config.PAYMENT_SOURCE_ASSET_ID = 'unsupported-source-asset';
  await assert.rejects(getConfiguredSourceToken(), { code: 'PAYMENT_SOURCE_ASSET_UNSUPPORTED' });
});

test('resolves native Base USDC using its exact NEAR asset ID and metadata', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify([baseUsdc]), { status: 200 });
  Object.assign(config, {
    PAYMENT_SOURCE_ASSET_ID: baseUsdc.assetId,
    PAYMENT_SOURCE_BLOCKCHAIN: 'base',
    PAYMENT_SOURCE_CHAIN_ID: 8453,
    PAYMENT_SOURCE_TOKEN_ADDRESS: baseUsdc.contractAddress,
  });

  const token = await getConfiguredSourceToken();
  assert.equal(token.assetId, baseUsdc.assetId);
  assert.equal(token.blockchain, 'base');
  assert.equal(token.symbol, 'USDC');
  assert.equal(token.decimals, 6);
  assert.equal(token.contractAddress?.toLowerCase(), baseUsdc.contractAddress);
});

test('rejects an incorrect configured source chain ID', async () => {
  config.PAYMENT_SOURCE_CHAIN_ID = 1;
  await assert.rejects(getConfiguredSourceToken(), { code: 'PAYMENT_SOURCE_ASSET_MISMATCH' });
});

test('rejects an incorrect configured source token contract', async () => {
  config.PAYMENT_SOURCE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000001';
  await assert.rejects(getConfiguredSourceToken(), { code: 'PAYMENT_SOURCE_ASSET_MISMATCH' });
});

test('retrieves integer token and native balances and estimates a valid zero-value transfer fee', async () => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const payload = await request.json() as { id: number; method: string };
    const results: Record<string, string> = {
      eth_chainId: '0x2105',
      eth_call: `0x${'0'.repeat(62)}64`,
      eth_getBalance: '0xde0b6b3a7640000',
      eth_estimateGas: '0x953a',
      eth_gasPrice: '0x3b9aca00',
    };
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      result: results[payload.method],
    }), { status: 200 });
  };
  Object.assign(config, {
    PAYMENT_SOURCE_BLOCKCHAIN: 'base',
    PAYMENT_SOURCE_CHAIN_ID: 8453,
    PAYMENT_SOURCE_TOKEN_ADDRESS: baseUsdc.contractAddress,
  });

  const balances = await getWalletBalances(walletAddress, baseUsdc);
  assert.equal(balances.tokenBalance, 100n);
  assert.equal(balances.nativeBalance, 1_000_000_000_000_000_000n);
  assert.equal(balances.estimatedGas, 38_202n);
  assert.equal(balances.estimatedGasFee, 38_202_000_000_000n);
  assert.equal(balances.gasEstimationError, null);
});

test('reports balance RPC failure separately from insufficient funds', async () => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const payload = await request.json() as { id: number; method: string };
    if (payload.method === 'eth_call') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        error: { code: -32000, message: 'RPC unavailable' },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      result: payload.method === 'eth_chainId' ? '0x2105' : '0x0',
    }), { status: 200 });
  };
  Object.assign(config, {
    PAYMENT_SOURCE_BLOCKCHAIN: 'base',
    PAYMENT_SOURCE_CHAIN_ID: 8453,
    PAYMENT_SOURCE_TOKEN_ADDRESS: baseUsdc.contractAddress,
  });

  await assert.rejects(getWalletBalances(walletAddress, baseUsdc), {
    code: 'PAYMENT_BALANCE_RPC_FAILED',
  });
});

test('reports insufficient token balance separately from RPC failures', async () => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const payload = await request.json() as { id: number; method: string };
    const results: Record<string, string> = {
      eth_chainId: '0x2105',
      eth_call: `0x${'0'.repeat(64)}`,
      eth_getBalance: '0x0',
    };
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      result: results[payload.method],
    }), { status: 200 });
  };
  config.PAYMENT_SOURCE_CHAIN_ID = 8453;

  await assert.rejects(
    assertSufficientBalance(
      {
        originTokenAddress: baseUsdc.contractAddress,
        depositAddress: '0x0000000000000000000000000000000000000002',
        amountIn: '1',
        originChainId: 8453,
      },
      walletAddress,
      baseUsdc,
    ),
    { code: 'INSUFFICIENT_TOKEN_BALANCE' },
  );
});

test('prevents payment submission while live payments are disabled', async () => {
  config.PAYMENTS_LIVE_ENABLED = false;
  config.SIMULATE_PAYMENTS = true;
  await assert.rejects(
    sendErc20Deposit({
      attempt: {
        privyWalletId: 'wallet-1',
        originCaip2: 'eip155:8453',
        originTokenAddress: baseUsdc.contractAddress,
        idempotencyKey: 'test-idempotency-key',
        depositAddress: walletAddress,
        amountIn: '1',
      },
      walletAddress,
      privyUserId: 'user-1',
    }),
    { code: 'PAYMENTS_DISABLED' },
  );
});

test('parses supported token metadata without trusting symbol-only identifiers', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        {
          assetId: 'eth:usdc:token',
          decimals: 6,
          blockchain: 'Ethereum',
          symbol: 'USDC',
          price: 1.001,
          priceUpdatedAt: new Date().toISOString(),
          contractAddress: '0x0000000000000000000000000000000000000001',
        },
      ]),
      { status: 200 },
    );

  const tokens = await getSupportedTokens();
  assert.equal(tokens[0].assetId, 'eth:usdc:token');
  assert.equal(tokens[0].price, '1.001');
  assert.equal(tokens[0].contractAddress, '0x0000000000000000000000000000000000000001');
});

test('creates an exact-output executable quote and validates its spending range', async () => {
  let submitted: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        depositAddress: '0x0000000000000000000000000000000000000002',
        amountIn: '105',
        minAmountIn: '100',
        maxAmountIn: '110',
        amountOut: '100',
        minAmountOut: '99',
        deadline: new Date(Date.now() + 60_000).toISOString(),
        correlationId: 'test-correlation',
      }),
      { status: 200 },
    );
  };

  const quote = await createExecutableQuote({
    originAsset: 'source-asset',
    destinationAsset: 'destination-asset',
    destinationAmount: '100',
    recipient: '0x0000000000000000000000000000000000000003',
    refundTo: '0x0000000000000000000000000000000000000004',
  });

  assert.equal(submitted?.dry, false);
  assert.equal(submitted?.swapType, 'EXACT_OUTPUT');
  assert.equal(submitted?.depositType, 'ORIGIN_CHAIN');
  assert.equal(submitted?.recipientType, 'DESTINATION_CHAIN');
  assert.equal(submitted?.amount, '100');
  assert.equal(typeof submitted?.deadline, 'string');
  assert.equal(quote.amountIn, '105');
  assert.equal(quote.maxAmountIn, '110');
});

test('rejects executable quotes that do not deliver the requested exact output', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        depositAddress: '0x0000000000000000000000000000000000000002',
        amountIn: '105',
        minAmountIn: '100',
        maxAmountIn: '110',
        amountOut: '99',
        deadline: new Date(Date.now() + 60_000).toISOString(),
        correlationId: 'test-correlation',
      }),
      { status: 200 },
    );

  await assert.rejects(
    createExecutableQuote({
      originAsset: 'source-asset',
      destinationAsset: 'destination-asset',
      destinationAmount: '100',
      recipient: '0x0000000000000000000000000000000000000003',
      refundTo: '0x0000000000000000000000000000000000000004',
    }),
    { code: 'NEAR_INTENTS_INVALID_RESPONSE' },
  );
});

test('rejects expired executable quotes', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        depositAddress: '0x0000000000000000000000000000000000000002',
        amountIn: '105',
        minAmountIn: '100',
        maxAmountIn: '110',
        amountOut: '100',
        deadline: new Date(Date.now() - 1_000).toISOString(),
        correlationId: 'test-correlation',
      }),
      { status: 200 },
    );

  await assert.rejects(
    createExecutableQuote({
      originAsset: 'source-asset',
      destinationAsset: 'destination-asset',
      destinationAmount: '100',
      recipient: '0x0000000000000000000000000000000000000003',
      refundTo: '0x0000000000000000000000000000000000000004',
    }),
    { code: 'NEAR_INTENTS_INVALID_RESPONSE' },
  );
});

test('accepts a no-content deposit notification response', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  await submitDepositTransaction('deposit', '0xtransaction');
});

test('payment state machine rejects direct confirmation-to-success transitions and safely handles invalid states', () => {
  assert.equal(canTransitionPayment('AWAITING_USER_CONFIRMATION', 'SUBMITTING'), true);
  assert.equal(canTransitionPayment('AWAITING_USER_CONFIRMATION', 'SUCCESS'), false);
  assert.equal(canTransitionPayment('PREPARING', 'EXPIRED'), true);
  assert.equal(canTransitionPayment('AWAITING_USER_CONFIRMATION', 'FAILED'), true);
  assert.equal(canTransitionPayment('NOT_A_REAL_STATE' as never, 'SUCCESS'), false);
  assert.equal(canTransitionPayment('AWAITING_USER_CONFIRMATION', 'NOT_A_REAL_STATE' as never), false);
});

test('legacy quote approval cannot execute a payment immediately', async () => {
  const router = (await import('../src/routes/quotes.js')).default as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }>;
  };
  const approveRoute = router.stack.find((layer) => layer.route?.path === '/:id/approve')?.route;
  assert.ok(approveRoute);
  const handler = approveRoute.stack[0].handle;
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  handler({}, response);
  assert.equal(response.statusCode, 409);
  assert.equal((response.body as { error: string }).error, 'PAYMENT_PREPARATION_REQUIRED');
});
