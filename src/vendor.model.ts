import mongoose, { Schema, type Document } from 'mongoose';

export type VendorVerificationStatus =
  | 'verified'
  | 'corroborated'
  | 'unverified'
  | 'contradicted'
  | 'unavailable';

export interface IVendorEvidence {
  source: string;
  url?: string;
  collectedAt: Date;
  status: VendorVerificationStatus;
  summary: string;
}

export interface IVendor extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  website?: string;
  domain?: string;
  description?: string;
  location?: string;
  contact?: {
    email?: string;
    phone?: string;
    address?: string;
  };
  categories: string[];
  products: string[];
  pricing?: {
    currency?: string;
    typicalPrice?: number;
    notes?: string;
  };
  shipping?: {
    countries?: string[];
    notes?: string;
  };
  refundPolicy?: string;
  paymentMethods: string[];
  verificationStatus: VendorVerificationStatus;
  reliabilityScore: number;
  evidence: IVendorEvidence[];
  verifiedAt?: Date | null;
  lastReviewedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const vendorEvidenceSchema = new Schema<IVendorEvidence>(
  {
    source: { type: String, required: true, trim: true },
    url: { type: String, trim: true },
    collectedAt: { type: Date, required: true, default: Date.now },
    status: {
      type: String,
      enum: ['verified', 'corroborated', 'unverified', 'contradicted', 'unavailable'],
      required: true,
    },
    summary: { type: String, required: true },
  },
  { _id: false },
);

const vendorSchema = new Schema<IVendor>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    website: { type: String, trim: true },
    domain: { type: String, trim: true },
    description: { type: String, trim: true },
    location: { type: String, trim: true },
    contact: {
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      address: { type: String, trim: true },
    },
    categories: [{ type: String, trim: true }],
    products: [{ type: String, trim: true }],
    pricing: {
      currency: { type: String, trim: true, uppercase: true },
      typicalPrice: { type: Number, min: 0 },
      notes: { type: String, trim: true },
    },
    shipping: {
      countries: [{ type: String, trim: true }],
      notes: { type: String, trim: true },
    },
    refundPolicy: { type: String, trim: true },
    paymentMethods: [{ type: String, trim: true }],
    verificationStatus: {
      type: String,
      enum: ['verified', 'corroborated', 'unverified', 'contradicted', 'unavailable'],
      default: 'unverified',
      index: true,
    },
    reliabilityScore: { type: Number, default: 0, min: 0, max: 100 },
    evidence: [vendorEvidenceSchema],
    verifiedAt: { type: Date, default: null },
    lastReviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

vendorSchema.index({ domain: 1, userId: 1 }, { unique: true, sparse: true });

export const Vendor = mongoose.model<IVendor>('Vendor', vendorSchema);
