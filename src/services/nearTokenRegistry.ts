import { config } from '../config.js';
import { getSupportedTokens, type NearIntentToken } from './nearIntents.js';

let catalogue: { expiresAt: number; tokens: NearIntentToken[] } | null = null;
const approvedEvmChainIds: Record<string, number> = {
  eth: 1,
  arb: 42161,
  base: 8453,
};

export async function getTokenCatalogue(): Promise<NearIntentToken[]> {
  if (catalogue && catalogue.expiresAt > Date.now()) return catalogue.tokens;
  return refreshTokenCatalogue();
}

async function refreshTokenCatalogue(): Promise<NearIntentToken[]> {
  const tokens = await getSupportedTokens();
  catalogue = {
    tokens,
    expiresAt: Date.now() + config.PAYMENT_TOKEN_CACHE_TTL_SECONDS * 1000,
  };
  return tokens;
}

export async function getTokenByAssetId(assetId: string): Promise<NearIntentToken> {
  const cachedCatalogueWasFresh = catalogue !== null && catalogue.expiresAt > Date.now();
  let token = (await getTokenCatalogue()).find((candidate) => candidate.assetId === assetId);
  if (!token && cachedCatalogueWasFresh) {
    token = (await refreshTokenCatalogue()).find((candidate) => candidate.assetId === assetId);
  }
  if (!token) {
    throw Object.assign(new Error('The requested payment token is not supported'), {
      code: 'TOKEN_NOT_SUPPORTED',
      statusCode: 400,
    });
  }
  return token;
}

export async function getConfiguredSourceToken(): Promise<NearIntentToken> {
  if (
    !config.PAYMENT_SOURCE_ASSET_ID ||
    !config.PAYMENT_SOURCE_CHAIN_ID ||
    !config.PAYMENT_SOURCE_TOKEN_ADDRESS
  ) {
    throw Object.assign(new Error('Live payment source asset is not configured'), {
      code: 'PAYMENTS_DISABLED',
      statusCode: 503,
    });
  }

  let token: NearIntentToken;
  try {
    token = await getTokenByAssetId(config.PAYMENT_SOURCE_ASSET_ID);
  } catch (error) {
    if ((error as { code?: string }).code !== 'TOKEN_NOT_SUPPORTED') throw error;
    throw Object.assign(
      new Error('Configured payment source asset ID is not present in the live NEAR Intents token catalogue'),
      { code: 'PAYMENT_SOURCE_ASSET_UNSUPPORTED', statusCode: 503 },
    );
  }

  const mappedChainId = approvedEvmChainIds[token.blockchain.toLowerCase()];
  if (
    !config.PAYMENT_SOURCE_BLOCKCHAIN ||
    !token.contractAddress ||
    token.blockchain.toLowerCase() !== config.PAYMENT_SOURCE_BLOCKCHAIN.toLowerCase() ||
    mappedChainId !== config.PAYMENT_SOURCE_CHAIN_ID ||
    token.contractAddress.toLowerCase() !== config.PAYMENT_SOURCE_TOKEN_ADDRESS.toLowerCase()
  ) {
    throw Object.assign(new Error('Configured source asset ID, blockchain, chain ID, and token contract do not match NEAR Intents metadata'), {
      code: 'PAYMENT_SOURCE_ASSET_MISMATCH',
      statusCode: 503,
    });
  }
  return token;
}
