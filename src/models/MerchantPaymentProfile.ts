import mongoose, { Schema, Document } from 'mongoose';

export interface IMerchantPaymentProfile extends Document {
  providerId: string;
  providerName: string;
  enabled: boolean;
  verified: boolean;
  verificationSource: string;
  officialWebsite: string;
  paymentDocumentationUrl: string;
  destinationBlockchain: string;
  destinationAssetId: string;
  destinationWalletAddress: string;
  acceptedPaymentToken: string;
  addressVerifiedAt: Date | null;
  verificationStatus: 'pending' | 'verified' | 'revoked';
  invoiceIntegration?: { provider: string; enabled: boolean } | null;
  fulfillmentIntegration?: { provider: string; enabled: boolean } | null;
  createdAt: Date;
  updatedAt: Date;
}

const merchantPaymentProfileSchema = new Schema<IMerchantPaymentProfile>(
  {
    providerId: { type: String, required: true, trim: true, unique: true, index: true },
    providerName: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: false, index: true },
    verified: { type: Boolean, default: false },
    verificationSource: { type: String, required: true },
    officialWebsite: { type: String, required: true, match: /^https:\/\/.+/ },
    paymentDocumentationUrl: { type: String, required: true, match: /^https:\/\/.+/ },
    destinationBlockchain: { type: String, required: true },
    destinationAssetId: { type: String, required: true },
    destinationWalletAddress: { type: String, required: true },
    acceptedPaymentToken: { type: String, required: true },
    addressVerifiedAt: { type: Date, default: null },
    verificationStatus: {
      type: String,
      enum: ['pending', 'verified', 'revoked'],
      default: 'pending',
      index: true,
    },
    invoiceIntegration: {
      provider: { type: String, trim: true },
      enabled: { type: Boolean, default: false },
    },
    fulfillmentIntegration: {
      provider: { type: String, trim: true },
      enabled: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

merchantPaymentProfileSchema.index({ providerName: 1, enabled: 1, verified: 1 });

export const MerchantPaymentProfile = mongoose.model<IMerchantPaymentProfile>(
  'MerchantPaymentProfile',
  merchantPaymentProfileSchema,
);
