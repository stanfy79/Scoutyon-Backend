import { config } from '../src/config.js';
import { requestLiveSwapQuote } from '../src/services/swapQuoteService.js';
import { getConfiguredSourceToken, getTokenCatalogue } from '../src/services/nearTokenRegistry.js';
import { assertServerSignerConfigured } from '../src/services/privyWalletSender.js';
import { assertConfiguredChain, getWalletBalances } from '../src/services/walletBalance.js';

type Check = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };
const checks: Check[] = [];

function record(name: string, status: Check['status'], detail: string): void {
  checks.push({ name, status, detail });
}

function safeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const failure = error as { code?: string; message?: string };
    return [failure.code, failure.message].filter(Boolean).join(': ') || 'Unknown error';
  }
  return 'Unknown error';
}

async function main(): Promise<void> {
  console.log('NEAR INTENTS DIAGNOSTICS\n');
  console.log(`API host: ${new URL(config.NEAR_INTENTS_API_URL).host}`);
  console.log(`Partner JWT: ${config.NEAR_INTENTS_JWT ? 'configured' : 'not configured (unauthenticated fees apply)'}`);
  console.log(`Live payments enabled: ${config.PAYMENTS_LIVE_ENABLED && !config.SIMULATE_PAYMENTS}`);
  console.log(`1Click network: production API (NEAR_NETWORK=${config.NEAR_NETWORK} does not change it)\n`);

  let tokens: Awaited<ReturnType<typeof getTokenCatalogue>> = [];
  try {
    tokens = await getTokenCatalogue();
    record('API connectivity and token registry', 'PASS', `${tokens.length} supported assets loaded`);
  } catch (error) {
    record('API connectivity and token registry', 'FAIL', safeError(error));
  }

  let sourceToken: Awaited<ReturnType<typeof getConfiguredSourceToken>> | null = null;
  if (tokens.length === 0) {
    record('Configured source asset', 'FAIL', 'Cannot validate the configured asset without a live token catalogue');
  } else {
    try {
      sourceToken = await getConfiguredSourceToken();
      record(
        'Configured source asset',
        'PASS',
        `${sourceToken.symbol} on ${sourceToken.blockchain}; asset, chain and contract match live metadata`,
      );
    } catch (error) {
      record('Configured source asset', 'FAIL', safeError(error));
    }
  }

  try {
    await assertConfiguredChain();
    record('Source RPC and chain ID', 'PASS', `RPC reports chain ID ${config.PAYMENT_SOURCE_CHAIN_ID}`);
  } catch (error) {
    record('Source RPC and chain ID', 'FAIL', safeError(error));
  }

  const walletId = process.env.NEAR_INTENTS_DIAGNOSTIC_PRIVY_WALLET_ID?.trim();
  const walletAddress = process.env.NEAR_INTENTS_DIAGNOSTIC_WALLET_ADDRESS?.trim();
  const privyUserId = process.env.NEAR_INTENTS_DIAGNOSTIC_PRIVY_USER_ID?.trim();
  let signerReady = false;
  if (!walletId || !walletAddress || !privyUserId) {
    record(
      'Privy wallet and delegated signer',
      'SKIP',
      'Set NEAR_INTENTS_DIAGNOSTIC_PRIVY_WALLET_ID, NEAR_INTENTS_DIAGNOSTIC_WALLET_ADDRESS and NEAR_INTENTS_DIAGNOSTIC_PRIVY_USER_ID to perform a read-only wallet check',
    );
    record('Wallet balances and gas', 'SKIP', 'A diagnostic wallet address was not supplied');
  } else {
    try {
      await assertServerSignerConfigured(walletId, walletAddress, privyUserId);
      signerReady = true;
      record('Privy wallet and delegated signer', 'PASS', 'Wallet ownership, address and signer policy verified');
    } catch (error) {
      record('Privy wallet and delegated signer', 'FAIL', safeError(error));
    }

    if (!sourceToken) {
      record('Wallet balances and gas', 'FAIL', 'Cannot inspect balances until the configured source asset is resolved');
    } else {
      try {
        const balances = await getWalletBalances(walletAddress, sourceToken);
        const hasGas = balances.estimatedGasFee !== null && balances.nativeBalance >= balances.estimatedGasFee;
        record(
          'Wallet balances and gas',
          balances.tokenBalance > 0n && hasGas ? 'PASS' : 'FAIL',
          `Source token balance ${balances.tokenBalance > 0n ? 'available' : 'empty'}; native gas ${hasGas ? 'sufficient' : balances.gasEstimationError ?? 'insufficient'}`,
        );
      } catch (error) {
        record('Wallet balances and gas', 'FAIL', safeError(error));
      }
    }
  }

  const sourceAsset = process.env.NEAR_INTENTS_DIAGNOSTIC_SOURCE_ASSET?.trim();
  const sourceNetwork = process.env.NEAR_INTENTS_DIAGNOSTIC_SOURCE_NETWORK?.trim();
  const destinationAsset = process.env.NEAR_INTENTS_DIAGNOSTIC_DESTINATION_ASSET?.trim();
  const destinationNetwork = process.env.NEAR_INTENTS_DIAGNOSTIC_DESTINATION_NETWORK?.trim();
  const amount = process.env.NEAR_INTENTS_DIAGNOSTIC_AMOUNT?.trim();
  const recipientAddress = process.env.NEAR_INTENTS_DIAGNOSTIC_RECIPIENT_ADDRESS?.trim() || walletAddress;
  const refundAddress = process.env.NEAR_INTENTS_DIAGNOSTIC_REFUND_ADDRESS?.trim() || walletAddress;
  if (sourceAsset && destinationAsset && amount && recipientAddress && refundAddress) {
    try {
      const quote = await requestLiveSwapQuote({
        request: { sourceAsset, sourceNetwork, destinationAsset, destinationNetwork, amount, recipientAddress, refundAddress },
        tokens,
        walletAddress: walletAddress ?? null,
      });
      record(
        'Safe dry quote',
        'PASS',
        `${quote.sourceToken.symbol} ${quote.quote.amountIn} to ${quote.destinationToken.symbol} ${quote.quote.amountOut}; no deposit was created`,
      );
    } catch (error) {
      record('Safe dry quote', 'FAIL', safeError(error));
    }
  } else {
    record('Safe dry quote', 'SKIP', 'Provide diagnostic source/destination assets, amount, recipient and refund address to run a dry quote');
  }

  const executionReady =
    config.PAYMENTS_LIVE_ENABLED &&
    !config.SIMULATE_PAYMENTS &&
    tokens.length > 0 &&
    sourceToken !== null &&
    signerReady &&
    checks.some((check) => check.name === 'Source RPC and chain ID' && check.status === 'PASS') &&
    checks.some((check) => check.name === 'Wallet balances and gas' && check.status === 'PASS');

  for (const check of checks) {
    console.log(`[${check.status}] ${check.name}: ${check.detail}`);
  }
  console.log(`\nLIVE EXECUTION: ${executionReady ? 'READY (no transaction was sent)' : 'BLOCKED'}`);
  if (!executionReady) {
    console.log('Reason: all live-payment gates must pass, including the authenticated user wallet, delegated signer, supported source asset, RPC chain and sufficient balances.');
    process.exitCode = 1;
  }
}

await main();
