import { describe, expect, it } from 'vitest';
import {
  buildBatchDownloadCommand,
  buildTarDownloadCommand,
  buildTarUploadCommand,
  isCommandNotFound,
  TAR_NOT_FOUND_MESSAGE,
  tarError,
} from '../src/services/transfer.js';
import { assertSafePath } from '../src/util/path.js';

describe('buildTarDownloadCommand', () => {
  it('packs the directory from its parent', () => {
    expect(buildTarDownloadCommand('/var/log/app')).toBe(
      `tar -czf - -C '/var/log' 'app'`,
    );
  });

  it('quotes names with spaces and quotes', () => {
    expect(buildTarDownloadCommand(`/srv/my dir's`)).toBe(
      `tar -czf - -C '/srv' 'my dir'\\''s'`,
    );
  });
});

describe('buildBatchDownloadCommand', () => {
  it('packs multiple names from the same parent directory', () => {
    expect(buildBatchDownloadCommand('/var/log', ['app.log', 'syslog'])).toBe(
      `tar -czf - -C '/var/log' 'app.log' 'syslog'`,
    );
  });

  it('quotes names with special characters', () => {
    expect(buildBatchDownloadCommand('/srv', [`my file's`, 'normal'])).toBe(
      `tar -czf - -C '/srv' 'my file'\\''s' 'normal'`,
    );
  });
});

describe('buildTarUploadCommand', () => {
  it('unpacks stdin into the target directory', () => {
    expect(buildTarUploadCommand('/var/www')).toBe(`tar -xzf - -C '/var/www'`);
  });
});

describe('path validation for transfer', () => {
  it('rejects root and traversal', () => {
    expect(() => assertSafePath('/')).toThrow();
    expect(() => assertSafePath('/var/../etc')).toThrow();
    expect(assertSafePath('/var/log')).toBe('/var/log');
  });
});

describe('isCommandNotFound', () => {
  it('detects exit code 127 and shell messages', () => {
    expect(isCommandNotFound('', 127)).toBe(true);
    expect(isCommandNotFound('sh: tar: command not found', 127)).toBe(true);
    expect(isCommandNotFound('bash: tar: not found', 1)).toBe(true);
    expect(isCommandNotFound('tar: file changed as we read it', 1)).toBe(false);
  });
});

describe('tarError', () => {
  it('turns missing tar into a friendly message', () => {
    expect(tarError('sh: tar: command not found', 127)).toBe(TAR_NOT_FOUND_MESSAGE);
  });

  it('passes through real tar errors and falls back to the code', () => {
    expect(tarError('tar: Child died with signal 13', 2)).toBe('tar: Child died with signal 13');
    expect(tarError('', 2)).toBe('tar exited with code 2');
    expect(tarError('', null)).toBe('tar exited with code unknown');
  });
});
