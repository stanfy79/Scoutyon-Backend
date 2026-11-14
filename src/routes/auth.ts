import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getPrivyUserById, verifyAccessToken } from '../services/privy.js';
import { syncPrivyUserWithDatabase, ensureEthereumEmbeddedWallet } from '../services/userService.js';
import { User } from '../models/User.js';
import { getPaymentSignerStatus, getPaymentSignerSettings } from '../services/privyPaymentSigner.js';

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
    const failure = err as { message?: string; statusCode?: number };
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 600
      ? failure.statusCode
      : 401;
    res.status(status).json({
      error: typeof failure.message === 'string' ? failure.message : 'Authentication synchronization failed',
    });
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

router.get('/payment-signer', authMiddleware, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user?.walletId || !user.walletAddress || !user.privyUserId) {
      res.status(409).json({
        success: false,
        error: 'WALLET_NOT_FOUND',
        message: 'Provision and synchronize the authenticated Privy embedded wallet before enabling payment authorization.',
      });
      return;
    }

    let status = await getPaymentSignerStatus({
      privyUserId: user.privyUserId,
      walletId: user.walletId,
      walletAddress: user.walletAddress,
    });

    // If not authorized, automatically attempt server-side auto-provisioning
    if (!status.authorized) {
      try {
        const privyUser = await getPrivyUserById(user.privyUserId);
        const upgraded = await ensureEthereumEmbeddedWallet(privyUser, user as any);
        if (upgraded.walletId) {
          status = await getPaymentSignerStatus({
            privyUserId: user.privyUserId,
            walletId: upgraded.walletId,
            walletAddress: upgraded.walletAddress,
          });
        }
      } catch (autoErr) {
        console.warn('[payment-signer] Auto-delegation attempt failed:', autoErr);
      }
    }

    await User.updateOne(
      { _id: user._id, privyUserId: user.privyUserId },
      {
        $set: {
          'paymentSignerAuthorization.status': status.authorized ? 'authorized' : 'not_authorized',
          'paymentSignerAuthorization.walletId': status.walletId,
          'paymentSignerAuthorization.signerId': status.signerId,
          'paymentSignerAuthorization.policyId': status.policyId,
          'paymentSignerAuthorization.verifiedAt': status.authorized ? status.verifiedAt : null,
        },
      },
    );
    res.json({
      success: true,
      authorization: {
        ...status,
        actionLabel: 'Enable Scoutyon Payment Authorization',
        permissions: {
          chainId: 8453,
          chain: 'Base',
          tokenContractsAndMaximumAtomicAmounts: getPaymentSignerSettings().baseTokenLimits,
          methods: ['ERC-20 transfer(address,uint256)'],
          nativeTransfers: false,
          arbitraryContractCalls: false,
          recipientAndAmount: 'Validated by the backend against the confirmed, unexpired executable quote for each transfer.',
          explicitUserConsentRequired: true,
        },
        privateAuthorizationKeyExposed: false,
      },
    });
  } catch (error) {
    const failure = error as { code?: string; statusCode?: number; message?: string };
    if (failure.code && failure.statusCode) {
      res.status(failure.statusCode).json({ success: false, error: failure.code, message: failure.message });
      return;
    }
    next(error);
  }
});

router.post('/payment-signer/verify', authMiddleware, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user?.walletId || !user.walletAddress || !user.privyUserId) {
      res.status(409).json({
        success: false,
        error: 'WALLET_NOT_FOUND',
        message: 'Provision and synchronize the authenticated Privy embedded wallet before enabling payment authorization.',
      });
      return;
    }

    let status = await getPaymentSignerStatus({
      privyUserId: user.privyUserId,
      walletId: user.walletId,
      walletAddress: user.walletAddress,
    });

    // If not authorized, automatically attempt server-side auto-provisioning
    if (!status.authorized) {
      try {
        const privyUser = await getPrivyUserById(user.privyUserId);
        const upgraded = await ensureEthereumEmbeddedWallet(privyUser, user as any);
        if (upgraded.walletId) {
          status = await getPaymentSignerStatus({
            privyUserId: user.privyUserId,
            walletId: upgraded.walletId,
            walletAddress: upgraded.walletAddress,
          });
        }
      } catch (autoErr) {
        console.warn('[payment-signer] Auto-delegation attempt failed:', autoErr);
      }
    }

    await User.updateOne(
      { _id: user._id, privyUserId: user.privyUserId },
      {
        $set: {
          'paymentSignerAuthorization.status': status.authorized ? 'authorized' : 'not_authorized',
          'paymentSignerAuthorization.walletId': status.walletId,
          'paymentSignerAuthorization.signerId': status.signerId,
          'paymentSignerAuthorization.policyId': status.policyId,
          'paymentSignerAuthorization.verifiedAt': status.authorized ? status.verifiedAt : null,
        },
      },
    );
    if (!status.authorized) {
      res.status(403).json({ success: false, error: status.status, message: status.message, authorization: status });
      return;
    }
    res.json({ success: true, authorization: status });
  } catch (error) {
    const failure = error as { code?: string; statusCode?: number; message?: string };
    if (failure.code && failure.statusCode) {
      res.status(failure.statusCode).json({ success: false, error: failure.code, message: failure.message });
      return;
    }
    next(error);
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
