import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';

// Внешний IP сервера узнаём у публичного echo-сервиса через SSH.
// curl в двух вариантах + wget-фолбэк: на минимальных системах curl может
// отсутствовать. IPv4 принудительно (-4): у большинства VPS именно он.
const CMD = [
  'curl -4fsS --max-time 3 https://ifconfig.me 2>/dev/null',
  'curl -4fsS --max-time 3 https://api.ipify.org 2>/dev/null',
  'wget -qO- -T 3 https://ifconfig.me 2>/dev/null',
].join(' || ');

/** Разбор вывода echo-сервиса: строгий IPv4, иначе null. */
export function parseExternalIp(stdout: string): string | null {
  const text = stdout.trim();
  const m = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((n) => n <= 255) ? text : null;
}

// IP меняется редко: успех кэшируем на 10 минут, неудачу — на минуту,
// чтобы сервер без выхода в интернет не добавлял задержку в каждый опрос.
const SUCCESS_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; ttl: number; value: string | null }>();

/**
 * Внешний IP профиля или null (нет интернета/curl/wget на сервере).
 * Никогда не бросает: это необязательное поле сводного дашборда.
 */
export async function getExternalIp(profile: Profile): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < hit.ttl) {
    return hit.value;
  }
  const value = await exec(profile, CMD)
    .then((r) => parseExternalIp(r.stdout))
    .catch(() => null);
  cache.set(profile.id, {
    at: now,
    ttl: value ? SUCCESS_TTL_MS : FAILURE_TTL_MS,
    value,
  });
  return value;
}
