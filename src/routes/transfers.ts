import { Router, type Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  getSwapTransfer,
  requestSwapWalletAuthorization,
  submitSwapSourceTransaction,
  syncSwapTransferStatus,
} from '../services/swapTransferService.js';

const router = Router();
router.use(authMiddleware);

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function sendError(error: unknown, res: Response): void {
  const failure = error as { code?: string; statusCode?: number; message?: string };
  if (failure.code && failure.statusCode) {
    res.status(failure.statusCode).json({
      success: false,
      error: failure.code,
      message: failure.message ?? 'Transfer request failed.',
    });
    return;
  }
  console.error('[Transfers] General swap operation failed', error instanceof Error ? error.name : 'UnknownError');
  res.status(500).json({ success: false, error: 'SWAP_TRANSFER_INTERNAL_ERROR', message: 'Transfer request failed.' });
}

router.post('/:transferId/authorize', async (req, res) => {
  try {
    if (!validId(req.params.transferId)) {
      res.status(400).json({ success: false, error: 'INVALID_TRANSFER_ID' });
      return;
    }
    if (req.body?.confirm !== true) {
      res.status(400).json({ success: false, error: 'EXPLICIT_CONFIRMATION_REQUIRED' });
      return;
    }
    if (!validId(req.body?.sessionId)) {
      res.status(400).json({ success: false, error: 'INVALID_SESSION_ID' });
      return;
    }
    const result = await requestSwapWalletAuthorization({
      userId: req.userId!,
      sessionId: String(req.body?.sessionId ?? ''),
      transferId: req.params.transferId,
      confirm: true,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(error, res);
  }
});

router.post('/:transferId/submit', async (req, res) => {
  try {
    if (!validId(req.params.transferId)) {
      res.status(400).json({ success: false, error: 'INVALID_TRANSFER_ID' });
      return;
    }
    if (!validId(req.body?.sessionId)) {
      res.status(400).json({ success: false, error: 'INVALID_SESSION_ID' });
      return;
    }
    const result = await submitSwapSourceTransaction({
      userId: req.userId!,
      sessionId: req.body.sessionId,
      transferId: req.params.transferId,
      transactionHash: typeof req.body?.transactionHash === 'string' ? req.body.transactionHash : '',
    });
    res.status(result.status === 'success' ? 200 : 202).json({ success: true, ...result });
  } catch (error) {
    sendError(error, res);
  }
});

router.get('/:transferId/status', async (req, res) => {
  try {
    if (!validId(req.params.transferId) || !validId(req.query.sessionId)) {
      res.status(400).json({ success: false, error: 'INVALID_TRANSFER_OR_SESSION_ID' });
      return;
    }
    const result = await syncSwapTransferStatus(req.userId!, req.query.sessionId, req.params.transferId);
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(error, res);
  }
});

router.get('/:transferId', async (req, res) => {
  try {
    if (!validId(req.params.transferId) || !validId(req.query.sessionId)) {
      res.status(400).json({ success: false, error: 'INVALID_TRANSFER_OR_SESSION_ID' });
      return;
    }
    const transfer = await getSwapTransfer(req.userId!, req.query.sessionId, req.params.transferId);
    res.json({ success: true, transfer });
  } catch (error) {
    sendError(error, res);
  }
});

export default router;
