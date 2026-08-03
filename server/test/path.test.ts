import { describe, expect, it } from 'vitest';
import { assertSafePath, joinRemotePath } from '../src/util/path.js';

describe('assertSafePath', () => {
  it('accepts absolute paths', () => {
    expect(assertSafePath('/var/log')).toBe('/var/log');
    expect(assertSafePath('/opt/app/config.yml')).toBe('/opt/app/config.yml');
  });

  it('rejects root, relative paths and traversal', () => {
    expect(() => assertSafePath('/')).toThrow();
    expect(() => assertSafePath('var/log')).toThrow();
    expect(() => assertSafePath('/var/../etc')).toThrow();
  });
});

describe('joinRemotePath', () => {
  it('joins base and name', () => {
    expect(joinRemotePath('/', 'a.txt')).toBe('/a.txt');
    expect(joinRemotePath('/var/log', 'app.log')).toBe('/var/log/app.log');
  });

  it('rejects invalid names', () => {
    expect(() => joinRemotePath('/', 'a/b')).toThrow();
    expect(() => joinRemotePath('/', '..')).toThrow();
  });
});

