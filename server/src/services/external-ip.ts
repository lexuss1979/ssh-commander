import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';

// The server's external IP is learned from a public echo service over SSH.
// curl in two variants + a wget fallback: curl may be missing on minimal
// systems. IPv4 is forced (-4): most VPSes have exactly that.
const CMD = [
  'curl -4fsS --max-time 3 https://ifconfig.me 2>/dev/null',
  'curl -4fsS --max-time 3 https://api.ipify.org 2>/dev/null',
  'wget -qO- -T 3 https://ifconfig.me 2>/dev/null',
].join(' || ');

/** Parses the echo service output: strict IPv4, otherwise null. */
export function parseExternalIp(stdout: string): string | null {
  const text = stdout.trim();
  const m = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((n) => n <= 255) ? text : null;
}

// The IP rarely changes: cache a success for 10 minutes, a failure for a
// minute, so that a server without internet access does not add latency to
// every poll.
const SUCCESS_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; ttl: number; value: string | null }>();

/**
 * The profile's external IP or null (no internet/curl/wget on the server).
 * Never throws: this is an optional field of the summary dashboard.
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
