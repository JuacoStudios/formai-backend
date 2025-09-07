import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Helper to extract image as Buffer (either multipart or JSON base64)
function extractImageBuffer(req: Request): Buffer | null {
  // multipart/form-data: single file field 'image'
  const file = (req as any).file as Express.Multer.File | undefined;
  if (file && file.buffer) return file.buffer;

  // JSON base64: { image: 'data:image/jpeg;base64,...' } or raw base64
  if (req.is('application/json') && (req.body?.image || req.body?.base64)) {
    const raw = (req.body.image || req.body.base64) as string;
    const b64 = raw.startsWith('data:') ? raw.split(',')[1] : raw;
    try { return Buffer.from(b64, 'base64'); } catch { return null; }
  }
  return null;
}

// POST /api/analyze
router.post('/analyze', upload.single('image'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const img = extractImageBuffer(req);
    if (!img) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing image', 
        message: 'Provide multipart field "image" or JSON { image: base64 }' 
      });
    }

    // TODO: plug your existing analysis service here.
    // For now, return a minimal stub so we can validate end-to-end:
    // Example: call analyzeEquipment(img) if such function exists.
    // const result = await analyzeEquipment(img);
    // return res.json({ success: true, result });

    return res.json({ success: true, result: 'analyze-stub-ok' });
  } catch (err) {
    next(err);
  }
});

export default router;
