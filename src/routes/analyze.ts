import { Router, type Request, type Response } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /analyze - Alias for /api/scan with same logic
router.post('/analyze', upload.single('image'), async (req: Request, res: Response) => {
  const file = req.file as Express.Multer.File | undefined; // provisto por @types/multer
  const base64 = typeof req.body?.image === 'string' ? req.body.image : undefined;

  if (!file && !base64) {
    return res.status(400).json({ error: 'No image provided' });
  }

  // Check if device can perform scan (same logic as /api/scan)
  const { getEntitlementByDevice, canPerformScan, incrementScanUsage } = require('../lib/entitlement');
  
  const deviceId = (req as any).deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID required' });
  }

  const { canScan, reason } = await canPerformScan(deviceId);
  
  if (!canScan) {
    return res.status(402).json({ 
      requirePaywall: true, 
      reason: reason || 'limit_exceeded' 
    });
  }
  
  // If this is a free scan (not premium), increment usage
  const entitlement = await getEntitlementByDevice(deviceId);
  if (!entitlement.active) {
    await incrementScanUsage(deviceId);
  }

  // TODO: lógica de análisis
  return res.json({ ok: true });
});

export default router;
