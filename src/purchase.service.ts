import mongoose, { Types } from 'mongoose';
import { Budget } from './models/Budget.js';
import { Purchase, type IPurchase } from './purchase.model.js';

export interface PurchaseBudgetSummary {
  totalLimit: number;
  spent: number;
  reserved: number;
  remaining: number;
  utilization: number;
}

export function computeBudgetState(totalLimit: number, spent: number, reserved: number): PurchaseBudgetSummary {
  const total = Number(totalLimit ?? 0);
  const used = Number(spent ?? 0);
  const held = Number(reserved ?? 0);
  const remaining = Math.max(total - used - held, 0);
  return {
    totalLimit: total,
    spent: used,
    reserved: held,
    remaining,
    utilization: total === 0 ? 0 : ((used + held) / total) * 100,
  };
}

export async function getBudgetSummary(userId: string, budgetId: string): Promise<PurchaseBudgetSummary> {
  const budget = await Budget.findOne({ _id: budgetId, userId, active: true }).lean();
  if (!budget) {
    throw Object.assign(new Error('Budget not found or inactive'), { code: 'BUDGET_NOT_FOUND', statusCode: 404 });
  }
  return computeBudgetState(Number(budget.totalLimit ?? 0), Number(budget.spent ?? 0), Number(budget.reserved ?? 0));
}

export async function listPurchasesForUser(userId: string): Promise<IPurchase[]> {
  return Purchase.find({ userId }).sort({ createdAt: -1 }).lean() as unknown as Promise<IPurchase[]>;
}

export async function getPurchaseForUser(userId: string, purchaseId: string): Promise<IPurchase | null> {
  return Purchase.findOne({ _id: purchaseId, userId }) as unknown as Promise<IPurchase | null>;
}

export async function createPurchaseForUser(userId: string, input: {
  budgetId: string;
  title: string;
  description: string;
  category?: string;
  vendorName?: string;
  quantity?: number;
  unitPrice?: number;
  currency?: string;
  amount?: number;
  justification?: string;
}): Promise<IPurchase> {
  const budget = await Budget.findOne({ _id: input.budgetId, userId, active: true });
  if (!budget) {
    throw Object.assign(new Error('Budget not found or inactive'), { code: 'BUDGET_NOT_FOUND', statusCode: 404 });
  }

  const amount = typeof input.amount === 'number' ? input.amount : (Number(input.unitPrice ?? 0) * Number(input.quantity ?? 1));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Purchase amount must be a positive number'), { code: 'INVALID_PURCHASE_AMOUNT', statusCode: 400 });
  }

  const summary = await getBudgetSummary(userId, input.budgetId);
  if (amount > summary.remaining) {
    throw Object.assign(new Error('Purchase exceeds remaining budget'), { code: 'BUDGET_EXCEEDED', statusCode: 402 });
  }

  const purchase = await Purchase.create({
    userId,
    budgetId: input.budgetId,
    title: input.title,
    description: input.description,
    category: input.category,
    vendorName: input.vendorName,
    quantity: Number(input.quantity ?? 1),
    unitPrice: Number(input.unitPrice ?? amount / (Number(input.quantity ?? 1) || 1)),
    currency: input.currency ?? budget.currency,
    amount,
    justification: input.justification,
    status: 'draft',
    activity: [{ type: 'created', message: 'Purchase draft created', createdAt: new Date() }],
  });

  return purchase;
}

export async function submitPurchaseForUser(userId: string, purchaseId: string): Promise<IPurchase | null> {
  const purchase = await Purchase.findOne({ _id: purchaseId, userId });
  if (!purchase) return null;
  if (purchase.status === 'submitted') {
    return purchase;
  }
  purchase.status = 'submitted';
  purchase.activity.push({ type: 'submitted', message: 'Purchase submitted for review', createdAt: new Date() });
  await purchase.save();
  return purchase;
}

export async function approvePurchaseForUser(userId: string, purchaseId: string): Promise<IPurchase | null> {
  const purchase = await Purchase.findOne({ _id: purchaseId, userId });
  if (!purchase) return null;
  if (purchase.status !== 'submitted') {
    throw Object.assign(new Error('Only submitted purchases can be approved'), { code: 'PURCHASE_NOT_SUBMITTED', statusCode: 409 });
  }
  purchase.status = 'approved';
  purchase.approvedBy = new Types.ObjectId(userId);
  purchase.activity.push({ type: 'approved', message: 'Purchase approved', createdAt: new Date() });
  await purchase.save();
  return purchase;
}

export async function rejectPurchaseForUser(userId: string, purchaseId: string, reason?: string): Promise<IPurchase | null> {
  const purchase = await Purchase.findOne({ _id: purchaseId, userId });
  if (!purchase) return null;
  purchase.status = 'rejected';
  purchase.activity.push({ type: 'rejected', message: reason ?? 'Purchase rejected by reviewer', createdAt: new Date() });
  await purchase.save();
  return purchase;
}

export async function cancelPurchaseForUser(userId: string, purchaseId: string): Promise<IPurchase | null> {
  const purchase = await Purchase.findOne({ _id: purchaseId, userId });
  if (!purchase) return null;
  if (['paid', 'fulfilled'].includes(purchase.status)) {
    throw Object.assign(new Error('A fulfilled or paid purchase cannot be cancelled'), { code: 'PURCHASE_NOT_CANCELLABLE', statusCode: 409 });
  }
  purchase.status = 'cancelled';
  purchase.activity.push({ type: 'cancelled', message: 'Purchase cancelled', createdAt: new Date() });
  await purchase.save();
  return purchase;
}

export async function getPurchaseAnalytics(userId: string): Promise<{
  totalPurchases: number;
  byStatus: Record<string, number>;
  averageAmount: number;
  totalAmount: number;
}> {
  const purchases = await Purchase.find({ userId }).lean();
  const byStatus = purchases.reduce<Record<string, number>>((acc, value) => {
    acc[value.status] = (acc[value.status] ?? 0) + 1;
    return acc;
  }, {});
  const totalAmount = purchases.reduce((sum, value) => sum + Number(value.amount ?? 0), 0);
  return {
    totalPurchases: purchases.length,
    byStatus,
    averageAmount: purchases.length === 0 ? 0 : totalAmount / purchases.length,
    totalAmount,
  };
}

export async function listPurchaseActivity(userId: string, purchaseId: string): Promise<IPurchase['activity']> {
  const purchase = await Purchase.findOne({ _id: purchaseId, userId }).select('activity').lean();
  if (!purchase) {
    throw Object.assign(new Error('Purchase not found'), { code: 'PURCHASE_NOT_FOUND', statusCode: 404 });
  }
  return purchase.activity ?? [];
}
