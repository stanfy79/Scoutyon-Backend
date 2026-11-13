import { MerchantPaymentProfile, type IMerchantPaymentProfile } from '../models/MerchantPaymentProfile.js';

export function normalizeProviderId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function inspectMerchantPaymentProfile(providerName: string): Promise<{
  profile: IMerchantPaymentProfile | null;
  eligibility: 'unsupported' | 'verification_required' | 'invoice_required';
}> {
  const profile = await MerchantPaymentProfile.findOne({
    providerId: normalizeProviderId(providerName),
  });
  if (!profile) return { profile: null, eligibility: 'unsupported' };
  if (
    !profile.enabled ||
    !profile.verified ||
    profile.verificationStatus !== 'verified' ||
    !profile.addressVerifiedAt ||
    profile.addressVerifiedAt.getTime() > Date.now() ||
    Date.now() - profile.addressVerifiedAt.getTime() > 365 * 24 * 60 * 60 * 1000
  ) {
    return { profile, eligibility: 'verification_required' };
  }
  return { profile, eligibility: 'invoice_required' };
}
