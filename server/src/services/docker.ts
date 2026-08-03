import { exec, execStream } from '../ssh/manager.js';
import { shq } from '../util/shell.js';
import type { ExecResult, Profile } from '../types.js';

export interface DockerEntity {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Docker's `--format '{{json .}}'` emits one JSON object per line; newer
 * versions may emit a JSON array or a single object. Accept all three.
 */
export function parseDockerJsonOutput(text: string): DockerEntity[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as DockerEntity[];
    return [parsed as DockerEntity];
  } catch {
    const entities: DockerEntity[] = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        entities.push(JSON.parse(l) as DockerEntity);
      } catch {
        // Skip warnings/errors printed by docker to stdout.
      }
    }
    return entities;
  }
}

export function dockerCommand(profile: Profile, args: string[]): string {
  const cmd = profile.dockerCommand?.trim() || 'docker';
  return `${cmd} ${args.map(shq).join(' ')}`;
}

export async function dockerExec(
  profile: Profile,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  return exec(profile, dockerCommand(profile, args), opts);
}

function checkCode(result: ExecResult): void {
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`docker exited with code ${result.code}${detail ? `: ${detail}` : ''}`);
  }
}

export async function listContainers(profile: Profile): Promise<DockerEntity[]> {
  const result = await dockerExec(profile, [
    'ps', '-a', '--no-trunc', '--format', '{{json .}}',
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'docker ps failed');
  }
  return parseDockerJsonOutput(result.stdout);
}

export async function listImages(profile: Profile): Promise<DockerEntity[]> {
  const result = await dockerExec(profile, [
    'images', '--no-trunc', '--format', '{{json .}}',
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'docker images failed');
  }
  return parseDockerJsonOutput(result.stdout);
}

export async function listVolumes(profile: Profile): Promise<DockerEntity[]> {
  const result = await dockerExec(profile, [
    'volume', 'ls', '--format', '{{json .}}',
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'docker volume ls failed');
  }
  return parseDockerJsonOutput(result.stdout);
}

export async function listNetworks(profile: Profile): Promise<DockerEntity[]> {
  const result = await dockerExec(profile, [
    'network', 'ls', '--format', '{{json .}}',
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'docker network ls failed');
  }
  return parseDockerJsonOutput(result.stdout);
}

export async function inspect(profile: Profile, target: string): Promise<DockerEntity[]> {
  const result = await dockerExec(profile, ['inspect', target]);
  checkCode(result);
  return parseDockerJsonOutput(result.stdout);
}

export async function containerAction(
  profile: Profile,
  action: 'start' | 'stop' | 'restart' | 'rm',
  id: string,
): Promise<string> {
  const args = action === 'rm' ? ['rm', '-f', id] : [action, id];
  const result = await dockerExec(profile, args);
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export async function pullImage(profile: Profile, image: string): Promise<string> {
  const result = await dockerExec(profile, ['pull', image], { timeoutMs: 300000 });
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export async function removeImage(profile: Profile, id: string): Promise<string> {
  const result = await dockerExec(profile, ['rmi', id]);
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export async function removeVolume(profile: Profile, name: string): Promise<string> {
  const result = await dockerExec(profile, ['volume', 'rm', name]);
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export async function removeNetwork(profile: Profile, name: string): Promise<string> {
  const result = await dockerExec(profile, ['network', 'rm', name]);
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export interface RunContainerOptions {
  image: string;
  name?: string;
  ports?: string[];
  env?: string[];
  command?: string;
}

export async function runContainer(
  profile: Profile,
  opts: RunContainerOptions,
): Promise<string> {
  if (!opts.image) {
    throw new Error('Image is required');
  }
  const args: string[] = ['run', '-d'];
  if (opts.name) args.push('--name', opts.name);
  for (const port of opts.ports ?? []) {
    if (port.trim()) args.push('-p', port.trim());
  }
  for (const env of opts.env ?? []) {
    if (env.trim()) args.push('-e', env.trim());
  }
  args.push(opts.image);
  if (opts.command?.trim()) args.push(opts.command.trim());
  const result = await dockerExec(profile, args, { timeoutMs: 300000 });
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export function streamContainerLogs(
  profile: Profile,
  containerId: string,
  tail: number,
  onChunk: (chunk: string, isStderr: boolean) => void,
) {
  const args = ['logs', '-f', '--tail', String(tail), containerId];
  return execStream(profile, dockerCommand(profile, args), onChunk);
}

