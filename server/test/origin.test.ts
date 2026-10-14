import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, isContainerWildcardHost, isLoopbackHostname } from '../src/util/origin.js';

describe('isLoopbackHostname', () => {
  it('recognizes loopback addresses', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
  });

  it('does not recognize external ones', () => {
    for (const h of ['evil.tld', '192.168.1.10', '10.0.0.5', 'localhost.evil.tld', '127.0.0.1.evil.tld']) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
});

describe('isContainerWildcardHost', () => {
  // Regression: 0.0.0.0 was dropped from the loopback set for origins, but the
  // same predicate drives the non-loopback startup warning, which would then
  // fire on every Docker start (the Dockerfile sets APP_HOST=0.0.0.0).
  it('keeps the wildcard bind out of trusted origins but not out of the warning', () => {
    expect(isContainerWildcardHost('0.0.0.0')).toBe(true);
    expect(isContainerWildcardHost(' 0.0.0.0 ')).toBe(true);
    for (const h of ['127.0.0.1', 'localhost', '192.168.1.10', '::', '']) {
      expect(isContainerWildcardHost(h), h).toBe(false);
    }
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
    expect(isAllowedOrigin('http://0.0.0.0')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('passes local origins, including the Vite dev port', () => {
    for (const o of ['http://localhost:8080', 'http://127.0.0.1:5173', 'http://[::1]:8080']) {
      expect(isAllowedOrigin(o), o).toBe(true);
    }
  });

  it('rejects foreign origins and the sandbox', () => {
    for (const o of ['https://evil.tld', 'http://localhost.evil.tld', 'null', 'не-url']) {
      expect(isAllowedOrigin(o), o).toBe(false);
    }
  });

  it('passes a request without Origin (a non-browser client)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });
});
