import mongoose, { Schema, Document } from 'mongoose';

export interface ISwapQuote extends Document {
  userId: mongoose.Types.ObjectId;
  sessionId: mongoose.Types.ObjectId;
  correlationId: string;
  sourceAssetId: string;
  sourceSymbol: string;
  sourceBlockchain: string;
  sourceDecimals: number;
  destinationAssetId: string;
  destinationSymbol: string;
  destinationBlockchain: string;
  destinationDecimals: number;
  amountIn: string;
  requestedAmount: string;
  amountInFormatted: string | null;
  amountOut: string;
  amountOutFormatted: string | null;
  minAmountOut: string | null;
  recipient: string;
  refundTo: string;
  expiresAt: Date | null;
  timeEstimateSeconds: number | null;
  slippageTolerance: number;
  providerResponse: Record<string, unknown> | null;
  status: 'preview' | 'prepared' | 'expired';
  createdAt: Date;
  updatedAt: Date;
}

const swapQuoteSchema = new Schema<ISwapQuote>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    correlationId: { type: String, required: true },
    sourceAssetId: { type: String, required: true },
    sourceSymbol: { type: String, required: true },
    sourceBlockchain: { type: String, required: true },
    sourceDecimals: { type: Number, required: true },
    destinationAssetId: { type: String, required: true },
    destinationSymbol: { type: String, required: true },
    destinationBlockchain: { type: String, required: true },
    destinationDecimals: { type: Number, required: true },
    amountIn: { type: String, required: true, match: /^\d+$/ },
    requestedAmount: { type: String, required: true },
    amountInFormatted: { type: String, default: null },
    amountOut: { type: String, required: true, match: /^\d+$/ },
    amountOutFormatted: { type: String, default: null },
    minAmountOut: { type: String, default: null, match: /^\d+$/ },
    recipient: { type: String, required: true },
    refundTo: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    timeEstimateSeconds: { type: Number, default: null },
    slippageTolerance: { type: Number, required: true },
    providerResponse: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: ['preview', 'prepared', 'expired'], default: 'preview', index: true },
  },
  { timestamps: true },
);

swapQuoteSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });

export const SwapQuote = mongoose.model<ISwapQuote>('SwapQuote', swapQuoteSchema);
