import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import { getAllHistory, getHistory } from '../services/metrics-history.js';

export const metricsHistoryRouter = Router();

/**
 * Load history. With profileId — samples of one profile for the Overview tab
 * (≤360 points); without — across all profiles for the Servers summary
 * screen (≤120 points per profile, enough for sparklines). Never throws:
 * while there is no history, empty arrays are served.
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
