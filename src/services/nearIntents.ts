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

export interface ExactInputExecutableQuote {
  depositAddress: string;
  depositMemo: string | null;
  amountIn: string;
  amountInFormatted: string | null;
  amountOut: string;
  amountOutFormatted: string | null;
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
  destinationExplorerUrl: string | null;
  raw: Record<string, unknown>;
}

export class NearIntentsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 502,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NearIntentsError';
  }
}

function errorText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.min(Math.max(timestamp - Date.now(), 0), 60_000);
}

async function providerErrorMessage(response: Response): Promise<string | null> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(body);
    if (isRecord(payload)) {
      const message = Array.isArray(payload.message)
        ? payload.message.filter((item): item is string => typeof item === 'string').join('; ')
        : typeof payload.message === 'string'
          ? payload.message
          : typeof payload.error === 'string'
            ? payload.error
            : null;
      return message ? errorText(message) : null;
    }
  } catch {
    return body ? errorText(body) : null;
  }
  return null;
}

async function requestJson(
  path: string,
  init?: RequestInit,
  options: { ambiguousOutcome?: boolean } = {},
): Promise<unknown> {
  const baseUrl = config.NEAR_INTENTS_API_URL.replace(/\/+$/, '');
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (init?.body) headers.set('content-type', 'application/json');
  if (config.NEAR_INTENTS_JWT) {
    headers.set('authorization', `Bearer ${config.NEAR_INTENTS_JWT}`);
  }

  let response: Response;
  const startedAt = Date.now();
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const cause = error as { code?: string; name?: string; message?: string };
    const timedOut =
      cause.name === 'AbortError' ||
      cause.name === 'TimeoutError' ||
      /timeout|timed out/i.test(cause.message ?? '');
    const code = options.ambiguousOutcome
      ? 'NEAR_INTENTS_OUTCOME_UNKNOWN'
      : timedOut
        ? 'NEAR_INTENTS_TIMEOUT'
        : 'NEAR_INTENTS_NETWORK_ERROR';
    const message = options.ambiguousOutcome
      ? 'The executable quote request outcome is unknown. Check with NEAR Intents before preparing another payment.'
      : timedOut
        ? 'NEAR Intents did not respond before the request timed out.'
        : 'Unable to connect to the NEAR Intents API.';
    console.error('[NEAR Intents] request failed', {
      method,
      endpoint: path,
      durationMs,
      code,
      causeName: cause.name ?? 'UnknownError',
      causeCode: cause.code,
    });
    throw new NearIntentsError(message, code);
  }

  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    const providerMessage = await providerErrorMessage(response);
    const retryAfterMs = response.status === 429
      ? retryAfterMilliseconds(response.headers.get('retry-after'))
      : undefined;
    const code = response.status === 401
      ? 'NEAR_INTENTS_AUTH_FAILED'
      : response.status === 429
        ? 'NEAR_INTENTS_RATE_LIMITED'
        : response.status === 400 || response.status === 422
          ? 'NEAR_INTENTS_REQUEST_REJECTED'
          : response.status >= 500
            ? 'NEAR_INTENTS_PROVIDER_ERROR'
            : 'NEAR_INTENTS_REQUEST_FAILED';
    const statusCode = response.status === 401
      ? 503
      : response.status === 429
        ? 429
        : response.status === 400 || response.status === 422
          ? 400
          : 502;
    console.error('[NEAR Intents] provider returned an error', {
      method,
      endpoint: path,
      durationMs,
      httpStatus: response.status,
      code,
      providerMessage,
      providerRequestId: response.headers.get('x-request-id') ?? response.headers.get('request-id'),
      retryAfterMs,
    });
    throw new NearIntentsError(
      `NEAR Intents request failed with HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ''}`,
      code,
      statusCode,
      retryAfterMs,
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
  }, { ambiguousOutcome: true });

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

export async function createExactInputExecutableQuote(input: {
  originAsset: string;
  destinationAsset: string;
  amountIn: string;
  recipient: string;
  refundTo: string;
  slippageTolerance?: number;
}): Promise<ExactInputExecutableQuote> {
  const requestedAmount = atomicAmount(input.amountIn, 'input amount');
  const slippageTolerance = input.slippageTolerance ?? config.PAYMENT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageTolerance) || slippageTolerance < 0 || slippageTolerance > 10_000) {
    throw new NearIntentsError('Invalid slippage tolerance for executable quote', 'NEAR_INTENTS_INVALID_REQUEST', 400);
  }
  const payload = await requestJson('/v0/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: input.originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: input.destinationAsset,
      amount: requestedAmount,
      recipient: input.recipient,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: input.refundTo,
      refundType: 'ORIGIN_CHAIN',
      slippageTolerance,
      deadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }),
  }, { ambiguousOutcome: true });

  const response = isRecord(payload) ? payload : null;
  const quote = response && isRecord(response.quote) ? response.quote : response;
  if (!quote) {
    throw new NearIntentsError('NEAR Intents returned an invalid executable quote', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  const deadline = typeof quote.deadline === 'string' ? new Date(quote.deadline) : new Date(Number.NaN);
  const correlationId = typeof response?.correlationId === 'string'
    ? response.correlationId
    : typeof quote.correlationId === 'string'
      ? quote.correlationId
      : '';
  if (
    typeof quote.depositAddress !== 'string' ||
    !quote.depositAddress.trim() ||
    !correlationId ||
    Number.isNaN(deadline.getTime()) ||
    deadline.getTime() <= Date.now()
  ) {
    throw new NearIntentsError('NEAR Intents returned an invalid or expired executable quote', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  const amountIn = atomicAmount(quote.amountIn, 'input amount');
  if (amountIn !== requestedAmount) {
    throw new NearIntentsError('Executable quote input does not match the reviewed preview', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  const amountOut = atomicAmount(quote.amountOut, 'output amount');
  const minAmountOut = quote.minAmountOut == null ? null : atomicAmount(quote.minAmountOut, 'minimum output amount');
  if (minAmountOut !== null && BigInt(minAmountOut) > BigInt(amountOut)) {
    throw new NearIntentsError('NEAR Intents returned an invalid minimum output amount', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  return {
    depositAddress: quote.depositAddress,
    depositMemo: typeof quote.depositMemo === 'string' ? quote.depositMemo : null,
    amountIn,
    amountInFormatted: typeof quote.amountInFormatted === 'string' ? quote.amountInFormatted : null,
    amountOut,
    amountOutFormatted: typeof quote.amountOutFormatted === 'string' ? quote.amountOutFormatted : null,
    minAmountOut,
    deadline,
    correlationId,
    raw: response!,
  };
}

export async function submitDepositTransaction(depositAddress: string, txHash: string): Promise<void> {
  await requestJson('/v0/deposit/submit', {
    method: 'POST',
    body: JSON.stringify({ depositAddress, txHash }),
  });
}

export async function getExecutionStatus(depositAddress: string, depositMemo?: string | null): Promise<NearExecutionStatus> {
  const query = new URLSearchParams({ depositAddress });
  if (depositMemo) query.set('depositMemo', depositMemo);
  const payload = await requestJson(`/v0/status?${query.toString()}`);
  const statusData = isRecord(payload) ? payload : null;
  const validStatuses = [
    'PENDING_DEPOSIT',
    'KNOWN_DEPOSIT_TX',
    'PROCESSING',
    'SUCCESS',
    'INCOMPLETE_DEPOSIT',
    'REFUNDED',
    'FAILED',
  ] as const;
  if (!statusData || !validStatuses.includes(statusData.status as (typeof validStatuses)[number])) {
    throw new NearIntentsError('NEAR Intents returned an unknown payment status', 'NEAR_INTENTS_INVALID_RESPONSE');
  }
  const swapDetails = isRecord(statusData.swapDetails) ? statusData.swapDetails : {};
  const destinationTxs = Array.isArray(swapDetails.destinationChainTxHashes)
    ? swapDetails.destinationChainTxHashes.filter(isRecord)
    : [];
  const firstDestinationTx = destinationTxs[0];
  const destinationTxHash =
    typeof statusData.destinationTxHash === 'string'
      ? statusData.destinationTxHash
      : typeof statusData.destinationTransactionHash === 'string'
        ? statusData.destinationTransactionHash
        : firstDestinationTx && typeof firstDestinationTx.hash === 'string'
          ? firstDestinationTx.hash
          : null;
  const destinationExplorerUrl =
    firstDestinationTx && typeof firstDestinationTx.explorerUrl === 'string'
      ? firstDestinationTx.explorerUrl.slice(0, 2048)
      : null;
  const rawSourceTxs = Array.isArray(swapDetails.originChainTxHashes)
    ? swapDetails.originChainTxHashes.filter(isRecord)
    : [];
  const safeFields = [
    'amountIn',
    'amountOut',
    'amountInFormatted',
    'amountOutFormatted',
    'depositedAmount',
    'refundedAmount',
    'refundReason',
    'slippage',
    'updatedAt',
  ];
  const responseEntries = [
    ...[
      'status',
      'destinationTxHash',
      'destinationTransactionHash',
      'refundTxHash',
      ...safeFields,
      'reason',
    ]
      .filter((key) => ['string', 'number', 'boolean'].includes(typeof (key in swapDetails ? swapDetails[key] : statusData[key])))
      .map((key) => [
        key,
        key === 'reason' && typeof statusData[key] === 'string'
          ? statusData[key].slice(0, 512)
          : key === 'refundReason' && typeof swapDetails[key] === 'string'
            ? swapDetails[key].slice(0, 512)
            : key in swapDetails
              ? swapDetails[key]
              : statusData[key],
      ] as const),
    ...rawSourceTxs.map((tx, index) => [`originChainTxHashes.${index}`, tx] as const),
    ...destinationTxs.map((tx, index) => [`destinationChainTxHashes.${index}`, tx] as const),
  ];
  return {
    status: statusData.status as NearExecutionStatus['status'],
    destinationTransactionHash: destinationTxHash,
    destinationExplorerUrl,
    raw: Object.fromEntries(responseEntries),
  };
}

/** Simulation remains isolated for legacy development fixtures only. */
export async function executePayment(): Promise<never> {
  throw new Error('Legacy payment execution is disabled. Use the prepare-and-confirm payment flow.');
}
