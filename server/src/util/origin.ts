/**
 * `Origin` header check — protection against requests initiated by someone
 * else's page (CSRF and WebSocket hijacking).
 *
 * Before this the only barrier was `sameSite: 'lax'` on the session cookie,
 * i.e. the protection relied entirely on browser behavior. The stakes are
 * high: `/ws/terminal` is a PTY on every server the user manages.
 *
 * Rule: the app is local, so any browser origin must be loopback. The port is
 * not checked — dev mode goes through Vite on 5173, and a local process
 * already has terminal-level trust. A request without an `Origin` header
 * (curl, tests, non-browser clients) is allowed through: browsers set the
 * header, and a cross-site request never comes without it.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTNAMES.has(h) || LOOPBACK_HOSTNAMES.has(`[${h}]`)) return true;
  // The whole 127.0.0.0/8 range, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Whether the request origin is allowed. A missing Origin means a non-browser call. */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  // The string 'null' — sandboxed iframe or file://; must not be trusted.
  if (origin === 'null') return false;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
