import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/privy.js';
import { User } from '../models/User.js';

export interface AuthContext {
  userId: string;
  privyUserId: string;
  email: string;
  walletId: string | null;
  walletAddress: string | null;
}

// Extend Express Request to carry auth context and userId for backwards compatibility
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      userId?: string;
    }
  }
}

/**
 * Authentication middleware using Privy Access Tokens.
 * Extracts Bearer token from Authorization header and verifies it with Privy SDK.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header. Expected: Bearer <token>' });
    return;
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    res.status(401).json({ error: 'Empty access token provided' });
    return;
  }

  try {
    const claims = await verifyAccessToken(token);

    const user = await User.findOne({ privyUserId: claims.userId }).lean();

    if (!user) {
      res.status(401).json({ error: 'User account not synchronized. Please authenticate and call /api/auth/sync first.' });
      return;
    }

    if (user.accountStatus === 'suspended') {
      res.status(403).json({ error: 'Account is suspended.' });
      return;
    }

    const userId = user._id.toString();

    req.auth = {
      userId,
      privyUserId: user.privyUserId,
      email: user.email,
      walletId: user.walletId,
      walletAddress: user.walletAddress,
    };
    req.userId = userId;

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired access token' });
  }
}
