import mongoose, { Schema, Document } from 'mongoose';

export interface IBudget extends Document {
  userId: mongoose.Types.ObjectId;
  label: string;
  totalLimit: number;
  spent: number;
  currency: string;
  active: boolean;
  approvedRecipients: string[];
  createdAt: Date;
  updatedAt: Date;
}

const budgetSchema = new Schema<IBudget>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, required: true, trim: true },
    totalLimit: { type: Number, required: true, min: 0 },
    spent: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    active: { type: Boolean, default: true },
    approvedRecipients: [{ type: String, trim: true }],
  },
  { timestamps: true },
);

export const Budget = mongoose.model<IBudget>('Budget', budgetSchema);
