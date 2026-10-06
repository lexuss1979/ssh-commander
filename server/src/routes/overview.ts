import { Router } from 'express';
import { collectOverview } from '../services/overview.js';

export const overviewRouter = Router();

// Summary dashboard: aggregate of metrics and docker counters across all profiles.
overviewRouter.get('/', async (_req, res) => {
  try {
    res.json(await collectOverview());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
