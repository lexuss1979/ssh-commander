import { describe, expect, it } from 'vitest';
import {
  composeArgs,
  parseDockerJsonOutput,
  pruneArgs,
} from '../src/services/docker.js';
import { shq } from '../src/util/shell.js';

describe('pruneArgs', () => {
  it('maps targets to docker prune commands', () => {
    expect(pruneArgs('containers')).toEqual(['container', 'prune', '-f']);
    expect(pruneArgs('images')).toEqual(['image', 'prune', '-f']);
    expect(pruneArgs('volumes')).toEqual(['volume', 'prune', '-f']);
    expect(pruneArgs('system')).toEqual(['system', 'prune', '-f']);
  });

  it('never adds --all to system prune', () => {
    expect(pruneArgs('system')).not.toContain('--all');
  });
});

describe('composeArgs', () => {
  it('puts --project-directory before the action', () => {
    expect(composeArgs('/srv/app', ['ps', '--format', 'json'])).toEqual([
      '--project-directory', '/srv/app', 'ps', '--format', 'json',
    ]);
    expect(composeArgs('/srv/app', ['up', '-d'])).toEqual([
      '--project-directory', '/srv/app', 'up', '-d',
    ]);
  });

  it('shell-quotes a path with spaces and quotes', () => {
    const args = composeArgs("/srv/my app/it's", ['down']);
    const cmd = args.map(shq).join(' ');
    expect(cmd).toBe(`'--project-directory' '/srv/my app/it'\\''s' 'down'`);
  });
});

describe('parseDockerJsonOutput (stats)', () => {
  it('parses NDJSON stats snapshot', () => {
    const text = [
      '{"Container":"abc","Name":"web","CPUPerc":"0.50%","MemUsage":"10MiB / 1GiB","MemPerc":"0.98%"}',
      '{"Container":"def","Name":"db","CPUPerc":"1.20%","MemUsage":"100MiB / 1GiB","MemPerc":"9.77%"}',
    ].join('\n');
    const rows = parseDockerJsonOutput(text);
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe('web');
    expect(rows[1].CPUPerc).toBe('1.20%');
  });

  it('returns an empty list for empty output (no containers)', () => {
    expect(parseDockerJsonOutput('')).toEqual([]);
    expect(parseDockerJsonOutput('\n')).toEqual([]);
  });
});
