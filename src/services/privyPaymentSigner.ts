import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyQuorum, Policy } from '@privy-io/node';
import { config } from '../config.js';
import { getPrivyClient } from './privy.js';
import { assertWalletBelongsToUser, type PrivyWalletRecord } from './privyWalletOwnership.js';

const transferAbi = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

export interface PaymentSignerSettings {
  appId: string;
  signerId: string;
  policyId: string;
  privateKey: string;
  publicKey: string;
  baseTokenLimits: Record<string, string>;
}

export interface SignerVerification {
  walletId: string;
  walletAddress: string;
  signerId: string;
  policyId: string;
  authorized: true;
  verifiedAt: Date;
}

export interface WalletSignerStatus {
  authorized: boolean;
  status: string;
  message: string;
  walletId: string;
  walletAddress: string;
  signerId: string;
  policyId: string;
  verifiedAt: Date;
}

export interface PrivySignerDependencies {
  walletLookup: (walletId: string) => Promise<PrivyWalletRecord & {
    additional_signers?: Array<{ signer_id: string; override_policy_ids?: string[] }>;
  }>;
  keyQuorumLookup: (signerId: string) => Promise<KeyQuorum>;
  policyLookup: (policyId: string) => Promise<Policy>;
}

function failure(message: string, code: string, statusCode = 503): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function normalizePublicKey(value: string): string {
  return value.replace(/\s+/g, '');
}

export function getPaymentSignerSettings(options: { requirePolicyId?: boolean } = {}): PaymentSignerSettings {
  const requirePolicyId = options.requirePolicyId !== false;
  const missing = [
    !config.PRIVY_APP_ID && 'PRIVY_APP_ID',
    !config.PRIVY_KEY_QUORUM_ID && 'PRIVY_KEY_QUORUM_ID',
    requirePolicyId && !config.PRIVY_TRANSFER_POLICY_ID && 'PRIVY_TRANSFER_POLICY_ID',
    !config.PRIVY_AUTHORIZATION_PRIVATE_KEY && 'PRIVY_AUTHORIZATION_PRIVATE_KEY',
    Object.keys(config.PRIVY_BASE_TOKEN_LIMITS).length === 0 && 'PRIVY_BASE_TOKEN_LIMITS',
  ].filter((field): field is string => Boolean(field));
  if (missing.length) {
    throw failure(
      `Payment signer configuration is incomplete: ${missing.join(', ')}. Register a P-256 authorization key as a key quorum and create a restrictive Base ERC-20 transfer policy in the Privy Dashboard.`,
      'SIGNER_CONFIGURATION_MISSING',
    );
  }

  const privateKey = config.PRIVY_AUTHORIZATION_PRIVATE_KEY!;
  try {
    const keyObject = createPrivateKey({
      key: Buffer.from(privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    if (keyObject.asymmetricKeyType !== 'ec' || keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Configured private key is not P-256');
    }
    const publicKey = createPublicKey(keyObject).export({ format: 'der', type: 'spki' }).toString('base64');
    return {
      appId: config.PRIVY_APP_ID,
      signerId: config.PRIVY_KEY_QUORUM_ID!,
      policyId: config.PRIVY_TRANSFER_POLICY_ID ?? '',
      privateKey,
      publicKey,
      baseTokenLimits: config.PRIVY_BASE_TOKEN_LIMITS,
    };
  } catch {
    throw failure(
      'PRIVY_AUTHORIZATION_PRIVATE_KEY must be the base64-encoded PKCS#8 P-256 private key matching the public key registered in the configured Privy key quorum.',
      'SIGNER_CONFIGURATION_MISSING',
    );
  }
}

export function assertAllowedBasePaymentTransaction(
  chainId: number,
  tokenAddress: string,
  amountAtomic: string,
): void {
  const settings = getPaymentSignerSettings();
  const limit = settings.baseTokenLimits[tokenAddress.toLowerCase()];
  if (chainId !== 8453 || !limit) {
    throw failure(
      'Scoutyon payment authorization is restricted to Base (chain ID 8453) and verified token contracts in PRIVY_BASE_TOKEN_LIMITS.',
      'SIGNER_POLICY_REJECTED',
      403,
    );
  }
  if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) > BigInt(limit)) {
    throw failure(
      'This transfer exceeds the configured per-token atomic spending limit.',
      'SIGNER_POLICY_REJECTED',
      403,
    );
  }
}

export function assertPaymentSignerKeyQuorum(
  quorum: KeyQuorum,
  settings: Pick<PaymentSignerSettings, 'signerId' | 'publicKey'>,
): void {
  if (
    quorum.id !== settings.signerId ||
    quorum.authorization_threshold !== 1 ||
    !quorum.authorization_keys.some((key) => normalizePublicKey(key.public_key) === settings.publicKey)
  ) {
    throw failure(
      'The backend P-256 private key does not match a key in the configured 1-of-1 Privy key quorum. Register its matching public key and correct PRIVY_KEY_QUORUM_ID.',
      'PRIVY_AUTHORIZATION_FAILED',
    );
  }
}

function fieldCondition(
  conditions: unknown[],
  source: string,
  field: string,
): Record<string, unknown> | undefined {
  return conditions.find((condition): condition is Record<string, unknown> =>
    typeof condition === 'object' &&
    condition !== null &&
    (condition as Record<string, unknown>).field_source === source &&
    (condition as Record<string, unknown>).field === field,
  );
}

function conditionEquals(condition: Record<string, unknown> | undefined, operator: string, value: string): boolean {
  return condition?.operator === operator &&
    typeof condition.value === 'string' &&
    condition.value.toLowerCase() === value.toLowerCase();
}

function hasExpectedTransferAbi(condition: Record<string, unknown> | undefined): boolean {
  if (!Array.isArray(condition?.abi)) return false;
  return condition.abi.some((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const abiItem = item as { type?: string; name?: string; inputs?: Array<{ name?: string; type?: string }> };
    return abiItem.type === 'function' &&
      abiItem.name === 'transfer' &&
      abiItem.inputs?.length === 2 &&
      abiItem.inputs[0].type === 'address' &&
      abiItem.inputs[1].name === 'amount' &&
      abiItem.inputs[1].type === 'uint256';
  });
}

function amountConditionMatches(
  condition: Record<string, unknown> | undefined,
  maximum: string,
): boolean {
  if (
    condition?.operator !== 'lte' ||
    typeof condition.value !== 'string' ||
    !Array.isArray(condition.abi)
  ) return false;
  let configured: bigint;
  let policyAmount: bigint;
  try {
    configured = BigInt(maximum);
    policyAmount = BigInt(condition.value);
  } catch {
    return false;
  }
  if (policyAmount !== configured) return false;
  return hasExpectedTransferAbi(condition);
}

export function assertPaymentPolicyIsRestrictive(
  policy: Policy,
  settings: Pick<PaymentSignerSettings, 'signerId' | 'policyId' | 'baseTokenLimits'>,
): void {
  if (policy.id !== settings.policyId || policy.chain_type !== 'ethereum' || policy.owner_id !== settings.signerId) {
    throw failure(
      'The configured Privy payment policy must belong to the configured key quorum and use the Ethereum chain type.',
      'SIGNER_POLICY_REJECTED',
      403,
    );
  }
  const allowedRules = policy.rules.filter((rule) => rule.action === 'ALLOW');
  if (allowedRules.length !== Object.keys(settings.baseTokenLimits).length) {
    throw failure(
      'The Privy payment policy has missing or extra ALLOW rules. Recreate it with only the configured Base token contract allowlist and amount limits.',
      'SIGNER_POLICY_REJECTED',
      403,
    );
  }

  const validatedTokens = new Set<string>();
  for (const rule of allowedRules) {
    const conditions = rule.conditions as unknown[];
    const chain = fieldCondition(conditions, 'ethereum_transaction', 'chain_id');
    const token = fieldCondition(conditions, 'ethereum_transaction', 'to');
    const value = fieldCondition(conditions, 'ethereum_transaction', 'value');
    const functionName = fieldCondition(conditions, 'ethereum_calldata', 'function_name');
    const amount = fieldCondition(conditions, 'ethereum_calldata', 'transfer.amount');
    const tokenAddress = typeof token?.value === 'string' ? token.value.toLowerCase() : '';
    const tokenLimit = settings.baseTokenLimits[tokenAddress];

    if (
      rule.method !== 'eth_sendTransaction' ||
      conditions.length !== 5 ||
      !conditionEquals(chain, 'eq', '8453') ||
      !conditionEquals(value, 'eq', '0x0') ||
      !tokenLimit ||
      !conditionEquals(token, 'eq', tokenAddress) ||
      !conditionEquals(functionName, 'eq', 'transfer') ||
      !hasExpectedTransferAbi(functionName) ||
      !amountConditionMatches(amount, tokenLimit)
    ) {
      throw failure(
        'The Privy payment policy does not exactly restrict execution to Base ERC-20 transfer calls, verified token contracts, zero native value, and configured atomic amount caps.',
        'SIGNER_POLICY_REJECTED',
        403,
      );
    }
    validatedTokens.add(tokenAddress);
  }

  if (validatedTokens.size !== Object.keys(settings.baseTokenLimits).length) {
    throw failure('The Privy payment policy is missing a configured token contract.', 'SIGNER_POLICY_REJECTED', 403);
  }
}

export function createBasePaymentPolicyParams(settings: PaymentSignerSettings) {
  return {
    chain_type: 'ethereum' as const,
    name: 'Scoutyon Base ERC-20 payment signer',
    owner_id: settings.signerId,
    version: '1.0' as const,
    rules: Object.entries(settings.baseTokenLimits).map(([tokenAddress, maxAmount]) => ({
      name: `ERC-20 transfer ${tokenAddress.slice(0, 10)}`,
      method: 'eth_sendTransaction' as const,
      action: 'ALLOW' as const,
      conditions: [
        { field_source: 'ethereum_transaction' as const, field: 'chain_id' as const, operator: 'eq' as const, value: '8453' },
        { field_source: 'ethereum_transaction' as const, field: 'to' as const, operator: 'eq' as const, value: tokenAddress },
        { field_source: 'ethereum_transaction' as const, field: 'value' as const, operator: 'eq' as const, value: '0x0' },
        {
          field_source: 'ethereum_calldata' as const,
          field: 'function_name',
          abi: transferAbi,
          operator: 'eq' as const,
          value: 'transfer',
        },
        {
          field_source: 'ethereum_calldata' as const,
          field: 'transfer.amount',
          abi: transferAbi,
          operator: 'lte' as const,
          value: `0x${BigInt(maxAmount).toString(16)}`,
        },
      ],
    })),
  };
}

export function defaultPrivySignerDependencies(): PrivySignerDependencies {
  return {
    walletLookup: async (walletId) => await getPrivyClient().wallets().get(walletId),
    keyQuorumLookup: async (signerId) => await getPrivyClient().keyQuorums().get(signerId),
    policyLookup: async (policyId) => await getPrivyClient().policies().get(policyId),
  };
}

export async function assertSignerInfrastructure(
  dependencies = defaultPrivySignerDependencies(),
): Promise<PaymentSignerSettings> {
  const settings = getPaymentSignerSettings();
  let quorum: KeyQuorum;
  try {
    quorum = await dependencies.keyQuorumLookup(settings.signerId);
  } catch (error) {
    const status = (error as { status?: number; statusCode?: number }).status ??
      (error as { statusCode?: number }).statusCode;
    if (status === 404) {
      throw failure(
        `Key quorum ${settings.signerId} is not registered in Privy App ${settings.appId}. Register the backend P-256 public key in Privy Dashboard > Authorization keys and update PRIVY_KEY_QUORUM_ID.`,
        'SIGNER_CONFIGURATION_MISSING',
      );
    }
    throw failure('Privy could not verify the configured authorization key quorum.', 'PRIVY_AUTHORIZATION_FAILED');
  }
  assertPaymentSignerKeyQuorum(quorum, settings);

  let policy: Policy;
  try {
    policy = await dependencies.policyLookup(settings.policyId);
  } catch (error) {
    const status = (error as { status?: number; statusCode?: number }).status ??
      (error as { statusCode?: number }).statusCode;
    if (status === 404) {
      throw failure(
        `Transfer policy ${settings.policyId} is not registered in Privy App ${settings.appId}. Create the restrictive Scoutyon Base ERC-20 policy and set PRIVY_TRANSFER_POLICY_ID.`,
        'SIGNER_POLICY_REJECTED',
      );
    }
    throw failure('Privy could not verify the configured payment policy.', 'PRIVY_AUTHORIZATION_FAILED');
  }
  assertPaymentPolicyIsRestrictive(policy, settings);
  return settings;
}

export async function getPaymentSignerStatus(input: {
  privyUserId: string;
  walletId: string;
  walletAddress: string;
  dependencies?: Partial<PrivySignerDependencies>;
}): Promise<WalletSignerStatus> {
  const defaults = defaultPrivySignerDependencies();
  const dependencies: PrivySignerDependencies = {
    walletLookup: input.dependencies?.walletLookup ?? defaults.walletLookup,
    keyQuorumLookup: input.dependencies?.keyQuorumLookup ?? defaults.keyQuorumLookup,
    policyLookup: input.dependencies?.policyLookup ?? defaults.policyLookup,
  };
  const settings = await assertSignerInfrastructure(dependencies);
  let wallet: Awaited<ReturnType<PrivySignerDependencies['walletLookup']>>;
  try {
    wallet = await dependencies.walletLookup(input.walletId);
  } catch (error) {
    const status = (error as { status?: number; statusCode?: number }).status ??
      (error as { statusCode?: number }).statusCode;
    if (status === 404) {
      throw failure('The configured Privy wallet does not exist in this Privy application.', 'PRIVY_WALLET_NOT_FOUND', 404);
    }
    if (status === 401) {
      throw failure('Privy rejected the configured application credentials.', 'PRIVY_AUTHORIZATION_FAILED');
    }
    throw failure('Privy could not verify the authenticated user wallet.', 'PRIVY_AUTHORIZATION_FAILED');
  }
  assertWalletBelongsToUser(wallet, input.walletId, input.privyUserId, input.walletAddress);
  const signer = inspectWalletSigner(wallet, settings);
  return {
    authorized: signer.authorized,
    status: signer.code ?? 'AUTHORIZED',
    message: signer.message,
    walletId: wallet.id,
    walletAddress: wallet.address,
    signerId: settings.signerId,
    policyId: settings.policyId,
    verifiedAt: new Date(),
  };
}

export function inspectWalletSigner(
  wallet: PrivyWalletRecord & {
    additional_signers?: Array<{ signer_id: string; override_policy_ids?: string[] }>;
  },
  settings: Pick<PaymentSignerSettings, 'signerId' | 'policyId'>,
): { authorized: boolean; code: string | null; message: string } {
  const signers = wallet.additional_signers ?? [];
  if (signers.length === 0) {
    return {
      authorized: false,
      code: 'WALLET_NOT_DELEGATED',
      message: 'Enable Scoutyon Payment Authorization in the wallet interface; the wallet owner must explicitly approve the configured signer and policy.',
    };
  }
  const signer = signers.find((item) => item.signer_id === settings.signerId);
  if (!signer) {
    return {
      authorized: false,
      code: 'SIGNER_NOT_REGISTERED',
      message: 'The configured key quorum is not registered on this wallet. Use Enable Scoutyon Payment Authorization for this wallet.',
    };
  }
  if (!signer.override_policy_ids?.includes(settings.policyId)) {
    return {
      authorized: false,
      code: 'SIGNER_POLICY_REJECTED',
      message: 'The Scoutyon signer is present but is not restricted by the configured transfer policy. Reauthorize it with the configured policy.',
    };
  }
  return { authorized: true, code: null, message: 'Scoutyon payment signer and policy are active on this wallet.' };
}

export function signerVerification(
  wallet: PrivyWalletRecord,
  settings: Pick<PaymentSignerSettings, 'signerId' | 'policyId'>,
): SignerVerification {
  return {
    walletId: wallet.id,
    walletAddress: wallet.address,
    signerId: settings.signerId,
    policyId: settings.policyId,
    authorized: true,
    verifiedAt: new Date(),
  };
}

export function throwSignerStatus(status: ReturnType<typeof inspectWalletSigner>): never {
  if (status.authorized || !status.code) throw new Error('Unexpected authorized signer state');
  throw failure(status.message, status.code, 403);
}
