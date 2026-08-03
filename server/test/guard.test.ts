import { describe, expect, it } from 'vitest';
import { checkReadOnlyCommand } from '../src/ai/guard.js';

describe('checkReadOnlyCommand', () => {
  it('allows simple read-only commands', () => {
    for (const cmd of [
      'ls -la /etc',
      'cat /var/log/syslog',
      'head -n 20 /etc/passwd',
      'df -h',
      'free -m',
      'ps aux',
      'grep nginx /etc/hosts',
      'find /opt -name "*.conf"',
      'ss -tlnp',
      'whoami',
    ]) {
      expect(checkReadOnlyCommand(cmd).ok, cmd).toBe(true);
    }
  });

  it('blocks mutating commands', () => {
    for (const cmd of [
      'rm -rf /tmp/x',
      'sudo systemctl restart nginx',
      'mv a b',
      'cp a b',
      'touch /tmp/x',
      'chmod 777 /tmp/x',
      'docker stop nginx',
      'apt-get update',
      'kill -9 1234',
      'git push',
      'python3 -c "print(1)"',
      'tar -xzf x.tar',
      'echo x | tee /etc/hosts',
    ]) {
      expect(checkReadOnlyCommand(cmd).ok, cmd).toBe(false);
    }
  });

  it('blocks shell control characters and substitution', () => {
    for (const cmd of [
      'cat /etc/passwd | grep root',
      'ls > /tmp/list.txt',
      'ls; rm x',
      'echo $(whoami)',
      'echo `whoami`',
      'cat /etc/passwd && echo ok',
    ]) {
      expect(checkReadOnlyCommand(cmd).ok, cmd).toBe(false);
    }
  });

  it('rejects empty and oversized commands', () => {
    expect(checkReadOnlyCommand('').ok).toBe(false);
    expect(checkReadOnlyCommand('  ').ok).toBe(false);
    expect(checkReadOnlyCommand('ls '.repeat(1000)).ok).toBe(false);
  });
});

