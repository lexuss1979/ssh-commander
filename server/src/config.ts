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
  host: process.env.APP_HOST || '0.0.0.0',
  port: int('APP_PORT', 8080),
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  keysDir: resolveDir('KEYS_DIR', 'keys'),
  // Пусто = «не задан» (дефолта 'admin' больше нет): пароль сеется в
  // settings.json при первом старте (seedSettingsFromEnv) или задаётся
  // в onboarding; после первого старта env не читается.
  appPassword: process.env.APP_PASSWORD || '',
  sessionTtlMs: 24 * 60 * 60 * 1000,
  webDist: resolveWebDist(),
  ai: {
    // apiBase/apiKey/model — только вход для seed'а при первом старте
    // (seedSettingsFromEnv копирует их в settings.json); в рантайме AI-конфиг
    // читается из settings (getAiSettings), изменение env после первого
    // старта ни на что не влияет.
    apiBase: (process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4.1-mini',
    maxSteps: int('AI_MAX_STEPS', 30),
    temperature: float('AI_TEMPERATURE', 0.2),
    // Веб-поиск для агента: Anthropic-совместимый endpoint с серверным
    // инструментом web_search (у DeepSeek — тот же API-ключ, что и у chat).
    // Пустой AI_SEARCH_API_BASE выключает поиск: инструмент агенту не объявляется.
    searchApiBase: (process.env.AI_SEARCH_API_BASE || '').replace(/\/+$/, ''),
    searchModel: process.env.AI_SEARCH_MODEL || 'deepseek-v4-flash',
    // Язык системного промпта и ответов агента (слой 3 i18n): ru по умолчанию,
    // неизвестные значения AI_LANG сводятся к ru (не валимся).
    lang: process.env.AI_LANG === 'en' ? ('en' as const) : ('ru' as const),
  },
};

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.keysDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
