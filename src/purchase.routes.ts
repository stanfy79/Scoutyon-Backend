import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from './middleware/auth.js';
import {
  approvePurchaseForUser,
  cancelPurchaseForUser,
  createPurchaseForUser,
  getBudgetSummary,
  getPurchaseAnalytics,
  getPurchaseForUser,
  listPurchaseActivity,
  listPurchasesForUser,
  rejectPurchaseForUser,
  submitPurchaseForUser,
} from './purchase.service.js';

const router = Router();
router.use(authMiddleware);

const purchaseCreateSchema = z.object({
  budgetId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().optional(),
  vendorName: z.string().optional(),
  quantity: z.number().nonnegative().optional(),
  unitPrice: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  justification: z.string().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const purchases = await listPurchasesForUser(req.userId!);
    res.json({ success: true, purchases });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const payload = purchaseCreateSchema.parse(req.body);
    const purchase = await createPurchaseForUser(req.userId!, payload);
    res.status(201).json({ success: true, purchase });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics', async (req, res, next) => {
  try {
    const analytics = await getPurchaseAnalytics(req.userId!);
    res.json({ success: true, analytics });
  } catch (error) {
    next(error);
  }
});

router.get('/:purchaseId', async (req, res, next) => {
  try {
    const purchase = await getPurchaseForUser(req.userId!, req.params.purchaseId);
    if (!purchase) {
      res.status(404).json({ error: 'Purchase not found' });
      return;
    }
    res.json({ success: true, purchase });
  } catch (error) {
    next(error);
  }
});

router.patch('/:purchaseId', async (req, res, next) => {
  try {
    const purchase = await getPurchaseForUser(req.userId!, req.params.purchaseId);
    if (!purchase) {
      res.status(404).json({ error: 'Purchase not found' });
      return;
    }
    const update = req.body as Record<string, unknown>;
    if (update.title !== undefined) purchase.title = String(update.title);
    if (update.description !== undefined) purchase.description = String(update.description);
    if (update.vendorName !== undefined) purchase.vendorName = String(update.vendorName);
    if (update.justification !== undefined) purchase.justification = String(update.justification);
    if (update.category !== undefined) purchase.category = String(update.category);
    if (update.amount !== undefined) purchase.amount = Number(update.amount);
    if (update.currency !== undefined) purchase.currency = String(update.currency);
    await purchase.save();
    res.json({ success: true, purchase });
  } catch (error) {
    next(error);
  }
});

router.post('/:purchaseId/submit', async (req, res, next) => {
  try {
    const purchase = await submitPurchaseForUser(req.userId!, req.params.purchaseId);
    if (!purchase) {
      res.status(404).json({ error: 'Purchase not found' });
      return;
    }
    res.json({ success: true, purchase });
  } catch (error) {
    next(error);
  }
});

router.post('/:purchaseId/approve', async (req, res, next) => {
  try {
    const purchase = await approvePurchaseForUser(req.userId!, req.params.purchaseId);
    if (!purchase) {
      res.status(404).json({ error: 'Purchase not found' });
      return;
    }
    res.json({ success: true, purchase });
  } catch (error) {
    next(error);
  }
});

router.post('/:purchaseId/reject', async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const purchase = await rejectPurchaseForUser(req.userId!, req.params.purchaseId, reason);
    if (!purchase) {
      res.status(404).json({ error: 'Purchase not found' });
      return;
    }
    res.json({ success: true, purchase });
  } catch (error) {
    next(error);
  }
});

router.post('/:purchaseId/cancel', async (req, res, next) => {
  try {
    const purchase = await cancelPurchaseForUser(req.userId!, req.params.purchaseId);
    if (!purchase) {
      res.status(404).json({ error: 'Purchase not found' });
      return;
    }
    res.json({ success: true, purchase });
  } catch (error) {
    next(error);
  }
});

router.get('/:purchaseId/activity', async (req, res, next) => {
  try {
    const activity = await listPurchaseActivity(req.userId!, req.params.purchaseId);
    res.json({ success: true, activity });
  } catch (error) {
    next(error);
  }
});

export default router;
