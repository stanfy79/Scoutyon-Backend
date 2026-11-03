import mongoose, { Schema, Document } from 'mongoose';

export type TxStatus = 'simulated' | 'pending' | 'confirmed' | 'failed';

export interface ITransaction extends Document {
  quoteId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  provider: string;
  amount: number;
  currency: string;
  nearIntentId?: string;
  txHash?: string;
  status: TxStatus;
  simulated: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const transactionSchema = new Schema<ITransaction>(
  {
    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    nearIntentId: { type: String },
    txHash: { type: String },
    status: {
      type: String,
      enum: ['simulated', 'pending', 'confirmed', 'failed'],
      default: 'simulated',
    },
    simulated: { type: Boolean, default: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export const Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);
