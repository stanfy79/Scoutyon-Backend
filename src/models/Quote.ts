import mongoose, { Schema, Document } from 'mongoose';

export type QuoteStatus = 'pending' | 'approved' | 'rejected' | 'paid' | 'failed';
export type QuotePaymentEligibility =
  | 'unsupported'
  | 'verification_required'
  | 'invoice_required'
  | 'payment_prepared'
  | 'settled';

export interface IQuote extends Document {
  sessionId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  budgetId?: mongoose.Types.ObjectId;
  provider: string;
  description: string;
  price: number;
  currency: string;
  sourceUrl: string;
  paymentInvoice?: {
    invoiceId: string;
    assetId: string;
    amountAtomic: string;
    verifiedAt: Date;
    source: 'official_api' | 'official_invoice';
  } | null;
  activePaymentAttemptId?: mongoose.Types.ObjectId | null;
  paymentEligibility: QuotePaymentEligibility;
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
    paymentInvoice: {
      invoiceId: { type: String, trim: true },
      assetId: { type: String, trim: true },
      amountAtomic: { type: String, match: /^\d+$/ },
      verifiedAt: { type: Date },
      source: { type: String, enum: ['official_api', 'official_invoice'] },
    },
    activePaymentAttemptId: { type: Schema.Types.ObjectId, ref: 'PaymentAttempt', default: null },
    paymentEligibility: {
      type: String,
      enum: ['unsupported', 'verification_required', 'invoice_required', 'payment_prepared', 'settled'],
      default: 'unsupported',
      index: true,
    },
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
