import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveDir(envName: string, relative: string): string {
  const candidates = [
    process.env[envName],
    path.resolve(moduleDir, `../../${relative}`),
    path.resolve(moduleDir, `../${relative}`),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

/**
 * The layout differs between local runs (server/dist → ../../web/dist)
 * and the Docker runtime (/app/dist → ../web/dist). Resolve the first
 * candidate that actually exists; WEB_DIST env always wins.
 */
function resolveWebDist(): string {
  const candidates = [
    process.env.WEB_DIST,
    path.resolve(moduleDir, '../../web/dist'),
    path.resolve(moduleDir, '../web/dist'),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

function int(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

function float(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

export const config = {
  // Default is the loopback address: the tool is single-user and TLS-less,
  // and "listens on 127.0.0.1 only" used to rely solely on docker-compose
  // port mapping. Inside a container 0.0.0.0 is required (otherwise port
  // publishing doesn't work) — it is set via ENV in the Dockerfile.
  host: process.env.APP_HOST || '127.0.0.1',
  port: int('APP_PORT', 8080),
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  keysDir: resolveDir('KEYS_DIR', 'keys'),
  // Empty = "not set" (there is no 'admin' default anymore): the password is
  // seeded into settings.json on first start (seedSettingsFromEnv) or set in
  // onboarding; after the first start env is never read.
  appPassword: process.env.APP_PASSWORD || '',
  sessionTtlMs: 24 * 60 * 60 * 1000,
  webDist: resolveWebDist(),
  ai: {
    // apiBase/apiKey/model are only input for the first-start seed
    // (seedSettingsFromEnv copies them into settings.json); at runtime the AI
    // config is read from settings (getAiSettings) — changing env after the
    // first start has no effect.
    apiBase: (process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4.1-mini',
    maxSteps: int('AI_MAX_STEPS', 30),
    temperature: float('AI_TEMPERATURE', 0.2),
    // Web search for the agent: an Anthropic-compatible endpoint with the
    // server-side web_search tool (DeepSeek uses the same API key as chat).
    // An empty AI_SEARCH_API_BASE turns search off: the tool is not declared
    // to the agent.
    searchApiBase: (process.env.AI_SEARCH_API_BASE || '').replace(/\/+$/, ''),
    searchModel: process.env.AI_SEARCH_MODEL || 'deepseek-v4-flash',
  },
};

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.keysDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  hardenDataPermissions();
}

/**
 * 0600 permissions on data files at startup.
 *
 * Stores are now written with an explicit mode, but files created by older
 * versions stayed 0644 — no future write would fix them while the content is
 * unchanged. They hold SSH passwords, DB passwords and server output
 * excerpts. Errors are ignored: on some filesystems (Windows bind mounts)
 * chmod is meaningless — not a reason to refuse to start.
 */
function hardenDataPermissions(): void {
  const targets: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
      } else if (entry.isFile()) {
        targets.push(full);
      }
    }
  };
  // All of data/ (including memory/<profileId>/MEMORY.md) and the keys dir.
  walk(config.dataDir, 2);
  walk(config.keysDir, 0);
  for (const file of targets) {
    try {
      const { mode } = fs.statSync(file);
      if ((mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    } catch {
      /* the file may have vanished, or the FS doesn't support permissions */
    }
  }
}
