import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User.js';

// Extend Express Request to carry userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string') {
    res.status(401).json({ error: 'Missing X-Api-Key header' });
    return;
  }

  const user = await User.findOne({ apiKey }).lean();

  if (!user) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  req.userId = user._id.toString();
  next();
}
