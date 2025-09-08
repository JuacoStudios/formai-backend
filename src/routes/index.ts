import { Router } from 'express';
import analyzeRouter from './analyze';

const api = Router();

// Dual health endpoints (match both callers)
api.get('/healthz', (_req, res) => res.json({ ok: true }));
api.get('/health', (_req, res) => res.json({ ok: true }));

// Subroutes (do NOT use '/api' here)
api.use(analyzeRouter);

export default api;
