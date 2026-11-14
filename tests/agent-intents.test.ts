import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChatIntent } from '../src/agent/intents.js';
import { buildGeminiContextPrompt, buildSessionSummaryFromMessages } from '../src/services/sessionMemory.js';
import { NearIntentsError, previewQuote } from '../src/services/nearIntents.js';
import {
  parseHumanAmountToAtomic,
  requestLiveSwapQuote,
  resolveSwapToken,
  SwapQuoteInputError,
} from '../src/services/swapQuoteService.js';

const walletAddress = '0xa3eBeE5ef77258FB070716cB668f22f43A123F36';
const swapTokens = [
  {
    assetId: 'nep141:base-usdc.omft.near',
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
  },
  {
    assetId: 'nep141:eth-usdc.omft.near',
    decimals: 6,
    blockchain: 'eth',
    symbol: 'USDC',
  },
  {
    assetId: 'nep141:wrap.near',
    decimals: 24,
    blockchain: 'near',
    symbol: 'wNEAR',
  },
];

test('classifies transfer quote requests', () => {
  const result = classifyChatIntent('How much NEAR can I get for 100 USDC?');
  assert.equal(result.intent, 'transfer_quote_request');
  assert.equal(result.status, 'quote_ready');
});

test('classifies complete swap requests without requiring a redundant recipient address', () => {
  const result = classifyChatIntent('Swap 100 USDC on Base to NEAR.');
  assert.equal(result.intent, 'transfer_execute_request');
  assert.equal(result.status, 'quote_ready');
  assert.equal(result.missingFields, undefined);
});

test('classifies prepare and confirmation follow-ups', () => {
  assert.equal(classifyChatIntent('Prepare that swap.').intent, 'transfer_prepare_request');
  assert.equal(classifyChatIntent('Proceed.').intent, 'transfer_prepare_request');
  assert.equal(classifyChatIntent('Confirm.').intent, 'transfer_confirm_request');
  assert.equal(classifyChatIntent('Confirm this transaction.').intent, 'transfer_confirm_request');
  assert.equal(classifyChatIntent('Check my last transfer.').intent, 'transfer_status_request');
});

test('remembers prior amount changes in the session summary', () => {
  const summary = buildSessionSummaryFromMessages([
    { role: 'user', content: 'Swap 20 USDC to NEAR.' },
    { role: 'assistant', content: 'I can help with that.' },
    { role: 'user', content: 'Make it 50 instead.' },
  ], {
    activeIntent: 'transfer_execute_request',
    knownParameters: { sourceAsset: 'USDC', destinationAsset: 'NEAR', amount: '20' },
    pendingClarifications: [],
    pendingTransactionId: null,
    sessionSummary: 'The user originally asked for 20 USDC.',
  });

  assert.equal(summary.knownParameters.amount, '50');
  assert.match(summary.sessionSummary, /50/);
});

test('includes prior session context when building the Gemini prompt', () => {
  const prompt = buildGeminiContextPrompt({
    messages: [
      { role: 'user', content: 'Swap 20 USDC to NEAR from Base.', timestamp: new Date() },
      { role: 'assistant', content: 'Which network should receive the funds?', timestamp: new Date() },
      { role: 'user', content: 'Base.', timestamp: new Date() },
    ],
    sessionSummary: {
      sessionSummary: 'User wants to swap USDC on Base to NEAR and has asked for a quote.',
      activeIntent: 'transfer_execute_request',
      knownParameters: { sourceAsset: 'USDC', destinationAsset: 'NEAR', sourceNetwork: 'Base' },
      pendingClarifications: [],
      pendingTransactionId: null,
    },
    transactionContext: {
      sourceAsset: 'USDC',
      sourceNetwork: 'Base',
      destinationAsset: 'NEAR',
      destinationNetwork: 'NEAR',
    },
  }, 'Proceed with the exchange.');

  assert.match(prompt, /USDC/);
  assert.match(prompt, /Base/);
  assert.match(prompt, /Proceed with the exchange/);
});

test('converts human input to atomic units without floating-point rounding', () => {
  assert.equal(parseHumanAmountToAtomic('12.340001', 6), '12340001');
  assert.throws(() => parseHumanAmountToAtomic('0.0000001', 6), SwapQuoteInputError);
  assert.throws(() => parseHumanAmountToAtomic('1e3', 6), SwapQuoteInputError);
});

test('requires a network when a token symbol is ambiguous', () => {
  assert.throws(
    () => resolveSwapToken(swapTokens, 'USDC'),
    (error: unknown) => error instanceof SwapQuoteInputError && error.missingFields.includes('assetNetwork'),
  );
  assert.equal(resolveSwapToken(swapTokens, 'USDC', 'Base').blockchain, 'base');
});

test('requests and returns a real EXACT_INPUT NEAR Intents quote preview', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://1click.chaindefuser.com/v0/quote');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      correlationId: 'near-correlation-1',
      quote: {
        amountIn: '12340000',
        amountInFormatted: '12.34',
        amountOut: '9876543210000000000000000',
        amountOutFormatted: '9.87654321',
        minAmountOut: '9500000000000000000000000',
        deadline: new Date(Date.now() + 60_000).toISOString(),
        timeEstimate: 45,
      },
    }), { status: 200 });
  };

  try {
    const result = await requestLiveSwapQuote({
      request: {
        sourceAsset: 'USDC',
        destinationAsset: 'wNEAR',
        amount: '12.34',
        sourceNetwork: 'Base',
        destinationNetwork: 'NEAR',
        recipientAddress: 'alice.near',
      },
      tokens: swapTokens,
      walletAddress,
    });

    assert.equal(requestBody?.dry, true);
    assert.equal(requestBody?.swapType, 'EXACT_INPUT');
    assert.equal(requestBody?.originAsset, swapTokens[0]?.assetId);
    assert.equal(requestBody?.depositType, 'ORIGIN_CHAIN');
    assert.equal(requestBody?.recipientType, 'DESTINATION_CHAIN');
    assert.equal(requestBody?.refundType, 'ORIGIN_CHAIN');
    assert.equal(requestBody?.destinationAsset, swapTokens[2]?.assetId);
    assert.equal(requestBody?.amount, '12340000');
    assert.equal(requestBody?.slippageTolerance, 100);
    assert.equal(typeof requestBody?.deadline, 'string');
    assert.ok(Date.parse(String(requestBody?.deadline)) > Date.now());
    assert.equal(result.quote.correlationId, 'near-correlation-1');
    assert.equal(result.quote.amountOutFormatted, '9.87654321');
    assert.equal(result.recipient, 'alice.near');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves NEAR Intents validation details instead of reporting provider downtime', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    statusCode: 400,
    message: 'slippageTolerance should not be empty',
  }), { status: 400 });

  try {
    await assert.rejects(
      previewQuote({ amount: '1' }),
      (error: unknown) =>
        error instanceof NearIntentsError &&
        error.code === 'NEAR_INTENTS_REQUEST_REJECTED' &&
        error.statusCode === 400 &&
        error.message.includes('slippageTolerance'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifies invalid partner authentication distinctly', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });

  try {
    await assert.rejects(
      previewQuote({ amount: '1' }),
      (error: unknown) =>
        error instanceof NearIntentsError &&
        error.code === 'NEAR_INTENTS_AUTH_FAILED' &&
        error.statusCode === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifies rate limits and retains bounded Retry-After timing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Slow down' }), {
    status: 429,
    headers: { 'retry-after': '2' },
  });

  try {
    await assert.rejects(
      previewQuote({ amount: '1' }),
      (error: unknown) =>
        error instanceof NearIntentsError &&
        error.code === 'NEAR_INTENTS_RATE_LIMITED' &&
        error.statusCode === 429 &&
        error.retryAfterMs === 2_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
