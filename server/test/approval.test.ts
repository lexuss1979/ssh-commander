import { describe, expect, it } from 'vitest';
import { needsApproval } from '../src/ai/approval.js';

// The pure risk classification (docs/agent-access-levels-plan.md): a table of
// mode × tool × path/action. Fail-closed: an unknown tool asks for approval
// in every mode except 'never' (Full Access auto-runs everything).
describe('needsApproval', () => {
  describe('read-only tools are auto in every mode', () => {
    it.each([
      ['always', 'list_dir'],
      ['needed', 'list_dir'],
      ['never', 'list_dir'],
      ['always', 'docker_ps'],
      ['needed', 'security_audit'],
      ['never', 'disk_usage'],
    ] as const)('%s: %s is auto', (mode, name) => {
      expect(needsApproval(mode, name, { path: '/home' })).toBe(false);
    });

    it.each(['always', 'needed'] as const)('%s: read_file on a sensitive path goes to approve', (mode) => {
      expect(needsApproval(mode, 'read_file', { path: '/home/user/.env' })).toBe(true);
    });

    it('never: read_file on a sensitive path is auto (Full Access; the output is still redacted)', () => {
      expect(needsApproval('never', 'read_file', { path: '/home/user/.env' })).toBe(false);
    });

    it.each(['always', 'needed'] as const)('%s: exec_readonly touching a secret path goes to approve', (mode) => {
      expect(needsApproval(mode, 'exec_readonly', { command: 'cat /root/.ssh/id_rsa' })).toBe(true);
    });
  });

  describe("always (default): every mutating tool asks", () => {
    it.each(['exec', 'write_file', 'write_memory', 'docker_action', 'connect_server'])('%s → approve', (name) => {
      expect(needsApproval('always', name, {})).toBe(true);
    });
  });

  describe('needed: low-risk mutations are auto', () => {
    it('write_memory is auto', () => {
      expect(needsApproval('needed', 'write_memory', { content: 'note' })).toBe(false);
    });

    it.each(['start', 'stop', 'restart', 'pull', 'run'])('docker_action %s is auto', (action) => {
      expect(needsApproval('needed', 'docker_action', { action, target: 'web' })).toBe(false);
    });

    it.each(['rm', 'rmi'])('destructive docker_action %s → approve', (action) => {
      expect(needsApproval('needed', 'docker_action', { action, target: 'web' })).toBe(true);
    });

    it('write_file outside system paths is auto', () => {
      expect(needsApproval('needed', 'write_file', { path: '/home/user/x.txt', content: 'x' })).toBe(false);
    });

    it.each([
      '/etc',
      '/etc/nginx/nginx.conf',
      '/usr/local/bin/x',
      '/root/notes.txt',
      '/var/lib/docker/x',
      '/var/log/app.log',
    ])('write_file on a system path %s → approve', (p) => {
      expect(needsApproval('needed', 'write_file', { path: p, content: 'x' })).toBe(true);
    });

    it('write_file on a sensitive path in home → approve (sensitive wins over home)', () => {
      expect(needsApproval('needed', 'write_file', { path: '/home/user/.env', content: 'x' })).toBe(true);
    });

    it('a path that merely starts with the same letters is not a system path', () => {
      // '/etcetera/...' is not '/etc/...'.
      expect(needsApproval('needed', 'write_file', { path: '/etcetera/x', content: 'x' })).toBe(false);
    });

    it.each([
      '/etc/../home/x', // non-canonical: normalize changes it → approve
      '/home/user/../x', // benign-looking traversal, still non-canonical
      '//etc/passwd', // double slash resolves into /etc
      '/home/user//x.txt', // double slash inside
      '../../etc/cron.d/x', // relative traversal into a system directory
      'home/x.txt', // relative
      '', // empty
    ])('a non-canonical or relative path %j → approve (fail-closed)', (p) => {
      // The SFTP call would resolve it as-is; the prefix check must not
      // classify what it does not see verbatim.
      expect(needsApproval('needed', 'write_file', { path: p, content: 'x' })).toBe(true);
    });

    it.each(['exec', 'connect_server'])('%s → approve (arbitrary shell bypasses any classification)', (name) => {
      expect(needsApproval('needed', name, {})).toBe(true);
    });
  });

  describe('never (Full Access): everything is auto', () => {
    it.each([
      ['exec', { command: 'rm -rf /' }],
      ['write_file', { path: '/etc/nginx/nginx.conf', content: 'x' }],
      ['write_memory', { content: 'x' }],
      ['docker_action', { action: 'rm', target: 'web' }],
      ['connect_server', { server: 'other' }],
      ['read_file', { path: '/etc/shadow' }],
    ])('%s is auto', (name, args) => {
      expect(needsApproval('never', name, args)).toBe(false);
    });
  });

  describe('fail-closed on an unknown tool', () => {
    it.each(['always', 'needed'] as const)('%s: unknown tool → approve', (mode) => {
      expect(needsApproval(mode, 'teleport', {})).toBe(true);
    });

    it('never: unknown tool is auto (Full Access is total)', () => {
      expect(needsApproval('never', 'teleport', {})).toBe(false);
    });
  });
});
