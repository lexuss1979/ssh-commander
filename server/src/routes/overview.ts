import { Router } from 'express';
import { collectOverview } from '../services/overview.js';

export const overviewRouter = Router();

// Сводный дашборд: агрегат метрик и docker-счётчиков по всем профилям.
overviewRouter.get('/', async (_req, res) => {
  try {
    res.json(await collectOverview());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
