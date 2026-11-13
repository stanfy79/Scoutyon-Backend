import { z } from 'zod';
import 'dotenv/config';

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
}

export const config = parsed.data;
