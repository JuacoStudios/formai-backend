import { Router, type Request, type Response } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/analyze', upload.single('image'), async (req: Request, res: Response) => {
  const file = req.file as Express.Multer.File | undefined;
  const base64 = typeof req.body?.image === 'string' ? req.body.image : undefined;
  if (!file && !base64) return res.status(400).json({ error: 'No image provided' });

  // TODO: call the existing analysis logic (keep current implementation hook here)
  return res.json({ ok: true });
});

export default router;
