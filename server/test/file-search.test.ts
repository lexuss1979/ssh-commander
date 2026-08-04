import { describe, expect, it } from 'vitest';
import {
  buildContentSearchCommand,
  buildNameSearchCommand,
  parseContentSearchOutput,
  parseNameSearchOutput,
} from '../src/services/file-search.js';
import { shq } from '../src/util/shell.js';

describe('buildNameSearchCommand', () => {
  it('builds find with maxdepth and -iname', () => {
    expect(buildNameSearchCommand('/var/log', '*.log')).toBe(
      `find '/var/log' -maxdepth 10 -iname '*.log'`,
    );
  });

  it('quotes pattern as a single shell argument (injection-safe)', () => {
    const pattern = `*'; rm -rf /; '`;
    // pattern уходит одним экранированным аргументом — как shq и делает
    expect(buildNameSearchCommand('/etc', pattern)).toBe(
      `find ${shq('/etc')} -maxdepth 10 -iname ${shq(pattern)}`,
    );
  });

  it('escapes single quotes inside pattern', () => {
    expect(buildNameSearchCommand('/a', "o'clock")).toBe(
      `find '/a' -maxdepth 10 -iname 'o'\\''clock'`,
    );
  });
});

describe('buildContentSearchCommand', () => {
  it('uses fixed-string grep with per-file match cap', () => {
    expect(buildContentSearchCommand('/srv', 'hello')).toBe(
      `grep -rInF -m 5 -e 'hello' -- '/srv'`,
    );
  });

  it('adds --include only when glob is given', () => {
    expect(buildContentSearchCommand('/srv', 'hello', '*.ts')).toBe(
      `grep -rInF -m 5 --include='*.ts' -e 'hello' -- '/srv'`,
    );
    expect(buildContentSearchCommand('/srv', 'hello', '   ')).toBe(
      `grep -rInF -m 5 -e 'hello' -- '/srv'`,
    );
  });

  it('treats regex metacharacters as literal text (-F)', () => {
    const cmd = buildContentSearchCommand('/srv', 'a(b).*');
    expect(cmd).toContain(`-e 'a(b).*'`);
  });

  it('protects patterns starting with a dash via -e', () => {
    const cmd = buildContentSearchCommand('/srv', '--include=x');
    expect(cmd).toContain(`-e '--include=x'`);
  });
});

describe('parseNameSearchOutput', () => {
  it('parses paths and skips empty lines', () => {
    const out = '/var/log/a.log\n\n/var/log/b.log\n';
    expect(parseNameSearchOutput(out, 500)).toEqual([
      { path: '/var/log/a.log' },
      { path: '/var/log/b.log' },
    ]);
  });

  it('respects the limit', () => {
    const out = Array.from({ length: 10 }, (_, i) => `/f/${i}`).join('\n');
    expect(parseNameSearchOutput(out, 3)).toHaveLength(3);
  });
});

describe('parseContentSearchOutput', () => {
  it('parses path:line:preview', () => {
    const out = '/etc/nginx/nginx.conf:12:  listen 80;\n/etc/hosts:1:127.0.0.1 localhost';
    expect(parseContentSearchOutput(out, 500)).toEqual([
      { path: '/etc/nginx/nginx.conf', line: 12, preview: 'listen 80;' },
      { path: '/etc/hosts', line: 1, preview: '127.0.0.1 localhost' },
    ]);
  });

  it('handles colons inside the path', () => {
    const out = '/tmp/weird:dir/file.txt:7:match here';
    expect(parseContentSearchOutput(out, 500)).toEqual([
      { path: '/tmp/weird:dir/file.txt', line: 7, preview: 'match here' },
    ]);
  });

  it('skips unparsable lines and respects the limit', () => {
    const out = 'garbage line\n/a/b:2:x\n/c/d:3:y';
    expect(parseContentSearchOutput(out, 1)).toEqual([{ path: '/a/b', line: 2, preview: 'x' }]);
  });

  it('truncates long previews', () => {
    const out = `/a/b:1:${'x'.repeat(500)}`;
    const [r] = parseContentSearchOutput(out, 500);
    expect(r.preview!.length).toBeLessThanOrEqual(201);
    expect(r.preview!.endsWith('…')).toBe(true);
  });
});
