import { config } from '../config.js';

export interface IntentPaymentResult {
  simulated: boolean;
  intentId: string;
  txHash?: string;
  status: 'simulated' | 'pending' | 'confirmed' | 'failed';
  message: string;
}

/**
 * Execute a payment via NEAR Intents.
 * In SIMULATE_PAYMENTS mode (the MVP default) this returns a clearly-labelled
 * simulated result without touching any real funds.
 *
 * Real NEAR Intents integration should be added here once a NEAR account
 * is funded and the 1Click API endpoint is confirmed.
 * Docs: https://docs.near-intents.org/
 */
export async function executePayment(opts: {
  provider: string;
  amount: number;
  currency: string;
  description: string;
}): Promise<IntentPaymentResult> {
  if (config.SIMULATE_PAYMENTS) {
    const intentId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return {
      simulated: true,
      intentId,
      txHash: undefined,
      status: 'simulated',
      message:
        `[SIMULATED] A NEAR Intents transaction for ${opts.currency} ${opts.amount.toFixed(2)} ` +
        `to ${opts.provider} would be executed here. ` +
        `No real funds have been moved. Intent ID: ${intentId}`,
    };
  }

  // TODO: Real NEAR Intents 1Click API integration
  // 1. Build the intent payload (solver bus API)
  // 2. Sign with the user-authorised NEAR key (never the user's private key)
  // 3. Submit to the intent relayer
  // 4. Poll for confirmation
  throw new Error(
    'Live NEAR Intents payments are not yet implemented. Set SIMULATE_PAYMENTS=true.',
  );
}
