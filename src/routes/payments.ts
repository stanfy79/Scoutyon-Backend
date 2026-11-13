import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { isAddress } from 'viem';
import { authMiddleware } from '../middleware/auth.js';
import { Budget } from '../models/Budget.js';
import { MerchantPaymentProfile } from '../models/MerchantPaymentProfile.js';
import { PaymentAttempt } from '../models/PaymentAttempt.js';
import { Quote } from '../models/Quote.js';
import type { IQuote } from '../models/Quote.js';
import type { IMerchantPaymentProfile } from '../models/MerchantPaymentProfile.js';
import { Transaction } from '../models/Transaction.js';
import { User } from '../models/User.js';
import { config } from '../config.js';
import { checkPaymentPolicy, reservePaymentBudget, releasePaymentBudget } from '../services/policyEngine.js';
import { createExecutableQuote } from '../services/nearIntents.js';
import { getConfiguredSourceToken, getTokenByAssetId, getTokenCatalogue } from '../services/nearTokenRegistry.js';
import { assertServerSignerConfigured, sendErc20Deposit } from '../services/privyWalletSender.js';
import { getPaymentStatus, syncPaymentStatus } from '../services/paymentSettlement.js';
import { assertSufficientBalance, getWalletBalances } from '../services/walletBalance.js';
import { assertPaymentTransition } from '../services/paymentStateMachine.js';
import { inspectMerchantPaymentProfile, normalizeProviderId } from '../services/merchantPaymentProfiles.js';
import type { IPaymentAttempt } from '../models/PaymentAttempt.js';

const router = Router();
router.use(rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}));
router.use(authMiddleware);

function formatAtomic(amount: string, decimals: number): string {
  const padded = amount.padStart(decimals + 1, '0');
  if (decimals === 0) return padded;
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function publicPayment(attempt: IPaymentAttempt) {
  return {
    id: attempt._id.toString(),
    status: attempt.status,
    source: {
      assetId: attempt.originAssetId,
      asset: attempt.originTokenSymbol,
      chain: attempt.originBlockchain,
      amountAtomic: attempt.amountIn,
      decimals: attempt.originTokenDecimals,
      amount: formatAtomic(attempt.amountIn, attempt.originTokenDecimals),
    },
    destination: {
      assetId: attempt.destinationAssetId,
      asset: attempt.destinationTokenSymbol,
      chain: attempt.destinationBlockchain,
      amountAtomic: attempt.amountOut,
      decimals: attempt.destinationTokenDecimals,
      amount: formatAtomic(attempt.amountOut, attempt.destinationTokenDecimals),
      recipient: attempt.destinationRecipient,
    },
    maximumInputAtomic: attempt.maxAmountIn,
    expiresAt: attempt.quoteDeadline,
    sourceTransactionHash: attempt.sourceTransactionHash,
    destinationTransactionHash: attempt.destinationTransactionHash,
    simulation: attempt.simulation,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

function sendRouteError(error: unknown, res: Response, _next: NextFunction): void {
  const failure = error as { code?: string; statusCode?: number; message?: string };
  if (failure.code && failure.statusCode) {
    res.status(failure.statusCode).json({
      success: false,
      error: failure.code,
      message: failure.message ?? 'Payment request failed',
    });
    return;
  }
  console.error(
    '[Payments] Internal payment operation error',
    error instanceof Error ? error.name : 'UnknownError',
  );
  res.status(500).json({
    success: false,
    error: 'PAYMENT_INTERNAL_ERROR',
    message: 'Payment request failed. Check payment status before attempting another payment.',
  });
}

function requireLivePayments(res: Response): boolean {
  if (!config.PAYMENTS_LIVE_ENABLED || config.SIMULATE_PAYMENTS) {
    res.status(503).json({
      success: false,
      error: 'PAYMENTS_DISABLED',
      message: 'Live payments are not enabled for this service.',
    });
    return false;
  }
  return true;
}

async function verifiedMerchantForQuote(provider: string) {
  const inspection = await inspectMerchantPaymentProfile(provider);
  if (inspection.eligibility === 'unsupported') {
    throw Object.assign(new Error('This provider has not registered a verified crypto payment method'), {
      code: 'MERCHANT_CRYPTO_PAYMENT_UNSUPPORTED',
      statusCode: 409,
    });
  }
  if (!inspection.profile || inspection.eligibility !== 'invoice_required') {
    throw Object.assign(new Error('Merchant payment details are not currently verified'), {
      code: 'MERCHANT_PAYMENT_NOT_VERIFIED',
      statusCode: 409,
    });
  }
  return inspection.profile;
}

async function validateInvoice(quote: IQuote | null, profile: IMerchantPaymentProfile) {
  if (
    !quote?.paymentInvoice ||
    !quote.paymentInvoice.invoiceId ||
    !quote.paymentInvoice.assetId ||
    !quote.paymentInvoice.amountAtomic ||
    !quote.paymentInvoice.source ||
    !(quote.paymentInvoice.verifiedAt instanceof Date) ||
    quote.paymentInvoice.verifiedAt.getTime() > Date.now() ||
    Date.now() - quote.paymentInvoice.verifiedAt.getTime() > 10 * 60 * 1000
  ) {
    throw Object.assign(new Error('A current merchant-generated or officially verified invoice is required'), {
      code: 'MERCHANT_INVOICE_REQUIRED',
      statusCode: 409,
    });
  }
  if (quote.paymentInvoice.assetId !== profile.destinationAssetId) {
    throw Object.assign(new Error('Merchant invoice asset does not match the verified payment profile'), {
      code: 'MERCHANT_PAYMENT_NOT_VERIFIED',
      statusCode: 409,
    });
  }
  const destinationToken = await getTokenByAssetId(profile.destinationAssetId);
  if (
    destinationToken.blockchain.toLowerCase() !== profile.destinationBlockchain.toLowerCase() ||
    destinationToken.symbol.toUpperCase() !== profile.acceptedPaymentToken.toUpperCase()
  ) {
    throw Object.assign(new Error('Merchant payment token does not match NEAR Intents metadata'), {
      code: 'TOKEN_NOT_SUPPORTED',
      statusCode: 409,
    });
  }
  return destinationToken;
}

router.get('/readiness', async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) {
      res.status(404).json({ success: false, error: 'WALLET_NOT_FOUND' });
      return;
    }

    let signerDelegated = false;
    let signerError: string | null = null;
    let signerErrorMessage: string | null = null;
    if (user.walletId && user.walletAddress && user.privyUserId) {
      try {
        await assertServerSignerConfigured(user.walletId, user.walletAddress, user.privyUserId);
        signerDelegated = true;
      } catch (error) {
        signerDelegated = false;
        signerError = (error as { code?: string }).code ?? 'WALLET_NOT_DELEGATED';
        signerErrorMessage = error instanceof Error ? error.message : 'Unable to verify the Privy payment signer';
      }
    } else {
      signerError = 'WALLET_NOT_CONFIGURED';
      signerErrorMessage = 'Complete wallet provisioning and authenticate with the Privy user that owns the wallet.';
    }

    let sourceAsset: Record<string, unknown> | null = null;
    let balances: Awaited<ReturnType<typeof getWalletBalances>> | null = null;
    let sourceAssetError: string | null = null;
    let sourceAssetErrorMessage: string | null = null;
    let balanceError: string | null = null;
    let balanceErrorMessage: string | null = null;
    try {
      const token = await getConfiguredSourceToken();
      sourceAsset = {
        assetId: token.assetId,
        symbol: token.symbol,
        blockchain: token.blockchain,
        decimals: token.decimals,
        contractAddress: token.contractAddress ?? null,
        chainId: config.PAYMENT_SOURCE_CHAIN_ID ?? null,
      };
      if (user.walletAddress) {
        try {
          balances = await getWalletBalances(user.walletAddress, token);
        } catch (error) {
          balanceError = (error as { code?: string }).code ?? 'PAYMENT_BALANCE_RPC_FAILED';
          balanceErrorMessage = error instanceof Error ? error.message : 'Unable to read payment balances';
        }
      } else {
        balanceError = 'WALLET_ADDRESS_MISSING';
        balanceErrorMessage = 'A provisioned wallet address is required to read payment balances';
      }
    } catch (error) {
      sourceAsset = null;
      sourceAssetError = (error as { code?: string }).code ?? 'SOURCE_ASSET_UNAVAILABLE';
      sourceAssetErrorMessage = error instanceof Error ? error.message : 'Unable to resolve the configured payment asset';
    }

    res.json({
      success: true,
      readiness: {
        walletExists: Boolean(user.walletId && user.walletAddress && user.walletProvisioningStatus === 'completed'),
        walletId: user.walletId,
        walletAddress: user.walletAddress,
        signerDelegated,
        signerError,
        signerErrorMessage,
        signerSetupInstructions:
          signerError === 'WALLET_NOT_DELEGATED'
            ? 'The wallet owner must explicitly authorize the configured Privy key quorum and transfer policy for this wallet through an owner-authorized Privy flow. This readiness check does not attach signers or change wallet ownership.'
            : signerError === 'WALLET_OWNER_MISMATCH'
              ? 'Authenticate with the Privy identity that owns this wallet or reconcile the stored user-to-wallet association after owner verification. Do not reassign wallet ownership.'
              : null,
        sourceAsset,
        sourceAssetError,
        sourceAssetErrorMessage,
        balanceError,
        balanceErrorMessage,
        gasEstimationError: balances?.gasEstimationError ?? null,
        gasEstimationErrorMessage: balances?.gasEstimationErrorMessage ?? null,
        sourceTokenBalanceAtomic: balances?.tokenBalance.toString() ?? null,
        nativeGasBalanceAtomic: balances?.nativeBalance.toString() ?? null,
        estimatedGasAtomic: balances?.estimatedGas?.toString() ?? null,
        estimatedGasFeeAtomic: balances?.estimatedGasFee?.toString() ?? null,
        chainId: config.PAYMENT_SOURCE_CHAIN_ID ?? null,
        livePaymentsEnabled: config.PAYMENTS_LIVE_ENABLED && !config.SIMULATE_PAYMENTS,
        ready: Boolean(
          config.PAYMENTS_LIVE_ENABLED &&
            !config.SIMULATE_PAYMENTS &&
            user.walletId &&
            user.walletAddress &&
            signerDelegated &&
            sourceAsset &&
            balances &&
            balances.estimatedGasFee !== null &&
            balances.tokenBalance > 0n &&
            balances.nativeBalance >= balances.estimatedGasFee,
        ),
      },
    });
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

router.get('/supported-assets', async (_req, res, next) => {
  try {
    const [tokens, profiles] = await Promise.all([
      getTokenCatalogue(),
      MerchantPaymentProfile.find({
        enabled: true,
        verified: true,
        verificationStatus: 'verified',
      }).select('providerId providerName destinationAssetId destinationBlockchain acceptedPaymentToken'),
    ]);
    const source = tokens.find((token) => token.assetId === config.PAYMENT_SOURCE_ASSET_ID) ?? null;
    const destinationIds = new Set(profiles.map((profile) => profile.destinationAssetId));
    res.json({
      success: true,
      source: source
        ? [{ assetId: source.assetId, symbol: source.symbol, blockchain: source.blockchain, decimals: source.decimals }]
        : [],
      destinations: tokens
        .filter((token) => destinationIds.has(token.assetId))
        .map((token) => ({ assetId: token.assetId, symbol: token.symbol, blockchain: token.blockchain, decimals: token.decimals })),
    });
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

router.post('/:paymentId/confirm', async (req, res, next) => {
  if (!requireLivePayments(res)) return;
  try {
    if (typeof req.params.paymentId !== 'string' || !/^[a-f\d]{24}$/i.test(req.params.paymentId)) {
      res.status(400).json({ success: false, error: 'INVALID_PAYMENT_ID' });
      return;
    }
    if (req.body?.confirm !== true) {
      res.status(400).json({ success: false, error: 'EXPLICIT_CONFIRMATION_REQUIRED' });
      return;
    }
    const attempt = await PaymentAttempt.findOne({ _id: req.params.paymentId, userId: req.userId });
    if (!attempt) {
      res.status(404).json({ success: false, error: 'PAYMENT_NOT_FOUND' });
      return;
    }
    if (attempt.status !== 'AWAITING_USER_CONFIRMATION') {
      res.status(attempt.status === 'SUBMISSION_UNKNOWN' ? 202 : 200).json({
        success: true,
        payment: publicPayment(attempt),
      });
      return;
    }

    const user = await User.findById(req.userId).lean();
    const quote = await Quote.findOne({ _id: attempt.quoteId, userId: req.userId });
    const profile = await MerchantPaymentProfile.findOne({
      _id: attempt.merchantProfileId,
      enabled: true,
      verified: true,
      verificationStatus: 'verified',
    });
    if (
      !user?.walletId ||
      !user.walletAddress ||
      !user.privyUserId ||
      user.walletId !== attempt.privyWalletId ||
      user.walletAddress.toLowerCase() !== attempt.refundAddress.toLowerCase()
    ) {
      throw Object.assign(new Error('Payment wallet no longer matches the authenticated user'), {
        code: 'WALLET_NOT_FOUND',
        statusCode: 403,
      });
    }
    if (
      !quote ||
      !['pending', 'approved'].includes(quote.status) ||
      !profile ||
      profile.providerId !== normalizeProviderId(quote.provider) ||
      profile.destinationAssetId !== attempt.destinationAssetId ||
      profile.destinationWalletAddress.toLowerCase() !== attempt.destinationRecipient.toLowerCase()) {
      throw Object.assign(new Error('Verified merchant payment details have changed'), {
        code: 'MERCHANT_PAYMENT_NOT_VERIFIED',
        statusCode: 409,
      });
    }
    const destinationToken = await validateInvoice(quote, profile);
    if (
      quote.paymentInvoice?.assetId !== attempt.destinationAssetId ||
      quote.paymentInvoice?.amountAtomic !== attempt.amountOut ||
      quote.paymentInvoice?.invoiceId !== attempt.merchantInvoiceId ||
      quote.paymentInvoice?.source !== attempt.merchantInvoiceSource ||
      quote.paymentInvoice?.verifiedAt.getTime() !== attempt.merchantInvoiceVerifiedAt.getTime()
    ) {
      throw Object.assign(new Error('Stored payment no longer matches the verified merchant invoice'), {
        code: 'MERCHANT_INVOICE_REQUIRED',
        statusCode: 409,
      });
    }
    if (attempt.quoteDeadline.getTime() <= Date.now()) {
      assertPaymentTransition(attempt.status, 'EXPIRED');
      const expiredAttempt = await PaymentAttempt.findOneAndUpdate(
        { _id: attempt._id, status: 'AWAITING_USER_CONFIRMATION' },
        { $set: { status: 'EXPIRED' } },
        { new: true },
      );
      if (expiredAttempt?.budgetReservationActive) {
        const claimed = await PaymentAttempt.findOneAndUpdate(
          { _id: attempt._id, status: 'EXPIRED', budgetReservationActive: true },
          { $set: { budgetReservationActive: false } },
          { new: true },
        );
        if (claimed) {
          await releasePaymentBudget({
            userId: attempt.userId.toString(),
            budgetId: attempt.budgetId.toString(),
            amountMicros: attempt.budgetReservationMicros,
          });
        }
      }
      if (expiredAttempt) {
        attempt.status = 'EXPIRED';
        attempt.budgetReservationActive = false;
      }
      if (expiredAttempt) {
        await Quote.updateOne(
          { _id: quote._id, activePaymentAttemptId: attempt._id },
          {
            $unset: { activePaymentAttemptId: 1 },
            $set: { paymentEligibility: 'invoice_required' },
          },
        );
      }
      res.status(409).json({ success: false, error: 'QUOTE_EXPIRED', message: 'Prepare a fresh payment quote.' });
      return;
    }

    const sourceToken = await getConfiguredSourceToken();
    if (
      sourceToken.assetId !== attempt.originAssetId ||
      sourceToken.blockchain !== attempt.originBlockchain ||
      sourceToken.decimals !== attempt.originTokenDecimals ||
      !config.PAYMENT_SOURCE_CHAIN_ID ||
      config.PAYMENT_SOURCE_CHAIN_ID !== attempt.originChainId ||
      config.PAYMENT_SOURCE_TOKEN_ADDRESS?.toLowerCase() !== attempt.originTokenAddress.toLowerCase() ||
      destinationToken.assetId !== attempt.destinationAssetId
    ) {
      throw Object.assign(new Error('Configured payment route no longer matches the prepared payment'), {
        code: 'TOKEN_NOT_SUPPORTED',
        statusCode: 409,
      });
    }
    await assertServerSignerConfigured(attempt.privyWalletId, user.walletAddress, user.privyUserId);
    const maximumPolicy = await checkPaymentPolicy({
      userId: req.userId!,
      budgetId: attempt.budgetId.toString(),
      providerId: profile.providerId,
      providerName: profile.providerName,
      sourceAmountMax: attempt.maxAmountIn ?? attempt.amountIn,
      sourceToken,
    });
    const expectedPolicy = await checkPaymentPolicy({
      userId: req.userId!,
      budgetId: attempt.budgetId.toString(),
      providerId: profile.providerId,
      providerName: profile.providerName,
      sourceAmountMax: attempt.amountIn,
      sourceToken,
    });
    if (
      !maximumPolicy.allowed ||
      !expectedPolicy.allowed ||
      maximumPolicy.budgetDebitMicros !== attempt.budgetReservationMicros ||
      expectedPolicy.budgetDebitMicros !== attempt.budgetDebitMicros
    ) {
      throw Object.assign(new Error(maximumPolicy.reason ?? expectedPolicy.reason ?? 'Payment policy changed; prepare a new payment'), {
        code: 'PAYMENT_POLICY_REJECTED',
        statusCode: 402,
      });
    }
    await assertSufficientBalance(attempt, user.walletAddress, sourceToken);

    const lockedAttempt = await PaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, userId: req.userId, status: 'AWAITING_USER_CONFIRMATION' },
      { $set: { status: 'SUBMITTING', confirmedAt: new Date(), approvedAt: new Date() } },
      { new: true },
    );
    if (!lockedAttempt) {
      const latest = await PaymentAttempt.findOne({ _id: attempt._id, userId: req.userId });
      res.status(202).json({ success: true, payment: latest ? publicPayment(latest) : null });
      return;
    }
    assertPaymentTransition('AWAITING_USER_CONFIRMATION', lockedAttempt.status);

    const transaction = await Transaction.create({
      quoteId: quote._id,
      userId: req.userId,
      provider: quote.provider,
      amount: quote.price,
      currency: quote.currency,
      status: 'pending',
      simulated: false,
      simulation: false,
      paymentAttemptId: lockedAttempt._id,
      amountAtomic: lockedAttempt.amountIn,
      metadata: { paymentAttemptId: lockedAttempt._id.toString(), quoteCorrelationId: lockedAttempt.quoteCorrelationId },
    });
    lockedAttempt.transactionId = transaction._id;
    await lockedAttempt.save();

    let submission: Awaited<ReturnType<typeof sendErc20Deposit>>;
    try {
      submission = await sendErc20Deposit({
        attempt: lockedAttempt,
        walletAddress: user.walletAddress,
        privyUserId: user.privyUserId,
      });
    } catch (error) {
      const failure = error as { code?: string; statusCode?: number; message?: string };
      const newStatus = failure.code === 'SUBMISSION_UNKNOWN' ? 'SUBMISSION_UNKNOWN' : 'FAILED';
      assertPaymentTransition('SUBMITTING', newStatus);
      await PaymentAttempt.updateOne(
        { _id: lockedAttempt._id, status: 'SUBMITTING' },
        {
          $set: {
            status: newStatus,
            errorCode: failure.code ?? 'PRIVY_TRANSACTION_FAILED',
            errorMessage: failure.message ?? 'Privy transaction submission failed',
          },
        },
      );
      if (newStatus === 'FAILED') {
        await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
        if (lockedAttempt.budgetReservationActive) {
          await releasePaymentBudget({
            userId: lockedAttempt.userId.toString(),
            budgetId: lockedAttempt.budgetId.toString(),
            amountMicros: lockedAttempt.budgetReservationMicros,
          });
          lockedAttempt.budgetReservationActive = false;
          await lockedAttempt.save();
        }
        await Quote.updateOne(
          { _id: quote._id, activePaymentAttemptId: lockedAttempt._id },
          {
            $unset: { activePaymentAttemptId: 1 },
            $set: { paymentEligibility: 'invoice_required' },
          },
        );
      }
      throw error;
    }

    const submitted = await PaymentAttempt.findOneAndUpdate(
      { _id: lockedAttempt._id, status: { $in: ['SUBMITTING', 'SUBMISSION_UNKNOWN'] } },
      {
        $set: {
          status: 'SOURCE_TX_SUBMITTED',
          sourceTransactionHash: submission.transactionHash,
          privyWalletActionId: submission.walletActionId,
          sourceTransactionStatus: 'submitted',
        },
      },
      { new: true },
    );
    assertPaymentTransition(lockedAttempt.status, 'SOURCE_TX_SUBMITTED');
    if (!submitted) {
      res.status(202).json({ success: true, payment: publicPayment(lockedAttempt) });
      return;
    }
    await Transaction.updateOne({ _id: transaction._id }, { $set: { txHash: submission.transactionHash } });

    const synced = await syncPaymentStatus(req.userId!, submitted._id.toString());
    res.status(synced.status === 'SUCCESS' ? 200 : 202).json({
      success: true,
      payment: publicPayment(synced),
    });
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const payments = await PaymentAttempt.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, payments });
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

router.get('/:paymentId/status', async (req, res, next) => {
  try {
    if (typeof req.params.paymentId !== 'string' || !/^[a-f\d]{24}$/i.test(req.params.paymentId)) {
      res.status(400).json({ success: false, error: 'INVALID_PAYMENT_ID' });
      return;
    }
    const payment = await syncPaymentStatus(req.userId!, req.params.paymentId);
    res.json({ success: true, payment: publicPayment(payment) });
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

router.get('/:paymentId', async (req, res, next) => {
  try {
    if (typeof req.params.paymentId !== 'string' || !/^[a-f\d]{24}$/i.test(req.params.paymentId)) {
      res.status(400).json({ success: false, error: 'INVALID_PAYMENT_ID' });
      return;
    }
    const payment = await getPaymentStatus(req.userId!, req.params.paymentId);
    res.json({ success: true, payment });
  } catch (error) {
    sendRouteError(error, res, next);
  }
});

export async function prepareQuotePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!requireLivePayments(res)) return;
  let reservation: { budgetId: string; amountMicros: string } | null = null;
  try {
    if (typeof req.params.quoteId !== 'string' || !/^[a-f\d]{24}$/i.test(req.params.quoteId)) {
      res.status(400).json({ success: false, error: 'INVALID_QUOTE_ID' });
      return;
    }
    const quote = await Quote.findOne({ _id: req.params.quoteId, userId: req.userId });
    if (!quote) {
      res.status(404).json({ success: false, error: 'QUOTE_NOT_FOUND' });
      return;
    }
    if (!['pending', 'approved'].includes(quote.status)) {
      res.status(409).json({ success: false, error: quote.status === 'paid' ? 'PAYMENT_ALREADY_SETTLED' : 'QUOTE_NOT_PAYABLE' });
      return;
    }
    if (quote.activePaymentAttemptId) {
      const active = await PaymentAttempt.findById(quote.activePaymentAttemptId);
      if (active) {
        res.status(200).json({ success: true, payment: publicPayment(active) });
        return;
      }
    }
    const existing = await PaymentAttempt.findOne({
      userId: req.userId,
      quoteId: quote._id,
      status: { $in: ['SUBMITTING', 'SOURCE_TX_SUBMITTED', 'SOURCE_TX_CONFIRMED', 'PROCESSING', 'SUCCESS', 'SUBMISSION_UNKNOWN', 'REQUIRES_MANUAL_REVIEW'] },
    });
    if (existing) {
      res.status(409).json({ success: false, error: existing.status === 'SUCCESS' ? 'PAYMENT_ALREADY_SETTLED' : 'PAYMENT_ALREADY_SUBMITTED' });
      return;
    }

    const profile = await verifiedMerchantForQuote(quote.provider);
    if (!profile.destinationWalletAddress.trim()) {
      throw Object.assign(new Error('Merchant payment profile has an invalid destination address'), {
        code: 'MERCHANT_PAYMENT_NOT_VERIFIED',
        statusCode: 409,
      });
    }
    const destinationToken = await validateInvoice(quote, profile);
    const invoice = quote.paymentInvoice!;
    if (!quote.budgetId) {
      throw Object.assign(new Error('A payment budget is required for live payments'), {
        code: 'PAYMENT_POLICY_REJECTED',
        statusCode: 402,
      });
    }
    const user = await User.findById(req.userId).lean();
    if (!user?.walletId || !user.walletAddress || !user.privyUserId || user.walletProvisioningStatus !== 'completed') {
      throw Object.assign(new Error('The authenticated user does not have a provisioned Privy wallet'), {
        code: 'WALLET_NOT_FOUND',
        statusCode: 409,
      });
    }
    await assertServerSignerConfigured(user.walletId, user.walletAddress, user.privyUserId);
    const sourceToken = await getConfiguredSourceToken();
    const executableQuote = await createExecutableQuote({
      originAsset: sourceToken.assetId,
      destinationAsset: destinationToken.assetId,
      destinationAmount: invoice.amountAtomic,
      recipient: profile.destinationWalletAddress,
      refundTo: user.walletAddress,
    });

    const budget = await Budget.findOne({ _id: quote.budgetId, userId: req.userId, active: true }).lean();
    if (!budget) {
      throw Object.assign(new Error('Budget not found or inactive'), {
        code: 'PAYMENT_POLICY_REJECTED',
        statusCode: 402,
      });
    }
    const maximumPolicy = await checkPaymentPolicy({
      userId: req.userId!,
      budgetId: quote.budgetId.toString(),
      providerId: profile.providerId,
      providerName: profile.providerName,
      sourceAmountMax: executableQuote.maxAmountIn ?? executableQuote.amountIn,
      sourceToken,
    });
    const expectedPolicy = await checkPaymentPolicy({
      userId: req.userId!,
      budgetId: quote.budgetId.toString(),
      providerId: profile.providerId,
      providerName: profile.providerName,
      sourceAmountMax: executableQuote.amountIn,
      sourceToken,
    });
    if (
      !maximumPolicy.allowed ||
      !expectedPolicy.allowed ||
      !maximumPolicy.budgetDebitMicros ||
      !expectedPolicy.budgetDebitMicros
    ) {
      throw Object.assign(new Error(maximumPolicy.reason ?? expectedPolicy.reason ?? 'Payment policy rejected this payment'), {
        code: 'BUDGET_EXCEEDED',
        statusCode: 402,
      });
    }
    const balanceProbe = {
      originTokenAddress: config.PAYMENT_SOURCE_TOKEN_ADDRESS!,
      depositAddress: executableQuote.depositAddress,
      amountIn: executableQuote.amountIn,
      originChainId: config.PAYMENT_SOURCE_CHAIN_ID!,
    };
    const gas = await assertSufficientBalance(balanceProbe, user.walletAddress, sourceToken);

    await reservePaymentBudget({
      userId: req.userId!,
      budgetId: quote.budgetId.toString(),
      amountMicros: maximumPolicy.budgetDebitMicros,
    });
    reservation = { budgetId: quote.budgetId.toString(), amountMicros: maximumPolicy.budgetDebitMicros };

    const attempt = await PaymentAttempt.create({
      userId: req.userId,
      quoteId: quote._id,
      status: 'AWAITING_USER_CONFIRMATION',
      originAssetId: sourceToken.assetId,
      originBlockchain: sourceToken.blockchain,
      originChainId: config.PAYMENT_SOURCE_CHAIN_ID!,
      originCaip2: `eip155:${config.PAYMENT_SOURCE_CHAIN_ID}`,
      originTokenAddress: config.PAYMENT_SOURCE_TOKEN_ADDRESS!,
      originTokenSymbol: sourceToken.symbol,
      originTokenDecimals: sourceToken.decimals,
      destinationAssetId: destinationToken.assetId,
      destinationBlockchain: destinationToken.blockchain,
      destinationRecipient: profile.destinationWalletAddress,
      destinationTokenSymbol: destinationToken.symbol,
      destinationTokenDecimals: destinationToken.decimals,
      depositAddress: executableQuote.depositAddress,
      depositMemo: executableQuote.depositMemo,
      refundAddress: user.walletAddress,
      amountIn: executableQuote.amountIn,
      minAmountIn: executableQuote.minAmountIn,
      maxAmountIn: executableQuote.maxAmountIn,
      amountOut: executableQuote.amountOut,
      quoteCorrelationId: executableQuote.correlationId,
      quoteDeadline: executableQuote.deadline,
      slippageTolerance: config.PAYMENT_SLIPPAGE_BPS,
      privyWalletId: user.walletId,
      approvedAt: null,
      idempotencyKey: randomUUID(),
      simulation: false,
      merchantProfileId: profile._id,
      merchantInvoiceId: invoice.invoiceId,
      merchantInvoiceSource: invoice.source,
      merchantInvoiceVerifiedAt: invoice.verifiedAt,
      budgetId: quote.budgetId,
      budgetDebitMicros: expectedPolicy.budgetDebitMicros,
      budgetReservationMicros: maximumPolicy.budgetDebitMicros,
      budgetReservationActive: true,
      fulfillmentStatus: 'not_configured',
    });

    const lockedQuote = await Quote.findOneAndUpdate(
      { _id: quote._id, userId: req.userId, activePaymentAttemptId: null },
      {
        $set: {
          activePaymentAttemptId: attempt._id,
          paymentEligibility: 'payment_prepared',
        },
      },
      { new: true },
    );
    if (!lockedQuote) {
      await PaymentAttempt.deleteOne({ _id: attempt._id });
      await releasePaymentBudget({
        userId: req.userId!,
        budgetId: quote.budgetId.toString(),
        amountMicros: maximumPolicy.budgetDebitMicros,
      });
      reservation = null;
      const concurrent = await PaymentAttempt.findOne({ userId: req.userId, quoteId: quote._id }).sort({ createdAt: -1 });
      if (concurrent) {
        res.status(200).json({ success: true, payment: publicPayment(concurrent) });
        return;
      }
      throw Object.assign(new Error('A payment attempt is already active for this quote'), {
        code: 'PAYMENT_ALREADY_SUBMITTED',
        statusCode: 409,
      });
    }
    reservation = null;
    res.status(201).json({
      success: true,
      payment: {
        ...publicPayment(attempt),
        maximumInput: formatAtomic(executableQuote.maxAmountIn!, sourceToken.decimals),
        estimatedNetworkFeeAtomic: gas.estimatedGasFee.toString(),
        merchant: profile.providerName,
        invoiceId: invoice.invoiceId,
        invoiceSource: invoice.source,
      },
    });
  } catch (error) {
    if (reservation) {
      try {
        await releasePaymentBudget({
          userId: req.userId!,
          budgetId: reservation.budgetId,
          amountMicros: reservation.amountMicros,
        });
      } catch (releaseError) {
        sendRouteError(releaseError, res, next);
        return;
      }
    }
    sendRouteError(error, res, next);
  }
}

export default router;
