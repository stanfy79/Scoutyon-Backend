import mongoose, { Schema, Document } from 'mongoose';

export type WalletProvisioningStatus = 'pending' | 'completed' | 'failed';
export type AccountStatus = 'active' | 'suspended';

export interface IUser extends Document {
  // Privy identity
  privyUserId: string;
  email: string;
  emailVerifiedAt: Date | null;

  // Embedded Ethereum wallet
  walletId: string | null;
  walletAddress: string | null;
  walletChainType: string | null;
  walletProvisioningStatus: WalletProvisioningStatus;

  // Status & Timestamps
  accountStatus: AccountStatus;
  lastLoginAt: Date;

  // Legacy field preserved for migration backwards compatibility
  name?: string;

  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    privyUserId: { type: String, unique: true, sparse: true, index: true },
    email: { type: String, trim: true, lowercase: true, index: true },
    emailVerifiedAt: { type: Date, default: null },

    walletId: { type: String, default: null },
    walletAddress: { type: String, default: null },
    walletChainType: { type: String, default: 'ethereum' },
    walletProvisioningStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
    },

    accountStatus: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
    },
    lastLoginAt: { type: Date, default: Date.now },

    // Legacy fields
    name: { type: String, trim: true },
  },
  { timestamps: true },
);

export const User = mongoose.model<IUser>('User', userSchema);
