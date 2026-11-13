import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Quote } from '../models/Quote.js';
import { prepareQuotePayment } from './payments.js';

const router = Router();
router.use(authMiddleware);

router.post('/:quoteId/prepare-payment', prepareQuotePayment);

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

router.post('/:id/approve', (_req, res) => {
  res.status(409).json({
    error: 'PAYMENT_PREPARATION_REQUIRED',
    message: 'Prepare and review a payment before explicitly confirming it.',
  });
});

/**
 * POST /api/quotes/:id/reject
 * User manually rejects a quote.
 */
router.post('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body as { reason?: string };

    const quote = await Quote.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.userId,
        status: 'pending',
        activePaymentAttemptId: null,
      },
      { status: 'rejected', rejectionReason: reason ?? 'Rejected by user' },
      { new: true },
    );
    if (!quote) {
      const existing = await Quote.findOne({ _id: req.params.id, userId: req.userId }).select('activePaymentAttemptId');
      if (existing?.activePaymentAttemptId) {
        res.status(409).json({ error: 'PAYMENT_ATTEMPT_ACTIVE', message: 'A prepared payment must expire before this quote can be rejected.' });
        return;
      }
      res.status(404).json({ error: 'Quote not found or not in pending state' });
      return;
    }
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

export default router;
