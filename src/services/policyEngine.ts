import { Budget } from '../models/Budget.js';
import type { NearIntentToken } from './nearIntents.js';

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export async function checkPolicy(opts: {
  userId: string;
  budgetId: string;
  amount: number;
  currency: string;
  provider: string;
}): Promise<PolicyResult> {
  const budget = await Budget.findOne({
    _id: opts.budgetId,
    userId: opts.userId,
    active: true,
  });

  if (!budget) {
    return { allowed: false, reason: 'Budget not found or inactive' };
  }

  if (budget.currency !== opts.currency.toUpperCase()) {
    return {
      allowed: false,
      reason: `Budget is in ${budget.currency} but the quote is in ${opts.currency.toUpperCase()}`,
    };
  }

  const remaining = budget.totalLimit - budget.spent;

  if (opts.amount > remaining) {
    return {
      allowed: false,
      reason: `Amount ${opts.currency} ${opts.amount.toFixed(2)} exceeds remaining budget of ${budget.currency} ${remaining.toFixed(2)}`,
    };
  }

  if (
    budget.approvedRecipients.length > 0 &&
    !budget.approvedRecipients.map((r) => r.toLowerCase()).includes(opts.provider.toLowerCase())
  ) {
    return {
      allowed: false,
      reason: `Provider "${opts.provider}" is not on the approved recipients list for this budget`,
    };
  }

  return { allowed: true };
}

export async function deductBudget(opts: {
  budgetId: string;
  userId: string;
  amount: number;
}): Promise<void> {
  await Budget.findOneAndUpdate(
    { _id: opts.budgetId, userId: opts.userId, active: true },
    { $inc: { spent: opts.amount } },
  );
}

function scaledMicros(value: string, rounding: 'up' | 'down'): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match) throw new Error('Unsupported budget precision');
  const fraction = match[2] ?? '';
  const kept = fraction.slice(0, 6).padEnd(6, '0');
  const hasRemainder = /[1-9]/.test(fraction.slice(6));
  const valueMicros = BigInt(match[1]) * 1_000_000n + BigInt(kept || '0');
  return rounding === 'up' && hasRemainder ? valueMicros + 1n : valueMicros;
}

function asDecimalParts(value: string): { digits: bigint; decimals: number } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid token price');
  const fraction = match[2] ?? '';
  return { digits: BigInt(`${match[1]}${fraction}`), decimals: fraction.length };
}

export async function checkPaymentPolicy(opts: {
  userId: string;
  budgetId: string;
  providerId: string;
  providerName: string;
  sourceAmountMax: string;
  sourceToken: NearIntentToken;
}): Promise<{ allowed: boolean; reason?: string; budgetDebitMicros?: string }> {
  const budget = await Budget.findOne({
    _id: opts.budgetId,
    userId: opts.userId,
    active: true,
  }).lean();
  if (!budget) return { allowed: false, reason: 'Budget not found or inactive' };

  if (budget.currency.toUpperCase() !== 'USD') {
    return { allowed: false, reason: 'Live payments currently require a USD-denominated budget' };
  }
  if (budget.approvedRecipients.length > 0) {
    const approved = budget.approvedRecipients.map((recipient) => recipient.toLowerCase());
    if (!approved.includes(opts.providerId.toLowerCase()) && !approved.includes(opts.providerName.toLowerCase())) {
      return { allowed: false, reason: `Provider "${opts.providerName}" is not approved by this budget` };
    }
  }
  if (
    !opts.sourceToken.price ||
    !opts.sourceToken.priceUpdatedAt ||
    !Number.isFinite(Date.parse(opts.sourceToken.priceUpdatedAt)) ||
    Date.now() - Date.parse(opts.sourceToken.priceUpdatedAt) > 5 * 60 * 1000 ||
    Date.parse(opts.sourceToken.priceUpdatedAt) > Date.now() + 60_000
  ) {
    return { allowed: false, reason: 'A current trusted source-token price is unavailable' };
  }

  let debitMicros: bigint;
  try {
    const price = asDecimalParts(opts.sourceToken.price);
    if (price.digits <= 0n) throw new Error('Invalid token price');
    const amount = BigInt(opts.sourceAmountMax);
    const numerator = amount * price.digits * 1_000_000n;
    const denominator = 10n ** BigInt(opts.sourceToken.decimals + price.decimals);
    debitMicros = (numerator + denominator - 1n) / denominator;
  } catch {
    return { allowed: false, reason: 'Source-token price or amount is invalid' };
  }

  let remainingMicros: bigint;
  try {
    remainingMicros =
      scaledMicros(String(budget.totalLimit), 'down') -
      scaledMicros(String(budget.spent), 'up') -
      scaledMicros(String(budget.reserved ?? 0), 'up');
  } catch {
    return { allowed: false, reason: 'Budget precision is unsupported for live payments' };
  }
  if (debitMicros > remainingMicros) {
    return { allowed: false, reason: 'Maximum payment input exceeds the remaining budget' };
  }
  return { allowed: true, budgetDebitMicros: debitMicros.toString() };
}

function microsAsBudgetAmount(amountMicros: string): number {
  const amount = BigInt(amountMicros);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0');
  const value = Number(`${whole}.${fraction}`);
  if (!Number.isFinite(value)) throw new Error('Payment budget amount is out of range');
  return value;
}

export async function reservePaymentBudget(opts: {
  userId: string;
  budgetId: string;
  amountMicros: string;
}): Promise<void> {
  const amount = microsAsBudgetAmount(opts.amountMicros);
  const result = await Budget.updateOne(
    {
      _id: opts.budgetId,
      userId: opts.userId,
      active: true,
      $expr: {
        $gte: [
          { $subtract: ['$totalLimit', { $add: ['$spent', { $ifNull: ['$reserved', 0] }] }] },
          amount,
        ],
      },
    },
    { $inc: { reserved: amount } },
  );
  if (result.modifiedCount !== 1) {
    throw Object.assign(new Error('Payment exceeds the remaining budget'), {
      code: 'BUDGET_EXCEEDED',
      statusCode: 402,
    });
  }
}

export async function settlePaymentBudget(opts: {
  userId: string;
  budgetId: string;
  amountMicros: string;
  reservedMicros: string;
}): Promise<void> {
  const amount = microsAsBudgetAmount(opts.amountMicros);
  const reserved = microsAsBudgetAmount(opts.reservedMicros);
  const result = await Budget.updateOne(
    {
      _id: opts.budgetId,
      userId: opts.userId,
      active: true,
      reserved: { $gte: reserved },
    },
    { $inc: { reserved: -reserved, spent: amount } },
  );
  if (result.modifiedCount !== 1) {
    throw new Error('Payment budget reservation could not be settled; manual reconciliation is required');
  }
}

export async function releasePaymentBudget(opts: {
  userId: string;
  budgetId: string;
  amountMicros: string;
}): Promise<void> {
  const amount = microsAsBudgetAmount(opts.amountMicros);
  await Budget.updateOne(
    { _id: opts.budgetId, userId: opts.userId, reserved: { $gte: amount } },
    { $inc: { reserved: -amount } },
  );
}
