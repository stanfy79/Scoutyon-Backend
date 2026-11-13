import mongoose, { Schema, Document } from 'mongoose';

export type PaymentAttemptStatus =
  | 'PREPARING'
  | 'AWAITING_USER_CONFIRMATION'
  | 'SUBMITTING'
  | 'SOURCE_TX_SUBMITTED'
  | 'SOURCE_TX_CONFIRMED'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED'
  | 'INCOMPLETE_DEPOSIT'
  | 'EXPIRED'
  | 'SUBMISSION_UNKNOWN'
  | 'REQUIRES_MANUAL_REVIEW';

export interface IPaymentAttempt extends Document {
  userId: mongoose.Types.ObjectId;
  quoteId: mongoose.Types.ObjectId;
  status: PaymentAttemptStatus;
  originAssetId: string;
  originBlockchain: string;
  originChainId: number;
  originCaip2: string;
  originTokenAddress: string;
  originTokenSymbol: string;
  originTokenDecimals: number;
  destinationAssetId: string;
  destinationBlockchain: string;
  destinationRecipient: string;
  destinationTokenSymbol: string;
  destinationTokenDecimals: number;
  depositAddress: string;
  depositMemo: string | null;
  refundAddress: string;
  amountIn: string;
  minAmountIn: string | null;
  maxAmountIn: string | null;
  amountOut: string;
  quoteCorrelationId: string;
  quoteDeadline: Date;
  slippageTolerance: number;
  privyWalletId: string;
  privyWalletActionId: string | null;
  sourceTransactionHash: string | null;
  sourceTransactionStatus: string | null;
  nearIntentsStatus: string | null;
  nearIntentsResponse: Record<string, unknown> | null;
  destinationTransactionHash: string | null;
  approvedAt: Date | null;
  confirmedAt: Date | null;
  settledAt: Date | null;
  idempotencyKey: string;
  fulfillmentStatus: 'not_configured' | 'pending' | 'fulfilled' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  simulation: boolean;
  merchantProfileId: mongoose.Types.ObjectId;
  merchantInvoiceId: string;
  merchantInvoiceSource: 'official_api' | 'official_invoice';
  merchantInvoiceVerifiedAt: Date;
  transactionId: mongoose.Types.ObjectId | null;
  budgetId: mongoose.Types.ObjectId;
  budgetDebitMicros: string;
  budgetReservationMicros: string;
  budgetReservationActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const paymentAttemptSchema = new Schema<IPaymentAttempt>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote', required: true },
    status: {
      type: String,
      required: true,
      enum: [
        'PREPARING',
        'AWAITING_USER_CONFIRMATION',
        'SUBMITTING',
        'SOURCE_TX_SUBMITTED',
        'SOURCE_TX_CONFIRMED',
        'PROCESSING',
        'SUCCESS',
        'REFUNDED',
        'FAILED',
        'INCOMPLETE_DEPOSIT',
        'EXPIRED',
        'SUBMISSION_UNKNOWN',
        'REQUIRES_MANUAL_REVIEW',
      ],
      index: true,
    },
    originAssetId: { type: String, required: true },
    originBlockchain: { type: String, required: true },
    originChainId: { type: Number, required: true },
    originCaip2: { type: String, required: true },
    originTokenAddress: { type: String, required: true },
    originTokenSymbol: { type: String, required: true },
    originTokenDecimals: { type: Number, required: true },
    destinationAssetId: { type: String, required: true },
    destinationBlockchain: { type: String, required: true },
    destinationRecipient: { type: String, required: true },
    destinationTokenSymbol: { type: String, required: true },
    destinationTokenDecimals: { type: Number, required: true },
    depositAddress: { type: String, required: true },
    depositMemo: { type: String, default: null },
    refundAddress: { type: String, required: true },
    amountIn: { type: String, required: true, match: /^\d+$/ },
    minAmountIn: { type: String, default: null, match: /^\d+$/ },
    maxAmountIn: { type: String, default: null, match: /^\d+$/ },
    amountOut: { type: String, required: true, match: /^\d+$/ },
    quoteCorrelationId: { type: String, required: true },
    quoteDeadline: { type: Date, required: true },
    slippageTolerance: { type: Number, required: true },
    privyWalletId: { type: String, required: true },
    privyWalletActionId: { type: String, default: null },
    sourceTransactionHash: { type: String, default: null },
    sourceTransactionStatus: { type: String, default: null },
    nearIntentsStatus: { type: String, default: null },
    nearIntentsResponse: { type: Schema.Types.Mixed, default: null },
    destinationTransactionHash: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },
    idempotencyKey: { type: String, required: true, unique: true },
    fulfillmentStatus: {
      type: String,
      enum: ['not_configured', 'pending', 'fulfilled', 'failed'],
      default: 'not_configured',
    },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    simulation: { type: Boolean, required: true, default: false },
    merchantProfileId: { type: Schema.Types.ObjectId, ref: 'MerchantPaymentProfile', required: true },
    merchantInvoiceId: { type: String, required: true },
    merchantInvoiceSource: { type: String, enum: ['official_api', 'official_invoice'], required: true },
    merchantInvoiceVerifiedAt: { type: Date, required: true },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
    budgetId: { type: Schema.Types.ObjectId, ref: 'Budget', required: true },
    budgetDebitMicros: { type: String, required: true, match: /^\d+$/ },
    budgetReservationMicros: { type: String, required: true, match: /^\d+$/ },
    budgetReservationActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

paymentAttemptSchema.index({ userId: 1, createdAt: -1 });
paymentAttemptSchema.index({ quoteId: 1 });
paymentAttemptSchema.index({ depositAddress: 1 });
paymentAttemptSchema.index(
  { sourceTransactionHash: 1 },
  { unique: true, partialFilterExpression: { sourceTransactionHash: { $type: 'string' } } },
);

export const PaymentAttempt = mongoose.model<IPaymentAttempt>('PaymentAttempt', paymentAttemptSchema);
