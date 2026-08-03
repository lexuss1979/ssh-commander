import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';

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

