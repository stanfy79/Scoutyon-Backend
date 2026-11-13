import { config } from '../config.js';

export interface NearIntentToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: string;
  priceUpdatedAt?: string;
  contractAddress?: string;
}

export interface ExecutableQuote {
  depositAddress: string;
  depositMemo: string | null;
  amountIn: string;
  amountInFormatted: string | null;
  minAmountIn: string | null;
  maxAmountIn: string | null;
  amountOut: string;
  minAmountOut: string | null;
  deadline: Date;
  correlationId: string;
  raw: Record<string, unknown>;
}

export interface NearExecutionStatus {
  status:
    | 'PENDING_DEPOSIT'
    | 'KNOWN_DEPOSIT_TX'
    | 'PROCESSING'
    | 'SUCCESS'
    | 'INCOMPLETE_DEPOSIT'
    | 'REFUNDED'
    | 'FAILED';
  destinationTransactionHash: string | null;
  raw: Record<string, unknown>;
}

export class NearIntentsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'NearIntentsError';
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const baseUrl = config.NEAR_INTENTS_API_URL.replace(/\/+$/, '');
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (init?.body) headers.set('content-type', 'application/json');
  if (config.NEAR_INTENTS_JWT) {
    headers.set('authorization', `Bearer ${config.NEAR_INTENTS_JWT}`);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new NearIntentsError('NEAR Intents is temporarily unavailable', 'NEAR_INTENTS_QUOTE_FAILED');
  }

  if (!response.ok) {
    throw new NearIntentsError(
      `NEAR Intents request failed with HTTP ${response.status}`,
      'NEAR_INTENTS_QUOTE_FAILED',
    );
  }

  if (response.status === 204) return null;

  try {
    return await response.json();
  } catch {
    throw new NearIntentsError('NEAR Intents returned an invalid response', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function atomicAmount(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new NearIntentsError(`NEAR Intents returned an invalid ${field}`, 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  return value;
}

export async function getSupportedTokens(): Promise<NearIntentToken[]> {
  const payload = await requestJson('/v0/tokens');
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.tokens)
      ? payload.tokens
      : null;
  if (!entries) {
    throw new NearIntentsError('NEAR Intents returned an invalid token catalogue', 'NEAR_INTENTS_INVALID_RESPONSE');
  }

  return entries.map((entry): NearIntentToken => {
    if (
      !isRecord(entry) ||
      typeof entry.assetId !== 'string' ||
      !entry.assetId ||
      typeof entry.blockchain !== 'string' ||
      typeof entry.symbol !== 'string' ||
      typeof entry.decimals !== 'number' ||
      !Number.isInteger(entry.decimals) ||
      entry.decimals < 0 ||
      entry.decimals > 36
    ) {
      throw new NearIntentsError('NEAR Intents returned invalid token metadata', 'NEAR_INTENTS_INVALID_RESPONSE');
    }

    return {
      assetId: entry.assetId,
      decimals: entry.decimals,
      blockchain: entry.blockchain,
      symbol: entry.symbol,
      ...(typeof entry.price === 'string' && { price: entry.price }),
      ...(typeof entry.price === 'number' && Number.isFinite(entry.price) && { price: String(entry.price) }),
      ...(typeof entry.priceUpdatedAt === 'string' && { priceUpdatedAt: entry.priceUpdatedAt }),
      ...(typeof entry.contractAddress === 'string' && { contractAddress: entry.contractAddress }),
    };
  });
}

export async function previewQuote<T extends Record<string, unknown>>(params: T): Promise<unknown> {
  return requestJson('/v0/quote', {
    method: 'POST',
    body: JSON.stringify({ ...params, dry: true }),
  });
}

export async function createExecutableQuote(input: {
  originAsset: string;
  destinationAsset: string;
  destinationAmount: string;
  recipient: string;
  refundTo: string;
}): Promise<ExecutableQuote> {
  const payload = await requestJson('/v0/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: false,
      swapType: 'EXACT_OUTPUT',
      originAsset: input.originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: input.destinationAsset,
      amount: atomicAmount(input.destinationAmount, 'destination amount'),
      recipient: input.recipient,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: input.refundTo,
      refundType: 'ORIGIN_CHAIN',
      slippageTolerance: config.PAYMENT_SLIPPAGE_BPS,
      deadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }),
  });

  const quote = isRecord(payload) && isRecord(payload.quote) ? payload.quote : payload;
  if (!isRecord(quote)) {
    throw new NearIntentsError('NEAR Intents returned an invalid executable quote', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  const deadlineValue = quote.deadline;
  const deadline = typeof deadlineValue === 'string' ? new Date(deadlineValue) : new Date(Number.NaN);
  if (
    typeof quote.depositAddress !== 'string' ||
    !quote.depositAddress ||
    typeof quote.correlationId !== 'string' ||
    !quote.correlationId ||
    Number.isNaN(deadline.getTime()) ||
    deadline.getTime() <= Date.now()
  ) {
    throw new NearIntentsError('NEAR Intents returned an invalid or expired quote', 'NEAR_INTENTS_INVALID_RESPONSE');
  }

  const amountOut = atomicAmount(quote.amountOut, 'output amount');
  if (amountOut !== input.destinationAmount) {
    throw new NearIntentsError('NEAR Intents quote does not match the requested output amount', 'NEAR_INTENTS_INVALID_RESPONSE');
  }

  const amountIn = atomicAmount(quote.amountIn, 'input amount');
  const minAmountIn = quote.minAmountIn == null ? null : atomicAmount(quote.minAmountIn, 'minimum input amount');
  const maxAmountIn = quote.maxAmountIn == null ? null : atomicAmount(quote.maxAmountIn, 'maximum input amount');
  if (
    minAmountIn === null ||
    maxAmountIn === null ||
    BigInt(amountIn) < BigInt(minAmountIn) ||
    BigInt(amountIn) > BigInt(maxAmountIn) ||
    BigInt(minAmountIn) > BigInt(maxAmountIn)
  ) {
    throw new NearIntentsError('NEAR Intents quote returned an inconsistent input range', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  const minAmountOut =
    quote.minAmountOut == null ? null : atomicAmount(quote.minAmountOut, 'minimum output amount');
  if (minAmountOut !== null && BigInt(minAmountOut) > BigInt(amountOut)) {
    throw new NearIntentsError('NEAR Intents quote returned an invalid minimum output amount', 'NEAR_INTENTS_INVALID_RESPONSE');
  }

  return {
    depositAddress: quote.depositAddress,
    depositMemo: typeof quote.depositMemo === 'string' ? quote.depositMemo : null,
    amountIn,
    amountInFormatted: typeof quote.amountInFormatted === 'string' ? quote.amountInFormatted : null,
    minAmountIn,
    maxAmountIn,
    amountOut,
    minAmountOut,
    deadline,
    correlationId: quote.correlationId,
    raw: quote,
  };
}

export async function submitDepositTransaction(depositAddress: string, txHash: string): Promise<void> {
  await requestJson('/v0/deposit/submit', {
    method: 'POST',
    body: JSON.stringify({ depositAddress, txHash }),
  });
}

export async function getExecutionStatus(depositAddress: string): Promise<NearExecutionStatus> {
  const payload = await requestJson(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  const statusData = isRecord(payload) && isRecord(payload.status) ? payload.status : payload;
  const validStatuses = [
    'PENDING_DEPOSIT',
    'KNOWN_DEPOSIT_TX',
    'PROCESSING',
    'SUCCESS',
    'INCOMPLETE_DEPOSIT',
    'REFUNDED',
    'FAILED',
  ] as const;
  if (!isRecord(statusData) || !validStatuses.includes(statusData.status as (typeof validStatuses)[number])) {
    throw new NearIntentsError('NEAR Intents returned an unknown payment status', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  const destinationTxHash =
    typeof statusData.destinationTxHash === 'string'
      ? statusData.destinationTxHash
      : typeof statusData.destinationTransactionHash === 'string'
        ? statusData.destinationTransactionHash
        : null;
  return {
    status: statusData.status as NearExecutionStatus['status'],
    destinationTransactionHash: destinationTxHash,
    raw: Object.fromEntries(
      [
        'status',
        'destinationTxHash',
        'destinationTransactionHash',
        'refundTxHash',
        'amountIn',
        'amountOut',
        'updatedAt',
        'reason',
      ]
        .filter((key) => ['string', 'number', 'boolean'].includes(typeof statusData[key]))
        .map((key) => [
          key,
          key === 'reason' && typeof statusData[key] === 'string'
            ? statusData[key].slice(0, 512)
            : statusData[key],
        ]),
    ),
  };
}

/** Simulation remains isolated for legacy development fixtures only. */
export async function executePayment(): Promise<never> {
  throw new Error('Legacy payment execution is disabled. Use the prepare-and-confirm payment flow.');
}
