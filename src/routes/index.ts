const { Router } = require('express');
const analyzeRouter = require('./analyze');

const api = Router();

api.get('/healthz', (_req, res) => res.json({ ok: true }));

api.use(analyzeRouter);

module.exports = api;
