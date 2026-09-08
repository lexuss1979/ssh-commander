/**
 * Проверка заголовка `Origin` — защита от запросов, инициированных чужой
 * страницей (CSRF и перехват WebSocket).
 *
 * До этого единственным барьером был `sameSite: 'lax'` на cookie сессии, то
 * есть защита целиком зависела от поведения браузера. Ставка высокая:
 * `/ws/terminal` — это PTY на всех серверах пользователя.
 *
 * Правило: приложение локальное, значит любой браузерный источник обязан быть
 * петлевым. Порт не проверяется — dev-режим ходит через Vite на 5173, а
 * локальный процесс и так имеет доверие уровня терминала. Запрос без `Origin`
 * (curl, тесты, не-браузерные клиенты) пропускается: заголовок ставит браузер,
 * и кросс-сайтовый запрос без него не бывает.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTNAMES.has(h) || LOOPBACK_HOSTNAMES.has(`[${h}]`)) return true;
  // Весь диапазон 127.0.0.0/8, а не только 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Допустим ли источник запроса. Отсутствующий Origin — не браузерный вызов. */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  // Строка 'null' — песочница iframe или file://; доверять ей нельзя.
  if (origin === 'null') return false;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
