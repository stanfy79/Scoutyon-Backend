import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getPrivyUserById, verifyAccessToken } from '../services/privy.js';
import { syncPrivyUserWithDatabase } from '../services/userService.js';
import { User } from '../models/User.js';

const router = Router();

/**
 * POST /api/auth/sync
 * Synchronize the authenticated Privy user with Scoutyon.
 *
 * Headers required:
 *   Authorization: Bearer <access_token>
 */
router.post('/sync', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const accessToken = authHeader.slice(7).trim();

    if (!accessToken) {
      res.status(401).json({ error: 'Access token must not be empty' });
      return;
    }

    const rawIdToken =
      req.headers['privy-id-token'] ||
      req.headers['x-privy-id-token'] ||
      req.body?.idToken;
    const idToken = typeof rawIdToken === 'string' && rawIdToken.trim() ? rawIdToken.trim() : undefined;

    const claims = await verifyAccessToken(accessToken);

    const privyUser = await getPrivyUserById(claims.userId, idToken);
    if (claims.userId !== privyUser.id) {
      res.status(401).json({ error: 'Privy user profile does not match the access token' });
      return;
    }

    const result = await syncPrivyUserWithDatabase(privyUser);

    res.status(result.created ? 201 : 200).json({
      success: true,
      user: {
        id: result.user._id.toString(),
        privyUserId: result.user.privyUserId,
        email: result.user.email,
        accountStatus: result.user.accountStatus,
        emailVerified: !!result.user.emailVerifiedAt,
        wallet: {
          id: result.wallet.id,
          address: result.wallet.address,
          chainType: result.wallet.chainType,
          provisioningStatus: result.wallet.provisioningStatus,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication synchronization failed';
    res.status(401).json({ error: message });
  }
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated user's profile and embedded wallet info.
 */
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).lean();

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user._id.toString(),
      privyUserId: user.privyUserId,
      email: user.email,
      emailVerified: !!user.emailVerifiedAt,
      accountStatus: user.accountStatus,
      wallet: {
        id: user.walletId,
        address: user.walletAddress,
        chainType: user.walletChainType || 'ethereum',
        provisioningStatus: user.walletProvisioningStatus,
      },
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/register (Deprecated)
 * Kept only for graceful migration notification.
 */
router.post('/register', (_req, res) => {
  res.status(410).json({
    error: 'API key registration is deprecated. Please use Privy authentication via /api/auth/sync.',
  });
});

export default router;
