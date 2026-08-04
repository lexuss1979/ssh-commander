import fs from 'node:fs';
import path from 'node:path';
import { Router, raw } from 'express';
import { config } from '../config.js';
import { KeyImportError, saveKey } from '../services/keys.js';

export const keysRouter = Router();

/**
 * Lists SSH keys placed in the keys directory (mounted at /keys in Docker).
 * Returns filesystem paths that can be stored in a profile's keyPath.
 */
keysRouter.get('/', (_req, res) => {
  try {
    fs.mkdirSync(config.keysDir, { recursive: true });
    const names = fs
      .readdirSync(config.keysDir)
      .filter((name) => !name.startsWith('.'))
      .filter((name) => {
        try {
          return fs.statSync(path.join(config.keysDir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    res.json({
      keys: names.map((name) => ({
        name,
        path: path.join(config.keysDir, name),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Imports a private SSH key into the keys directory (UI upload).
 * Body — raw key text (PEM/OpenSSH), name in query. Existing files are not
 * overwritten unless overwrite=1. Saved with 0600 permissions.
 * Reading key contents back is intentionally not exposed.
 */
keysRouter.post('/', raw({ type: '*/*', limit: '64kb' }), (req, res) => {
  try {
    const content = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const name = String(req.query.name ?? '');
    const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
    const key = saveKey(config.keysDir, name, content, overwrite);
    res.status(201).json({ key });
  } catch (err) {
    const status = err instanceof KeyImportError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

