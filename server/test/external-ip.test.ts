import { describe, expect, it } from 'vitest';
import { parseExternalIp } from '../src/services/external-ip.js';

describe('parseExternalIp', () => {
  it('accepts a plain IPv4 from curl output', () => {
    expect(parseExternalIp('203.0.113.10')).toBe('203.0.113.10');
  });

  it('trims trailing newline (wget output)', () => {
    expect(parseExternalIp('198.51.100.7\n')).toBe('198.51.100.7');
  });

  it('rejects octets above 255', () => {
    expect(parseExternalIp('300.1.1.1')).toBeNull();
  });

  it('rejects IPv6 and non-IP output', () => {
    expect(parseExternalIp('2001:db8::1')).toBeNull();
    expect(parseExternalIp('<html>error</html>')).toBeNull();
    expect(parseExternalIp('')).toBeNull();
  });

  it('rejects IP embedded in extra text', () => {
    expect(parseExternalIp('ip: 203.0.113.10')).toBeNull();
    expect(parseExternalIp('203.0.113.10 extra')).toBeNull();
  });
});
