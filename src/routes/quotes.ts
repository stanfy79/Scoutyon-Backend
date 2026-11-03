import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Quote } from '../models/Quote.js';
import { Transaction } from '../models/Transaction.js';
import { checkPolicy, deductBudget } from '../services/policyEngine.js';
import { executePayment } from '../services/nearIntents.js';

const router = Router();
router.use(authMiddleware);

/** GET /api/quotes — list quotes, optionally filtered by ?sessionId=... */
router.get('/', async (req, res, next) => {
  try {
    const filter: Record<string, unknown> = { userId: req.userId };
    if (req.query.sessionId) filter.sessionId = req.query.sessionId;

    const quotes = await Quote.find(filter).sort({ createdAt: -1 }).lean();
    res.json(quotes);
  } catch (err) {
    next(err);
  }
});

/** GET /api/quotes/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/quotes/:id/approve
 * User approves a quote. The backend runs policy enforcement, then
 * executes the payment (simulated in MVP) and records a Transaction.
 */
router.post('/:id/approve', async (req, res, next) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, userId: req.userId });
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    if (quote.status !== 'pending') {
      res.status(409).json({ error: `Quote is already ${quote.status}` });
      return;
    }

    // Policy check (only if a budget is linked)
    if (quote.budgetId) {
      const policy = await checkPolicy({
        userId: req.userId!,
        budgetId: quote.budgetId.toString(),
        amount: quote.price,
        currency: quote.currency,
        provider: quote.provider,
      });

      if (!policy.allowed) {
        await Quote.findByIdAndUpdate(quote._id, {
          status: 'rejected',
          rejectionReason: policy.reason,
        });
        res.status(402).json({
          error: 'Policy rejected this purchase',
          reason: policy.reason,
        });
        return;
      }
    }

    // Mark approved
    await Quote.findByIdAndUpdate(quote._id, { status: 'approved' });

    // Execute payment (simulated in MVP)
    const payment = await executePayment({
      provider: quote.provider,
      amount: quote.price,
      currency: quote.currency,
      description: quote.description,
    });

    // Record transaction
    const tx = await Transaction.create({
      quoteId: quote._id,
      userId: req.userId,
      provider: quote.provider,
      amount: quote.price,
      currency: quote.currency,
      nearIntentId: payment.intentId,
      txHash: payment.txHash,
      status: payment.status,
      simulated: payment.simulated,
      metadata: { message: payment.message },
    });

    // Deduct from budget ledger
    if (quote.budgetId) {
      await deductBudget({
        budgetId: quote.budgetId.toString(),
        userId: req.userId!,
        amount: quote.price,
      });
    }

    // Mark as paid
    await Quote.findByIdAndUpdate(quote._id, { status: 'paid' });

    res.json({
      success: true,
      simulated: payment.simulated,
      message: payment.message,
      transaction: {
        id: tx._id.toString(),
        nearIntentId: tx.nearIntentId,
        status: tx.status,
        amount: tx.amount,
        currency: tx.currency,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/quotes/:id/reject
 * User manually rejects a quote.
 */
router.post('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body as { reason?: string };

    const quote = await Quote.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId, status: 'pending' },
      { status: 'rejected', rejectionReason: reason ?? 'Rejected by user' },
      { new: true },
    );
    if (!quote) {
      res.status(404).json({ error: 'Quote not found or not in pending state' });
      return;
    }
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

export default router;
