/**
 * Conservative guard for auto-executed "read-only" shell commands.
 * The agent may run these without confirmation; everything else goes
 * through the approval flow. When in doubt — block.
 */

const CONTROL_CHARS = /[><|&;`$]/;
const CODE_EXECUTION = /\b(eval|source|system\s*\(|exec\s*\(|popen\s*\()/;

const BLOCKED_WORDS = new Set([
  'rm', 'mv', 'cp', 'dd', 'mkfs', 'mke2fs', 'mkswap', 'mkfs.ext4', 'mkfs.xfs',
  'reboot', 'shutdown', 'halt', 'poweroff', 'init', 'kill', 'pkill', 'killall',
  'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'touch', 'mkdir', 'rmdir',
  'ln', 'install', 'tee', 'unlink', 'wipefs', 'fdformat',
  'truncate', 'shred', 'systemctl', 'service', 'apt', 'apt-get', 'dpkg', 'yum',
  'dnf', 'pacman', 'snap', 'flatpak', 'brew', 'pip', 'pip3', 'pipx', 'npm',
  'yarn', 'pnpm', 'bun', 'npx', 'sudo', 'su', 'python', 'python2', 'python3',
  'perl', 'ruby', 'php', 'node', 'bash', 'sh', 'zsh', 'fish', 'eval', 'exec',
  'wget', 'curl', 'aria2c', 'scp', 'rsync', 'tar', 'unzip', 'zip', 'gzip',
  'bzip2', 'xz', 'zstd', 'git', 'crontab', 'at', 'batch', 'fdisk', 'parted',
  'mount', 'umount', 'useradd', 'userdel', 'usermod', 'passwd', 'groupadd',
  'groupdel', 'chroot', 'docker', 'podman', 'sed', 'awk', 'vi', 'vim', 'nano',
  'base64', 'openssl', 'ssh-keygen', 'sshd', 'ufw', 'iptables', 'nft', 'setenforce',
  'swapoff', 'swapon', 'kubeadm', 'kubectl', 'helm', 'systemd-run', 'loginctl',
]);

// find(1) flags that turn a read-only search into mutation/arbitrary exec.
const BLOCKED_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);

// Token prefixes catch tool families with many names: mkfs.*, xfs_* etc.
const BLOCKED_PREFIXES = ['mkfs.', 'xfs_', 'e2fs', 'ntfs'];

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function checkReadOnlyCommand(command: string): GuardResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Empty command' };
  }
  if (trimmed.length > 2000) {
    return { ok: false, reason: 'Command is too long' };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return {
      ok: false,
      reason: 'Command contains shell control characters (pipes, redirection, chaining, substitution)',
    };
  }
  if (CODE_EXECUTION.test(trimmed)) {
    return { ok: false, reason: 'Command contains code execution constructs' };
  }

  const tokens = trimmed.split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, ''));
  const found = tokens.find((t) => BLOCKED_WORDS.has(t));
  if (found) {
    return { ok: false, reason: `Command '${found}' is not allowed in read-only mode` };
  }
  const flag = tokens.find((t) => BLOCKED_FLAGS.has(t));
  if (flag) {
    return { ok: false, reason: `Flag '${flag}' is not allowed in read-only mode` };
  }
  const prefixed = tokens.find((t) => BLOCKED_PREFIXES.some((p) => t.startsWith(p)));
  if (prefixed) {
    return { ok: false, reason: `Command '${prefixed}' is not allowed in read-only mode` };
  }
  return { ok: true };
}

