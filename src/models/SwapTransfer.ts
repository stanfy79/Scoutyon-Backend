import mongoose, { Schema, Document } from 'mongoose';

export type SwapTransferStatus =
  | 'preparing'
  | 'preparation_unknown'
  | 'pending_authorization'
  | 'authorized'
  | 'deposit_submitted'
  | 'processing'
  | 'success'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'incomplete_deposit';

export interface ISwapTransfer extends Document {
  userId: mongoose.Types.ObjectId;
  sessionId: mongoose.Types.ObjectId;
  previewId: mongoose.Types.ObjectId;
  idempotencyKey: string;
  status: SwapTransferStatus;
  quoteCorrelationId: string | null;
  providerQuote: Record<string, unknown> | null;
  depositAddress: string | null;
  depositMemo: string | null;
  sourceAssetId: string;
  sourceSymbol: string;
  sourceBlockchain: string;
  sourceDecimals: number;
  sourceChainId: number;
  sourceTokenAddress: string;
  walletId: string;
  walletAddress: string;
  signerId: string | null;
  signerPolicyId: string | null;
  destinationAssetId: string;
  destinationSymbol: string;
  destinationBlockchain: string;
  destinationDecimals: number;
  recipient: string;
  refundTo: string;
  amountIn: string;
  amountOut: string | null;
  minAmountOut: string | null;
  quoteDeadline: Date | null;
  sourceTransactionHash: string | null;
  destinationTransactionHash: string | null;
  destinationExplorerUrl: string | null;
  providerStatus: string | null;
  providerResponse: Record<string, unknown> | null;
  depositedAmount: string | null;
  receivedAmount: string | null;
  refundAmount: string | null;
  authorizationIssuedAt: Date | null;
  depositNotifiedAt: Date | null;
  statusUpdatedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const swapTransferSchema = new Schema<ISwapTransfer>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    previewId: { type: Schema.Types.ObjectId, ref: 'SwapQuote', required: true, unique: true },
    idempotencyKey: { type: String, required: true, unique: true },
    status: {
      type: String,
      required: true,
      enum: [
        'preparing',
        'preparation_unknown',
        'pending_authorization',
        'authorized',
        'deposit_submitted',
        'processing',
        'success',
        'failed',
        'expired',
        'refunded',
        'incomplete_deposit',
      ],
      index: true,
    },
    quoteCorrelationId: { type: String, default: null },
    providerQuote: { type: Schema.Types.Mixed, default: null },
    depositAddress: { type: String, default: null },
    depositMemo: { type: String, default: null },
    sourceAssetId: { type: String, required: true },
    sourceSymbol: { type: String, required: true },
    sourceBlockchain: { type: String, required: true },
    sourceDecimals: { type: Number, required: true },
    sourceChainId: { type: Number, required: true },
    sourceTokenAddress: { type: String, required: true },
    walletId: { type: String, required: true },
    walletAddress: { type: String, required: true },
    signerId: { type: String, default: null },
    signerPolicyId: { type: String, default: null },
    destinationAssetId: { type: String, required: true },
    destinationSymbol: { type: String, required: true },
    destinationBlockchain: { type: String, required: true },
    destinationDecimals: { type: Number, required: true },
    recipient: { type: String, required: true },
    refundTo: { type: String, required: true },
    amountIn: { type: String, required: true, match: /^\d+$/ },
    amountOut: { type: String, default: null, match: /^\d+$/ },
    minAmountOut: { type: String, default: null, match: /^\d+$/ },
    quoteDeadline: { type: Date, default: null },
    sourceTransactionHash: { type: String, default: null },
    destinationTransactionHash: { type: String, default: null },
    destinationExplorerUrl: { type: String, default: null },
    providerStatus: { type: String, default: null },
    providerResponse: { type: Schema.Types.Mixed, default: null },
    depositedAmount: { type: String, default: null },
    receivedAmount: { type: String, default: null },
    refundAmount: { type: String, default: null },
    authorizationIssuedAt: { type: Date, default: null },
    depositNotifiedAt: { type: Date, default: null },
    statusUpdatedAt: { type: Date, default: null },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true },
);

swapTransferSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });
swapTransferSchema.index(
  { sourceTransactionHash: 1 },
  { unique: true, partialFilterExpression: { sourceTransactionHash: { $type: 'string' } } },
);

export const SwapTransfer = mongoose.model<ISwapTransfer>('SwapTransfer', swapTransferSchema);
