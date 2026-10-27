import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Transaction } from '../models/Transaction.js';

const router = Router();
router.use(authMiddleware);

/** GET /api/transactions — list all transactions for the user */
router.get('/', async (req, res, next) => {
  try {
    const txs = await Transaction.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .populate('quoteId', 'provider description price currency sourceUrl status')
      .lean();
    res.json(txs);
  } catch (err) {
    next(err);
  }
});

/** GET /api/transactions/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const tx = await Transaction.findOne({ _id: req.params.id, userId: req.userId })
      .populate('quoteId')
      .lean();
    if (!tx) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    res.json(tx);
  } catch (err) {
    next(err);
  }
});

export default router;
