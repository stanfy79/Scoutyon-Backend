import { fetchPage } from './services/webFetcher.js';
import { Vendor, type IVendor, type IVendorEvidence } from './vendor.model.js';
import { VendorDiscovery, type IDiscoveryResult } from './vendorDiscovery.model.js';

export interface VendorDiscoveryRequest {
  requirement: string;
  category?: string;
  keywords?: string[];
  budget?: { currency?: string; minimum?: number; maximum?: number };
  location?: string;
  specifications?: string[];
  preferredCharacteristics?: string[];
  constraints?: string[];
  candidateUrls?: string[];
}

export function normalizeVendorInput(name: string, website?: string): { name: string; domain?: string } {
  const normalized = name.trim();
  const parsed = website ? new URL(website) : null;
  return {
    name: normalized,
    domain: parsed?.hostname?.replace(/^www\./i, '') ?? undefined,
  };
}

export function assessVendorEvidence(evidence: IVendorEvidence[]): { status: IVendorEvidence['status']; reliabilityScore: number; summary: string } {
  if (!evidence.length) {
    return { status: 'unavailable', reliabilityScore: 0, summary: 'No evidence was collected for this vendor.' };
  }

  const contradictions = evidence.filter((entry) => entry.status === 'contradicted').length;
  if (contradictions > 0) {
    return {
      status: 'contradicted',
      reliabilityScore: 10,
      summary: 'At least one evidence source conflicts with the vendor profile.',
    };
  }

  const corroborated = evidence.filter((entry) => entry.status === 'corroborated').length;
  const verified = evidence.filter((entry) => entry.status === 'verified').length;
  const score = Math.min(100, 10 + verified * 30 + corroborated * 15);

  if (verified > 0) {
    return {
      status: 'verified',
      reliabilityScore: score,
      summary: 'The vendor has verified, corroborated evidence from trusted sources.',
    };
  }

  if (corroborated > 0) {
    return {
      status: 'corroborated',
      reliabilityScore: score,
      summary: 'The vendor is supported by multiple corroborating sources but not fully verified.',
    };
  }

  return {
    status: 'unverified',
    reliabilityScore: score,
    summary: 'The vendor has some evidence, but it is insufficient for a verified status.',
  };
}

export async function fetchVendorEvidence(rawUrl: string): Promise<IVendorEvidence> {
  const page = await fetchPage(rawUrl);
  const text = page.text.replace(/\s+/g, ' ').trim();
  const summary = text.length > 240 ? `${text.slice(0, 240)}...` : text;
  return {
    source: 'website',
    url: page.url,
    collectedAt: new Date(),
    status: 'corroborated',
    summary,
  };
}

export async function discoverVendorsForUser(userId: string, request: VendorDiscoveryRequest): Promise<{ discovery: any; vendors: IVendor[] }> {
  const discovery = await VendorDiscovery.create({
    userId,
    requirement: request.requirement,
    category: request.category,
    keywords: request.keywords ?? [],
    budget: request.budget,
    location: request.location,
    specifications: request.specifications ?? [],
    preferredCharacteristics: request.preferredCharacteristics ?? [],
    constraints: request.constraints ?? [],
    candidates: request.candidateUrls ?? [],
    status: 'pending',
    results: [],
  });

  if (!request.candidateUrls || request.candidateUrls.length === 0) {
    discovery.status = 'no_results';
    await discovery.save();
    return { discovery: discovery.toObject(), vendors: [] };
  }

  const vendors: IVendor[] = [];
  const results: IDiscoveryResult[] = [];

  for (const candidate of request.candidateUrls) {
    try {
      const evidence = await fetchVendorEvidence(candidate);
      const { name, domain } = normalizeVendorInput(candidate, candidate);
      const vendorRecord = await Vendor.findOneAndUpdate(
        { userId, domain: domain ?? name },
        {
          $setOnInsert: { userId, name, domain, website: candidate, evidence: [] },
          $push: { evidence },
          $set: { lastReviewedAt: new Date() },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      const vendorAssessment = assessVendorEvidence(vendorRecord.evidence);
      vendorRecord.verificationStatus = vendorAssessment.status;
      vendorRecord.reliabilityScore = vendorAssessment.reliabilityScore;
      vendorRecord.lastReviewedAt = new Date();
      vendorRecord.description ??= `Discovered candidate for: ${request.requirement}`;
      await vendorRecord.save();
      vendors.push(vendorRecord);
      results.push({
        vendorId: vendorRecord._id,
        name: vendorRecord.name,
        domain: vendorRecord.domain,
        website: vendorRecord.website,
        summary: vendorAssessment.summary,
        reliabilityScore: vendorAssessment.reliabilityScore,
        verificationStatus: vendorAssessment.status,
      });
    } catch {
      results.push({
        name: 'Unavailable vendor',
        website: candidate,
        summary: 'No reliable content could be extracted from the supplied source.',
        verificationStatus: 'unavailable',
      });
    }
  }

  discovery.results = results;
  discovery.status = results.length > 0 ? 'completed' : 'no_results';
  await discovery.save();

  return { discovery: discovery.toObject(), vendors };
}

export async function getVendorById(userId: string, vendorId: string): Promise<IVendor | null> {
  return Vendor.findOne({ _id: vendorId, userId }).lean() as unknown as Promise<IVendor | null>;
}

export async function listVendorsForUser(userId: string): Promise<IVendor[]> {
  return Vendor.find({ userId }).sort({ createdAt: -1 }).lean() as unknown as Promise<IVendor[]>;
}

export async function refreshVendorRecord(userId: string, vendorId: string): Promise<IVendor | null> {
  const vendor = await Vendor.findOne({ _id: vendorId, userId });
  if (!vendor) return null;

  if (vendor.website) {
    const evidence = await fetchVendorEvidence(vendor.website);
    vendor.evidence.push(evidence);
  }

  const assessment = assessVendorEvidence(vendor.evidence);
  vendor.verificationStatus = assessment.status;
  vendor.reliabilityScore = assessment.reliabilityScore;
  vendor.lastReviewedAt = new Date();
  vendor.verifiedAt = assessment.status === 'verified' ? new Date() : vendor.verifiedAt ?? null;
  await vendor.save();
  return vendor;
}

export async function verifyVendor(userId: string, vendorId: string): Promise<IVendor | null> {
  const vendor = await Vendor.findOne({ _id: vendorId, userId });
  if (!vendor) return null;
  const assessment = assessVendorEvidence(vendor.evidence);
  vendor.verificationStatus = assessment.status;
  vendor.reliabilityScore = assessment.reliabilityScore;
  vendor.lastReviewedAt = new Date();
  vendor.verifiedAt = new Date();
  await vendor.save();
  return vendor;
}
