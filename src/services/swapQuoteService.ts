import { isAddress } from 'viem';
import type { NearIntentToken } from './nearIntents.js';
import { previewQuote } from './nearIntents.js';

export interface SwapQuoteRequest {
  sourceAsset?: string;
  destinationAsset?: string;
  amount?: string;
  sourceNetwork?: string;
  destinationNetwork?: string;
  recipientAddress?: string;
  refundAddress?: string;
}

export interface LiveSwapQuotePreview {
  correlationId: string;
  amountIn: string;
  amountInFormatted: string | null;
  amountOut: string;
  amountOutFormatted: string | null;
  minAmountOut: string | null;
  expiresAt: Date | null;
  timeEstimateSeconds: number | null;
}

export class SwapQuoteInputError extends Error {
  constructor(
    message: string,
    readonly missingFields: string[] = [],
  ) {
    super(message);
    this.name = 'SwapQuoteInputError';
  }
}

export function parseHumanAmountToAtomic(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new SwapQuoteInputError('Enter a positive amount using digits and an optional decimal point.', ['amount']);
  }

  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) {
    throw new SwapQuoteInputError(`This token supports at most ${decimals} decimal places.`, ['amount']);
  }
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (atomic <= 0n) {
    throw new SwapQuoteInputError('The swap amount must be greater than zero.', ['amount']);
  }
  return atomic.toString();
}

function normalizedBlockchain(value: string): string {
  const network = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = {
    ethereum: 'eth',
    mainnet: 'eth',
    arbitrum: 'arb',
    arbitrumone: 'arb',
    base: 'base',
    nearprotocol: 'near',
    solana: 'sol',
    polygon: 'pol',
    polygonpos: 'pol',
    avalanche: 'avax',
    avalanchecchain: 'avax',
    binance: 'bsc',
    bnb: 'bsc',
  };
  return aliases[network] ?? network;
}

export function resolveSwapToken(
  tokens: NearIntentToken[],
  asset: string,
  network?: string,
  fieldName = 'asset',
): NearIntentToken {
  const requested = asset.trim();
  const exactAssetId = tokens.find((token) => token.assetId === requested);
  const candidates = exactAssetId
    ? [exactAssetId]
    : tokens.filter((token) => token.symbol.toLowerCase() === requested.toLowerCase());
  const networkCandidates = network
    ? candidates.filter((token) => normalizedBlockchain(token.blockchain) === normalizedBlockchain(network))
    : candidates;

  if (network && networkCandidates.length === 0) {
    throw new SwapQuoteInputError(`I couldn't find ${requested} on ${network}. Check the token and network.`, [fieldName]);
  }
  if (networkCandidates.length === 0) {
    throw new SwapQuoteInputError(`I couldn't find a supported token matching ${requested}.`, [fieldName]);
  }
  if (networkCandidates.length > 1) {
    const networks = [...new Set(networkCandidates.map((token) => token.blockchain))].join(', ');
    throw new SwapQuoteInputError(`Which network should I use for ${requested}: ${networks}?`, [`${fieldName}Network`]);
  }
  return networkCandidates[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveAtomic(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`NEAR Intents returned an invalid ${field} in its swap quote.`);
  }
  return value;
}

function extractLiveQuote(payload: unknown): LiveSwapQuotePreview {
  if (!isRecord(payload)) throw new Error('NEAR Intents returned an invalid swap quote.');
  const quote = isRecord(payload.quote) ? payload.quote : payload;
  const correlationId = typeof payload.correlationId === 'string'
    ? payload.correlationId
    : typeof quote.correlationId === 'string'
      ? quote.correlationId
      : '';
  if (!correlationId) throw new Error('NEAR Intents returned a quote without a correlation ID.');

  const expiresAt = typeof quote.deadline === 'string' ? new Date(quote.deadline) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw new Error('NEAR Intents returned an expired swap quote.');
  }
  const timeEstimate = quote.timeEstimate;
  return {
    correlationId,
    amountIn: readPositiveAtomic(quote.amountIn, 'input amount'),
    amountInFormatted: typeof quote.amountInFormatted === 'string' ? quote.amountInFormatted : null,
    amountOut: readPositiveAtomic(quote.amountOut, 'output amount'),
    amountOutFormatted: typeof quote.amountOutFormatted === 'string' ? quote.amountOutFormatted : null,
    minAmountOut: quote.minAmountOut == null ? null : readPositiveAtomic(quote.minAmountOut, 'minimum output amount'),
    expiresAt,
    timeEstimateSeconds: typeof timeEstimate === 'number' && Number.isFinite(timeEstimate) && timeEstimate >= 0
      ? timeEstimate
      : null,
  };
}

function isEvmBlockchain(blockchain: string): boolean {
  return ['eth', 'arb', 'base', 'pol', 'avax', 'bsc', 'op'].includes(normalizedBlockchain(blockchain));
}

function validateAddressForBlockchain(address: string, blockchain: string): boolean {
  const chain = normalizedBlockchain(blockchain);
  if (isEvmBlockchain(chain)) return isAddress(address);
  if (chain === 'near') {
    return /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*|[a-f0-9]{64})$/.test(address) && address.length >= 2 && address.length <= 64;
  }
  if (chain === 'sol') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
  if (chain === 'tron') {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  }
  if (chain === 'stellar') {
    return /^G[A-Z2-7]{55}$/.test(address);
  }
  return address.length > 0;
}

export async function requestLiveSwapQuote(input: {
  request: SwapQuoteRequest;
  tokens: NearIntentToken[];
  walletAddress: string | null;
}): Promise<{
  sourceToken: NearIntentToken;
  destinationToken: NearIntentToken;
  recipient: string;
  refundTo: string;
  quote: LiveSwapQuotePreview;
}> {
  const { request, tokens, walletAddress } = input;
  const missing: string[] = [];
  if (!request.sourceAsset?.trim()) missing.push('sourceAsset');
  if (!request.destinationAsset?.trim()) missing.push('destinationAsset');
  if (!request.amount?.trim()) missing.push('amount');
  if (missing.length > 0) {
    throw new SwapQuoteInputError('Please provide the source token, destination token, and amount.', missing);
  }

  const sourceToken = resolveSwapToken(tokens, request.sourceAsset!, request.sourceNetwork, 'sourceAsset');
  const destinationToken = resolveSwapToken(tokens, request.destinationAsset!, request.destinationNetwork, 'destinationAsset');
  const amountAtomic = parseHumanAmountToAtomic(request.amount!, sourceToken.decimals);

  if (!walletAddress || !isAddress(walletAddress)) {
    throw new SwapQuoteInputError('Set up a valid wallet first so the quote can include a refund address.', ['refundAddress']);
  }
  const refundTo = request.refundAddress?.trim() || (isEvmBlockchain(sourceToken.blockchain) ? walletAddress : '');
  const recipient = request.recipientAddress?.trim() || (isEvmBlockchain(destinationToken.blockchain) ? walletAddress : '');

  if (!refundTo) {
    throw new SwapQuoteInputError(`What ${sourceToken.blockchain} address should receive a refund if the swap fails?`, ['refundAddress']);
  }
  if (!recipient) {
    throw new SwapQuoteInputError(`What ${destinationToken.blockchain} address should receive the swapped tokens?`, ['recipientAddress']);
  }
  if (!validateAddressForBlockchain(refundTo, sourceToken.blockchain)) {
    throw new SwapQuoteInputError(`The refund address is not valid for ${sourceToken.blockchain}.`, ['refundAddress']);
  }
  if (!validateAddressForBlockchain(recipient, destinationToken.blockchain)) {
    throw new SwapQuoteInputError(`The recipient address is not valid for ${destinationToken.blockchain}.`, ['recipientAddress']);
  }

  const response = await previewQuote({
    swapType: 'EXACT_INPUT',
    originAsset: sourceToken.assetId,
    ...(normalizedBlockchain(sourceToken.blockchain) === 'stellar' && { depositMode: 'MEMO' }),
    destinationAsset: destinationToken.assetId,
    amount: amountAtomic,
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    refundTo,
    refundType: 'ORIGIN_CHAIN',
  });
  const quote = extractLiveQuote(response);
  if (quote.amountIn !== amountAtomic) {
    throw new Error('NEAR Intents quote does not match the requested input amount.');
  }

  return { sourceToken, destinationToken, recipient, refundTo, quote };
}
