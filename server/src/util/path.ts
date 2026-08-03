import path from 'node:path';

/**
 * Remote paths are arbitrary, but destructive operations (recursive delete)
 * must not target root or traverse with '..'.
 */
export function assertSafePath(p: string): string {
  if (!p.startsWith('/')) {
    throw new Error('Path must be absolute');
  }
  const parts = p.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error("'..' is not allowed in paths");
  }
  if (parts.length === 0) {
    throw new Error('Root path is not allowed for this operation');
  }
  return p;
}

export function joinRemotePath(dir: string, name: string): string {
  if (name.includes('/') || name.includes('\0') || name === '.' || name === '..') {
    throw new Error('Invalid file name');
  }
  const base = dir === '/' ? '' : dir.replace(/\/+$/, '');
  return `${base}/${name}`;
}

export function dirname(p: string): string {
  const d = path.posix.dirname(p);
  return d === '.' ? '/' : d;
}

export function basename(p: string): string {
  const b = path.posix.basename(p);
  return b === '' || b === '/' ? '/' : b;
}

export function modeToString(mode: number): string {
  const type =
    (mode & 0o170000) === 0o040000 ? 'd'
    : (mode & 0o170000) === 0o120000 ? 'l'
    : '-';
  const perms = 'rwxrwxrwx';
  let s = type;
  for (let i = 0; i < 9; i++) {
    s += mode & (1 << (8 - i)) ? perms[i] : '-';
  }
  return s;
}
