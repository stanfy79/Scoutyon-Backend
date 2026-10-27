import { Router } from 'express';
import { randomUUID } from 'crypto';
import { User } from '../models/User.js';

const router = Router();

/**
 * POST /api/auth/register
 * Create a new user and return a one-time API key.
 * Body: { name: string }
 */
router.post('/register', async (req, res, next) => {
  try {
    const { name } = req.body as { name?: string };

    if (!name || name.trim().length < 2) {
      res.status(400).json({ error: 'name must be at least 2 characters' });
      return;
    }

    const apiKey = `scy_${randomUUID().replace(/-/g, '')}`;
    const user = await User.create({ name: name.trim(), apiKey });

    // Return the API key only on creation — it is not stored in plain text elsewhere
    res.status(201).json({
      userId: user._id.toString(),
      name: user.name,
      apiKey,
      note: 'Save this API key — it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
