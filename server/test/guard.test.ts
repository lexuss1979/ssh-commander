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
      'unlink /tmp/x',
      'chattr +i /etc/hosts',
      'setfacl -m u:nobody:r /etc/hosts',
      'wipefs -a /dev/sda',
      'dd if=/dev/zero of=/dev/sda',
      'shred -u /var/log/auth.log',
      'useradd test',
      'userdel test',
      'usermod -aG sudo test',
      'passwd root',
      'crontab -e',
      'iptables -L',
      'mount /dev/sda1 /mnt',
      'umount /mnt',
    ]) {
      expect(checkReadOnlyCommand(cmd).ok, cmd).toBe(false);
    }
  });

  it('blocks mkfs variants by prefix', () => {
    for (const cmd of [
      'mkfs /dev/sda1',
      'mkfs.ext4 /dev/sda1',
      'mkfs.btrfs -f /dev/sdb',
      'xfs_repair /dev/sda1',
    ]) {
      expect(checkReadOnlyCommand(cmd).ok, cmd).toBe(false);
    }
  });

  it('blocks find with mutating flags', () => {
    for (const cmd of [
      'find / -delete',
      'find /tmp -name "*.log" -delete',
      'find /var -exec rm -rf {} +',
      'find /var -execdir rm {} +',
      'find /opt -ok rm {} +',
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

