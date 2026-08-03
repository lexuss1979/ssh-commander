import { describe, expect, it } from 'vitest';
import { parseDockerJsonOutput } from '../src/services/docker.js';

describe('parseDockerJsonOutput', () => {
  it('parses newline-delimited JSON objects', () => {
    const input = [
      '{"ID":"abc","Names":"web"}',
      '{"ID":"def","Names":"db"}',
      '',
    ].join('\n');
    const out = parseDockerJsonOutput(input);
    expect(out).toHaveLength(2);
    expect(out[0].ID).toBe('abc');
  });

  it('parses a JSON array', () => {
    const input = JSON.stringify([
      { ID: 'a', Names: 'web' },
      { ID: 'b', Names: 'db' },
    ]);
    expect(parseDockerJsonOutput(input)).toHaveLength(2);
  });

  it('parses a single JSON object', () => {
    expect(parseDockerJsonOutput('{"ID":"a"}')).toEqual([{ ID: 'a' }]);
  });

  it('returns empty for empty output and skips garbage lines', () => {
    expect(parseDockerJsonOutput('')).toEqual([]);
    expect(parseDockerJsonOutput('  \n')).toEqual([]);
    expect(parseDockerJsonOutput('{"ID":"a"}\nnot-json')).toHaveLength(1);
  });
});

