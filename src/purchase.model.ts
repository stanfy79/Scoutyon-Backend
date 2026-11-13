import mongoose, { Schema, type Document } from 'mongoose';

export type PurchaseStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'paid'
  | 'fulfilled'
  | 'failed';

export interface IPurchaseActivity {
  type: string;
  message: string;
  createdAt: Date;
}

export interface IPurchase extends Document {
  userId: mongoose.Types.ObjectId;
  budgetId: mongoose.Types.ObjectId;
  vendorId?: mongoose.Types.ObjectId | null;
  vendorName?: string;
  quoteId?: mongoose.Types.ObjectId | null;
  title: string;
  description: string;
  category?: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  amount: number;
  justification?: string;
  status: PurchaseStatus;
  paymentAttemptId?: mongoose.Types.ObjectId | null;
  fulfillmentStatus?: 'pending' | 'fulfilled' | 'failed';
  activity: IPurchaseActivity[];
  approvedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const purchaseActivitySchema = new Schema<IPurchaseActivity>(
  {
    type: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const purchaseSchema = new Schema<IPurchase>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    budgetId: { type: Schema.Types.ObjectId, ref: 'Budget', required: true, index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', default: null },
    vendorName: { type: String, trim: true },
    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote', default: null },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    category: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true },
    amount: { type: Number, required: true, min: 0 },
    justification: { type: String, trim: true },
    status: {
      type: String,
      enum: ['draft', 'submitted', 'approved', 'rejected', 'cancelled', 'paid', 'fulfilled', 'failed'],
      default: 'draft',
      index: true,
    },
    paymentAttemptId: { type: Schema.Types.ObjectId, ref: 'PaymentAttempt', default: null },
    fulfillmentStatus: {
      type: String,
      enum: ['pending', 'fulfilled', 'failed'],
      default: 'pending',
    },
    activity: [purchaseActivitySchema],
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const Purchase = mongoose.model<IPurchase>('Purchase', purchaseSchema);
