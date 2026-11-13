import { PaymentAttempt, type IPaymentAttempt, type PaymentAttemptStatus } from '../models/PaymentAttempt.js';
import { Quote } from '../models/Quote.js';
import { Transaction } from '../models/Transaction.js';
import { getExecutionStatus, submitDepositTransaction } from './nearIntents.js';
import { assertPaymentTransition } from './paymentStateMachine.js';
import { settlePaymentBudget, releasePaymentBudget } from './policyEngine.js';
import { verifyTransferReceipt } from './walletBalance.js';

function sourceStatusIsVerifiable(status: PaymentAttemptStatus): boolean {
  return status === 'SOURCE_TX_SUBMITTED' || status === 'SUBMISSION_UNKNOWN';
}

export async function getPaymentStatus(userId: string, paymentId: string) {
  const payment = await PaymentAttempt.findOne({ _id: paymentId, userId }).lean();
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { code: 'PAYMENT_NOT_FOUND', statusCode: 404 });
  }
  return payment;
}

export async function syncPaymentStatus(userId: string, paymentId: string): Promise<IPaymentAttempt> {
  let payment = await PaymentAttempt.findOne({ _id: paymentId, userId });
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { code: 'PAYMENT_NOT_FOUND', statusCode: 404 });
  }
  if (payment.quoteDeadline.getTime() <= Date.now() && payment.status === 'AWAITING_USER_CONFIRMATION') {
    assertPaymentTransition(payment.status, 'EXPIRED');
    payment.status = 'EXPIRED';
    await payment.save();
    await releaseReservation(payment);
    await Quote.updateOne(
      { _id: payment.quoteId, activePaymentAttemptId: payment._id },
      {
        $unset: { activePaymentAttemptId: 1 },
        $set: { paymentEligibility: 'invoice_required' },
      },
    );
    return payment;
  }

  if (sourceStatusIsVerifiable(payment.status) && payment.sourceTransactionHash) {
    try {
      await verifyTransferReceipt({
        transactionHash: payment.sourceTransactionHash as `0x${string}`,
        walletAddress: await resolveWalletAddress(userId),
        tokenAddress: payment.originTokenAddress,
        depositAddress: payment.depositAddress,
        amount: payment.amountIn,
        chainId: payment.originChainId,
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'SOURCE_TX_PENDING') return payment;
      if ((error as { code?: string }).code === 'SOURCE_TRANSACTION_REVERTED') {
        await transition(payment, 'FAILED', 'SOURCE_TRANSACTION_REVERTED', 'Source-chain transaction reverted');
        await releaseReservation(payment);
        await Quote.updateOne(
          { _id: payment.quoteId, activePaymentAttemptId: payment._id },
          {
            $unset: { activePaymentAttemptId: 1 },
            $set: { paymentEligibility: 'invoice_required' },
          },
        );
        return payment;
      }
      if ((error as { code?: string }).code === 'SOURCE_TRANSACTION_INVALID') {
        await transition(payment, 'REQUIRES_MANUAL_REVIEW', 'SOURCE_TRANSACTION_INVALID', error instanceof Error ? error.message : 'Receipt verification failed');
        return payment;
      }
      throw error;
    }

    await transition(payment, 'SOURCE_TX_CONFIRMED');
    payment = (await PaymentAttempt.findById(payment._id))!;
    if (payment.status === 'SOURCE_TX_CONFIRMED') {
      try {
        await submitDepositTransaction(payment.depositAddress, payment.sourceTransactionHash!);
      } catch {
        await PaymentAttempt.updateOne(
          { _id: payment._id, status: 'SOURCE_TX_CONFIRMED' },
          {
            $set: {
              errorCode: 'DEPOSIT_NOTIFICATION_FAILED',
              errorMessage: 'Optional deposit notification failed; settlement will continue to be polled.',
            },
          },
        );
      }
      await transition(payment, 'PROCESSING');
      payment = (await PaymentAttempt.findById(payment._id))!;
    }
  }

  if (payment.status === 'SOURCE_TX_CONFIRMED') {
    await transition(payment, 'PROCESSING');
    payment = (await PaymentAttempt.findById(payment._id))!;
  }

  if (payment.status === 'SUCCESS') await handleSuccessfulSettlement(payment);
  if (payment.status === 'REFUNDED') await handleRefundedSettlement(payment);
  if (payment.status === 'FAILED') await handleFailedSettlement(payment);
  if (!['SOURCE_TX_CONFIRMED', 'PROCESSING'].includes(payment.status)) {
    return payment;
  }

  const externalStatus = await getExecutionStatus(payment.depositAddress);
  payment.nearIntentsStatus = externalStatus.status;
  payment.nearIntentsResponse = externalStatus.raw;
  if (externalStatus.destinationTransactionHash) {
    payment.destinationTransactionHash = externalStatus.destinationTransactionHash;
  }

  const targetStatus: Partial<Record<typeof externalStatus.status, PaymentAttemptStatus>> = {
    PENDING_DEPOSIT: 'PROCESSING',
    KNOWN_DEPOSIT_TX: 'PROCESSING',
    PROCESSING: 'PROCESSING',
    SUCCESS: 'SUCCESS',
    REFUNDED: 'REFUNDED',
    FAILED: 'FAILED',
    INCOMPLETE_DEPOSIT: 'INCOMPLETE_DEPOSIT',
  };
  const nextStatus = targetStatus[externalStatus.status];
  await PaymentAttempt.updateOne(
    { _id: payment._id, status: payment.status },
    {
      $set: {
        nearIntentsStatus: externalStatus.status,
        nearIntentsResponse: externalStatus.raw,
        destinationTransactionHash: payment.destinationTransactionHash,
      },
    },
  );
  if (nextStatus && nextStatus !== payment.status) {
    const reason =
      typeof externalStatus.raw.reason === 'string' ? externalStatus.raw.reason : null;
    await transition(
      payment,
      nextStatus,
      externalStatus.status === 'FAILED'
        ? 'NEAR_INTENTS_FAILED'
        : externalStatus.status === 'INCOMPLETE_DEPOSIT'
          ? 'INCOMPLETE_DEPOSIT'
          : undefined,
      externalStatus.status === 'FAILED'
        ? reason ?? 'NEAR Intents reported that the payment failed'
        : externalStatus.status === 'INCOMPLETE_DEPOSIT'
          ? reason ?? 'NEAR Intents detected an incomplete deposit; manual review is required'
          : undefined,
    );
  }
  payment = (await PaymentAttempt.findById(payment._id))!;
  if (payment.status === 'SUCCESS') await handleSuccessfulSettlement(payment);
  if (payment.status === 'REFUNDED') await handleRefundedSettlement(payment);
  if (payment.status === 'FAILED') await handleFailedSettlement(payment);
  if (payment.status === 'INCOMPLETE_DEPOSIT') {
    await Transaction.updateOne(
      { _id: payment.transactionId },
      { $set: { status: 'incomplete_deposit' } },
    );
  }
  return payment;
}

export async function handleSuccessfulSettlement(payment: IPaymentAttempt): Promise<void> {
  if (payment.budgetReservationActive) {
    const claimed = await PaymentAttempt.findOneAndUpdate(
      { _id: payment._id, status: 'SUCCESS', budgetReservationActive: true },
      { $set: { budgetReservationActive: false } },
      { new: true },
    );
    if (claimed) {
      try {
        await settlePaymentBudget({
          userId: payment.userId.toString(),
          budgetId: payment.budgetId.toString(),
          amountMicros: payment.budgetDebitMicros,
          reservedMicros: payment.budgetReservationMicros,
        });
      } catch (error) {
        await PaymentAttempt.updateOne(
          { _id: payment._id, status: 'SUCCESS' },
          { $set: { budgetReservationActive: true } },
        );
        throw error;
      }
      payment.budgetReservationActive = false;
    }
  }
  await Promise.all([
    Transaction.updateOne(
      { _id: payment.transactionId },
      {
        $set: {
          status: 'confirmed',
          txHash: payment.sourceTransactionHash,
          'metadata.destinationTransactionHash': payment.destinationTransactionHash,
        },
      },
    ),
    Quote.updateOne(
      { _id: payment.quoteId },
      { $set: { status: 'paid', paymentEligibility: 'settled' } },
    ),
  ]);
}

export async function handleRefundedSettlement(payment: IPaymentAttempt): Promise<void> {
  await Transaction.updateOne({ _id: payment.transactionId }, { $set: { status: 'refunded' } });
  await releaseReservation(payment);
  await Quote.updateOne(
    { _id: payment.quoteId, activePaymentAttemptId: payment._id },
    {
      $unset: { activePaymentAttemptId: 1 },
      $set: { paymentEligibility: 'invoice_required' },
    },
  );
}

export async function handleFailedSettlement(payment: IPaymentAttempt): Promise<void> {
  await Transaction.updateOne(
    { _id: payment.transactionId },
    {
      $set: {
        status: 'failed',
        'metadata.errorCode': payment.errorCode,
        'metadata.errorMessage': payment.errorMessage,
      },
    },
  );
}

async function releaseReservation(payment: IPaymentAttempt): Promise<void> {
  if (!payment.budgetReservationActive) return;
  const claimed = await PaymentAttempt.findOneAndUpdate(
    { _id: payment._id, budgetReservationActive: true },
    { $set: { budgetReservationActive: false } },
    { new: true },
  );
  if (!claimed) return;
  try {
    await releasePaymentBudget({
      userId: payment.userId.toString(),
      budgetId: payment.budgetId.toString(),
      amountMicros: payment.budgetReservationMicros,
    });
  } catch (error) {
    await PaymentAttempt.updateOne(
      { _id: payment._id },
      { $set: { budgetReservationActive: true } },
    );
    throw error;
  }
  payment.budgetReservationActive = false;
}

async function transition(
  payment: IPaymentAttempt,
  next: PaymentAttemptStatus,
  errorCode?: string,
  errorMessage?: string,
): Promise<void> {
  if (payment.status === next) return;
  assertPaymentTransition(payment.status, next);
  const update: Record<string, unknown> = {
    status: next,
    nearIntentsStatus: payment.nearIntentsStatus,
    nearIntentsResponse: payment.nearIntentsResponse,
    destinationTransactionHash: payment.destinationTransactionHash,
    ...(errorCode && { errorCode }),
    ...(errorMessage && { errorMessage }),
    ...(next === 'SUCCESS' && { settledAt: new Date() }),
    ...(next === 'SUCCESS' && { fulfillmentStatus: 'not_configured' }),
  };
  const updated = await PaymentAttempt.findOneAndUpdate(
    { _id: payment._id, status: payment.status },
    { $set: update },
    { new: true },
  );
  if (!updated) {
    const current = await PaymentAttempt.findById(payment._id);
    if (current?.status === next) return;
    throw Object.assign(new Error('Payment state changed concurrently'), {
      code: 'PAYMENT_STATE_CONFLICT',
      statusCode: 409,
    });
  }
  payment.status = next;
  payment.nearIntentsStatus = updated.nearIntentsStatus;
  payment.destinationTransactionHash = updated.destinationTransactionHash;
  if (next === 'SUCCESS') payment.settledAt = new Date();
  if (next === 'SOURCE_TX_CONFIRMED') {
    payment.sourceTransactionStatus = 'confirmed';
    await PaymentAttempt.updateOne({ _id: payment._id }, { $set: { sourceTransactionStatus: 'confirmed' } });
  }
  if (payment.transactionId) {
    const txStatus =
      next === 'PROCESSING' || next === 'SOURCE_TX_CONFIRMED'
        ? next === 'PROCESSING'
          ? 'processing'
          : 'source_confirmed'
        : next === 'FAILED'
          ? 'failed'
          : undefined;
    if (txStatus) await Transaction.updateOne({ _id: payment.transactionId }, { $set: { status: txStatus } });
  }
}

async function resolveWalletAddress(userId: string): Promise<string> {
  const { User } = await import('../models/User.js');
  const user = await User.findById(userId).select('walletAddress').lean();
  if (!user?.walletAddress) {
    throw Object.assign(new Error('Payment wallet not found'), { code: 'WALLET_NOT_FOUND', statusCode: 404 });
  }
  return user.walletAddress;
}
