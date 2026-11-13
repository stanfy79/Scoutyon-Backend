import mongoose, { Schema, type Document } from 'mongoose';

export type DiscoveryStatus = 'pending' | 'completed' | 'failed' | 'no_results';

export interface IDiscoveryResult {
  vendorId?: mongoose.Types.ObjectId;
  name: string;
  domain?: string;
  website?: string;
  summary?: string;
  reliabilityScore?: number;
  verificationStatus?: string;
}

export interface IVendorDiscovery extends Document {
  userId: mongoose.Types.ObjectId;
  requirement: string;
  category?: string;
  keywords: string[];
  budget?: {
    currency?: string;
    minimum?: number;
    maximum?: number;
  };
  location?: string;
  specifications: string[];
  preferredCharacteristics: string[];
  constraints: string[];
  candidates: string[];
  status: DiscoveryStatus;
  results: IDiscoveryResult[];
  createdAt: Date;
  updatedAt: Date;
}

const discoveryResultSchema = new Schema<IDiscoveryResult>(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    name: { type: String, required: true, trim: true },
    domain: { type: String, trim: true },
    website: { type: String, trim: true },
    summary: { type: String, trim: true },
    reliabilityScore: { type: Number, min: 0, max: 100 },
    verificationStatus: { type: String, trim: true },
  },
  { _id: false },
);

const vendorDiscoverySchema = new Schema<IVendorDiscovery>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requirement: { type: String, required: true, trim: true },
    category: { type: String, trim: true },
    keywords: [{ type: String, trim: true }],
    budget: {
      currency: { type: String, trim: true, uppercase: true },
      minimum: { type: Number, min: 0 },
      maximum: { type: Number, min: 0 },
    },
    location: { type: String, trim: true },
    specifications: [{ type: String, trim: true }],
    preferredCharacteristics: [{ type: String, trim: true }],
    constraints: [{ type: String, trim: true }],
    candidates: [{ type: String, trim: true }],
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'no_results'],
      default: 'pending',
      index: true,
    },
    results: [discoveryResultSchema],
  },
  { timestamps: true },
);

export const VendorDiscovery = mongoose.model<IVendorDiscovery>('VendorDiscovery', vendorDiscoverySchema);
