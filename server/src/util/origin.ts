/** Browser origin policy. Origin is a CSRF boundary, never client authentication. */
import { isIP } from 'node:net';

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || (isIP(h) === 4 && h.startsWith('127.'));
}

/** Accept only serialized HTTP(S) origins, never paths, credentials or wildcards. */
function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      value === url.origin && !url.hostname.includes('*') ? url : null;
  } catch { return null; }
}

export interface OriginPolicy {
  network: boolean;
  origins: readonly string[];
}

export function readOriginPolicy(env: NodeJS.ProcessEnv): OriginPolicy {
  const mode = env.APP_ACCESS_MODE || 'local';
  if (mode !== 'local' && mode !== 'proxy') throw new Error('APP_ACCESS_MODE must be local or proxy');
  const origins = (env.APP_TRUSTED_ORIGINS || '').split(',').map(s => s.trim());
  if (mode === 'local') {
    if (origins.some(Boolean)) throw new Error('APP_TRUSTED_ORIGINS requires proxy mode');
    return { network: false, origins: [] };
  }
  if (origins.some(o => !parseOrigin(o) || !o.startsWith('https://'))) {
    throw new Error('Proxy mode requires exact HTTPS APP_TRUSTED_ORIGINS (comma separated)');
  }
  return { network: true, origins };
}

const LOCAL_POLICY: OriginPolicy = { network: false, origins: [] };

export function isAllowedOrigin(origin: string | undefined | null, policy = LOCAL_POLICY): boolean {
  // In proxy mode require Origin even for reads and non-browser clients.
  // The sole healthcheck exception lives in index.ts and checks the socket peer.
  if (origin == null || origin === '') return !policy.network;
  const url = parseOrigin(origin);
  if (!url) return false;
  return policy.network ? policy.origins.includes(origin) : isLoopbackHostname(url.hostname);
}

/** Browsers may omit Origin on same-origin GET/HEAD, but send Referer. */
export function isAllowedApiSource(method: string, origin: string | undefined,
  referer: string | undefined, policy: OriginPolicy): boolean {
  if (!policy.network || origin !== undefined) return isAllowedOrigin(origin, policy);
  if ((method !== 'GET' && method !== 'HEAD') || !referer) return false;
  try {
    const url = new URL(referer);
    if (url.username || url.password) return false;
    return isAllowedOrigin(url.origin, policy);
  } catch { return false; }
}
