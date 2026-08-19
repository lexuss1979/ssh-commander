import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import { getAllHistory, getHistory } from '../services/metrics-history.js';

export const metricsHistoryRouter = Router();

/**
 * История нагрузки. С profileId — сэмплы одного профиля для вкладки «Обзор»
 * (≤360 точек); без — по всем профилям для сводного экрана «Серверы» (≤120
 * точек на профиль, достаточно для спарклайнов). Ошибок не бросает: пока
 * истории нет, отдаются пустые массивы.
 */
metricsHistoryRouter.get('/', (req, res) => {
  const profileId = String(req.query.profileId ?? '');
  if (!profileId) {
    res.json({ timestamp: Date.now(), profiles: getAllHistory() });
    return;
  }
  try {
    requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return;
  }
  res.json({ timestamp: Date.now(), samples: getHistory(profileId) });
});
