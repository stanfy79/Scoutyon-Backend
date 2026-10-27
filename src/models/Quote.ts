import mongoose, { Schema, Document } from 'mongoose';

export type QuoteStatus = 'pending' | 'approved' | 'rejected' | 'paid' | 'failed';

export interface IQuote extends Document {
  sessionId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  budgetId?: mongoose.Types.ObjectId;
  provider: string;
  description: string;
  price: number;
  currency: string;
  sourceUrl: string;
  status: QuoteStatus;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const quoteSchema = new Schema<IQuote>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    budgetId: { type: Schema.Types.ObjectId, ref: 'Budget' },
    provider: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    sourceUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'paid', 'failed'],
      default: 'pending',
    },
    rejectionReason: { type: String },
  },
  { timestamps: true },
);

export const Quote = mongoose.model<IQuote>('Quote', quoteSchema);
