import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Budget } from '../models/Budget.js';

const router = Router();
router.use(authMiddleware);

/** GET /api/budgets — list all budgets for the user */
router.get('/', async (req, res, next) => {
  try {
    const budgets = await Budget.find({ userId: req.userId }).sort({ createdAt: -1 }).lean();
    res.json(budgets);
  } catch (err) {
    next(err);
  }
});

/** POST /api/budgets — create a budget */
router.post('/', async (req, res, next) => {
  try {
    const { label, totalLimit, currency, approvedRecipients } = req.body as {
      label?: string;
      totalLimit?: number;
      currency?: string;
      approvedRecipients?: string[];
    };

    if (!label || label.trim().length === 0) {
      res.status(400).json({ error: 'label is required' });
      return;
    }
    if (typeof totalLimit !== 'number' || totalLimit <= 0) {
      res.status(400).json({ error: 'totalLimit must be a positive number' });
      return;
    }

    const budget = await Budget.create({
      userId: req.userId,
      label: label.trim(),
      totalLimit,
      currency: currency ?? 'USD',
      approvedRecipients: approvedRecipients ?? [],
    });
    res.status(201).json(budget);
  } catch (err) {
    next(err);
  }
});

/** GET /api/budgets/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const budget = await Budget.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!budget) {
      res.status(404).json({ error: 'Budget not found' });
      return;
    }
    res.json(budget);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/budgets/:id — update label, limit, recipients, or active state */
router.patch('/:id', async (req, res, next) => {
  try {
    const { label, totalLimit, approvedRecipients, active } = req.body as {
      label?: string;
      totalLimit?: number;
      approvedRecipients?: string[];
      active?: boolean;
    };

    const update: Record<string, unknown> = {};
    if (label !== undefined) update.label = label.trim();
    if (totalLimit !== undefined) update.totalLimit = totalLimit;
    if (approvedRecipients !== undefined) update.approvedRecipients = approvedRecipients;
    if (active !== undefined) update.active = active;

    const budget = await Budget.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: update },
      { new: true, runValidators: true },
    );
    if (!budget) {
      res.status(404).json({ error: 'Budget not found' });
      return;
    }
    res.json(budget);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/budgets/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    const budget = await Budget.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!budget) {
      res.status(404).json({ error: 'Budget not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
