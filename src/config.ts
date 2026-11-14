import { z } from 'zod';
import 'dotenv/config';
import { createPrivateKey } from 'node:crypto';

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const envSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/)
    .default('3001')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  PRIVY_APP_ID: z.string().min(1, 'PRIVY_APP_ID is required'),
  PRIVY_APP_SECRET: z.string().min(1, 'PRIVY_APP_SECRET is required'),
  PRIVY_JWT_VERIFICATION_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  NEAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  SIMULATE_PAYMENTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  PAYMENTS_LIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PRIVY_AUTHORIZATION_PRIVATE_KEY: optionalText,
  PRIVY_KEY_QUORUM_ID: optionalText,
  PRIVY_TRANSFER_POLICY_ID: optionalText,
  PRIVY_BASE_TOKEN_LIMITS: z
    .string()
    .default('{}')
    .transform((value, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PRIVY_BASE_TOKEN_LIMITS must be a JSON object mapping token addresses to maximum atomic amounts' });
        return {};
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PRIVY_BASE_TOKEN_LIMITS must be a JSON object mapping token addresses to maximum atomic amounts' });
        return {};
      }
      const entries = Object.entries(parsed);
      if (entries.some(([address, amount]) =>
        !/^0x[a-fA-F0-9]{40}$/.test(address) ||
        typeof amount !== 'string' ||
        !/^[1-9]\d*$/.test(amount)
      )) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PRIVY_BASE_TOKEN_LIMITS keys must be EVM token addresses and values must be positive integer atomic amounts' });
        return {};
      }
      const normalized: Record<string, string> = {};
      for (const [address, amount] of entries as Array<[string, string]>) {
        const key = address.toLowerCase();
        if (normalized[key]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PRIVY_BASE_TOKEN_LIMITS must not contain duplicate token addresses' });
          return {};
        }
        normalized[key] = amount;
      }
      return normalized;
    })
    .pipe(z.record(z.string().regex(/^0x[a-f0-9]{40}$/), z.string().regex(/^[1-9]\d*$/))),
  NEAR_INTENTS_API_URL: z.string().url().default('https://1click.chaindefuser.com'),
  NEAR_INTENTS_JWT: optionalText,
  PAYMENT_SOURCE_ASSET_ID: optionalText,
  PAYMENT_SOURCE_CHAIN_ID: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().regex(/^\d+$/).optional(),
  ).transform((value) => (value === undefined ? undefined : Number(value))).pipe(z.number().int().positive().optional()),
  PAYMENT_SOURCE_BLOCKCHAIN: optionalText.pipe(z.string().min(1).optional()),
  PAYMENT_SOURCE_RPC_URL: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().url().optional(),
  ),
  SWAP_EVM_RPC_URLS: z
    .string()
    .default('{}')
    .transform((value, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SWAP_EVM_RPC_URLS must be a JSON object' });
        return {};
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((url) => typeof url !== 'string')
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SWAP_EVM_RPC_URLS must map numeric chain IDs to URL strings' });
        return {};
      }
      return parsed as Record<string, string>;
    })
    .pipe(z.record(z.string().regex(/^\d+$/), z.string().url())),
  PAYMENT_SOURCE_TOKEN_ADDRESS: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  ),
  PAYMENT_SLIPPAGE_BPS: z
    .string()
    .regex(/^\d+$/)
    .default('100')
    .transform(Number)
    .pipe(z.number().int().min(1).max(5000)),
  PAYMENT_TOKEN_CACHE_TTL_SECONDS: z
    .string()
    .regex(/^\d+$/)
    .default('60')
    .transform(Number)
    .pipe(z.number().int().min(1).max(3600)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

if (
  parsed.data.NODE_ENV === 'production' &&
  parsed.data.PAYMENTS_LIVE_ENABLED &&
  (parsed.data.PAYMENT_SOURCE_RPC_URL?.startsWith('https://') !== true ||
    parsed.data.NEAR_INTENTS_API_URL.startsWith('https://') !== true)
) {
  console.error(' - Live payment RPC and NEAR Intents URLs must use HTTPS in production');
  process.exit(1);
}

if (
  parsed.data.NODE_ENV === 'production' &&
  Object.values(parsed.data.SWAP_EVM_RPC_URLS).some((rpcUrl) => !rpcUrl.startsWith('https://'))
) {
  console.error(' - General swap RPC URLs must use HTTPS in production');
  process.exit(1);
}

if (
  parsed.data.PAYMENTS_LIVE_ENABLED &&
  new URL(parsed.data.NEAR_INTENTS_API_URL).hostname !== '1click.chaindefuser.com'
) {
  console.error(' - Live payments must use the official NEAR Intents 1Click API host');
  process.exit(1);
}

if (parsed.data.PAYMENTS_LIVE_ENABLED && parsed.data.SIMULATE_PAYMENTS) {
  console.error(' - PAYMENTS_LIVE_ENABLED: cannot be enabled while SIMULATE_PAYMENTS=true');
  process.exit(1);
}

if (parsed.data.PAYMENTS_LIVE_ENABLED) {
  const requiredPaymentSettings = [
    'PRIVY_AUTHORIZATION_PRIVATE_KEY',
    'PRIVY_KEY_QUORUM_ID',
    'PRIVY_TRANSFER_POLICY_ID',
    'PRIVY_BASE_TOKEN_LIMITS',
    'PAYMENT_SOURCE_ASSET_ID',
    'PAYMENT_SOURCE_BLOCKCHAIN',
    'PAYMENT_SOURCE_CHAIN_ID',
    'PAYMENT_SOURCE_RPC_URL',
    'PAYMENT_SOURCE_TOKEN_ADDRESS',
  ] as const;
  const missingSettings = requiredPaymentSettings.filter((key) => !parsed.data[key]);
  if (missingSettings.length > 0) {
    console.error(` - Live payment settings are required: ${missingSettings.join(', ')}`);
    process.exit(1);
  }
  if (parsed.data.PAYMENT_SOURCE_CHAIN_ID !== 8453) {
    console.error(' - Live Privy payment signer execution is restricted to Base (chain ID 8453)');
    process.exit(1);
  }
  if (
    parsed.data.PAYMENT_SOURCE_TOKEN_ADDRESS &&
    !parsed.data.PRIVY_BASE_TOKEN_LIMITS[parsed.data.PAYMENT_SOURCE_TOKEN_ADDRESS.toLowerCase()]
  ) {
    console.error(' - PAYMENT_SOURCE_TOKEN_ADDRESS must have an explicit amount limit in PRIVY_BASE_TOKEN_LIMITS');
    process.exit(1);
  }
}

if (parsed.data.PRIVY_AUTHORIZATION_PRIVATE_KEY) {
  try {
    const encoded = parsed.data.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid base64');
    const key = createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('not a P-256 key');
    }
  } catch {
    console.error(' - PRIVY_AUTHORIZATION_PRIVATE_KEY must be a base64-encoded PKCS#8 P-256 private key');
    process.exit(1);
  }
}

export const config = parsed.data;
