import { Budget } from '../models/Budget.js';

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
