import { Router } from 'express';
import { z } from 'zod';
import { collectOverview } from '../services/overview.js';
import { DEFAULT_ALERT_THRESHOLDS, evaluateAlertRules } from '../services/alerts.js';

export const alertsRouter = Router();

const alertsQuerySchema = z.object({
  disk: z.coerce.number().min(50).max(99).default(DEFAULT_ALERT_THRESHOLDS.diskPercent),
  mem: z.coerce.number().min(50).max(99).default(DEFAULT_ALERT_THRESHOLDS.memPercent),
  load: z.coerce.number().min(0.5).max(16).default(DEFAULT_ALERT_THRESHOLDS.loadPerCore),
});

// Состояния правил алертов всех профилей. Поверх кэша collectOverview (4 с) —
// новых SSH-вызовов не добавляет; вычисление правил см. services/alerts.ts.
alertsRouter.get('/', async (req, res) => {
  const parsed = alertsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' });
    return;
  }
  try {
    const q = parsed.data;
    const thresholds = { diskPercent: q.disk, memPercent: q.mem, loadPerCore: q.load };
    const overview = await collectOverview();
    res.json({
      timestamp: overview.timestamp,
      thresholds,
      rules: evaluateAlertRules(overview, thresholds),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
