import { describe, expect, it } from 'vitest';
import { dockerCommand, runContainerArgs } from '../src/services/docker.js';
import type { Profile } from '../src/types.js';

const profile = {
  id: 'p1',
  name: 'test',
  host: 'example.com',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'x',
  dockerCommand: 'docker',
} as Profile;

describe('runContainerArgs', () => {
  it('wraps a multi-word command in sh -c', () => {
    const args = runContainerArgs({ image: 'nginx', command: 'echo hello && sleep 5' });
    expect(args).toEqual(['run', '-d', 'nginx', 'sh', '-c', 'echo hello && sleep 5']);
  });

  it('omits the command wrapper when no command is given', () => {
    expect(runContainerArgs({ image: 'nginx' })).toEqual(['run', '-d', 'nginx']);
    expect(runContainerArgs({ image: 'nginx', command: '   ' })).toEqual(['run', '-d', 'nginx']);
  });

  it('keeps name, ports and env before the image', () => {
    const args = runContainerArgs({
      image: 'app:1',
      name: 'myapp',
      ports: ['8080:80', ''],
      env: ['A=1', '  '],
      command: 'npm start',
    });
    expect(args).toEqual([
      'run', '-d', '--name', 'myapp', '-p', '8080:80', '-e', 'A=1',
      'app:1', 'sh', '-c', 'npm start',
    ]);
  });

  it('renders the full shell command with quoting', () => {
    const cmd = dockerCommand(profile, runContainerArgs({ image: 'app:1', command: "echo 'hi'" }));
    expect(cmd).toBe(`docker 'run' '-d' 'app:1' 'sh' '-c' 'echo '\\''hi'\\'''`);
  });

  it('requires an image', () => {
    expect(() => runContainerArgs({ image: '' })).toThrow('Image is required');
  });
});
