import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from './middleware/auth.js';
import { discoverVendorsForUser, getVendorById, listVendorsForUser, refreshVendorRecord, verifyVendor } from './vendor.service.js';
import { Vendor } from './vendor.model.js';

const router = Router();
router.use(authMiddleware);

const vendorDiscoveryBody = z.object({
  requirement: z.string().min(1),
  category: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  budget: z.object({
    currency: z.string().optional(),
    minimum: z.number().nonnegative().optional(),
    maximum: z.number().nonnegative().optional(),
  }).optional(),
  location: z.string().optional(),
  specifications: z.array(z.string()).optional(),
  preferredCharacteristics: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  candidateUrls: z.array(z.string().url()).optional(),
});

router.post('/discover', async (req, res, next) => {
  try {
    const payload = vendorDiscoveryBody.parse(req.body);
    const result = await discoverVendorsForUser(req.userId!, payload);
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get('/discover/:discoveryId', async (req, res, next) => {
  try {
    const discovery = await import('./vendorDiscovery.model.js').then(({ VendorDiscovery }) =>
      VendorDiscovery.findOne({ _id: req.params.discoveryId, userId: req.userId }).lean(),
    );
    if (!discovery) {
      res.status(404).json({ error: 'Discovery not found' });
      return;
    }
    res.json({ success: true, discovery });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (_req, res, next) => {
  try {
    const vendors = await listVendorsForUser(_req.userId!);
    res.json({ success: true, vendors });
  } catch (error) {
    next(error);
  }
});

router.get('/:vendorId', async (req, res, next) => {
  try {
    const vendor = await getVendorById(req.userId!, req.params.vendorId);
    if (!vendor) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }
    res.json({ success: true, vendor });
  } catch (error) {
    next(error);
  }
});

router.post('/:vendorId/verify', async (req, res, next) => {
  try {
    const vendor = await verifyVendor(req.userId!, req.params.vendorId);
    if (!vendor) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }
    res.json({ success: true, vendor });
  } catch (error) {
    next(error);
  }
});

router.post('/:vendorId/refresh', async (req, res, next) => {
  try {
    const vendor = await refreshVendorRecord(req.userId!, req.params.vendorId);
    if (!vendor) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }
    res.json({ success: true, vendor });
  } catch (error) {
    next(error);
  }
});

router.get('/:vendorId/evidence', async (req, res, next) => {
  try {
    const vendor = await Vendor.findOne({ _id: req.params.vendorId, userId: req.userId }).select('evidence verificationStatus').lean();
    if (!vendor) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }
    res.json({ success: true, vendorId: req.params.vendorId, verificationStatus: vendor.verificationStatus, evidence: vendor.evidence ?? [] });
  } catch (error) {
    next(error);
  }
});

export default router;
