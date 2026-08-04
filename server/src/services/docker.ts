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

/**
 * Build `docker run` arguments. The container command is wrapped in
 * `sh -c <command>`: a multi-word command ("npm start", "sleep 5 && ...")
 * is a shell string, not a single executable path — passing it as one
 * docker argument would make docker look for a binary with spaces in
 * its name. `sh -c` gives predictable shell semantics on the remote side.
 */
export function runContainerArgs(opts: RunContainerOptions): string[] {
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
  if (opts.command?.trim()) args.push('sh', '-c', opts.command.trim());
  return args;
}

export async function runContainer(
  profile: Profile,
  opts: RunContainerOptions,
): Promise<string> {
  const result = await dockerExec(profile, runContainerArgs(opts), { timeoutMs: 300000 });
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

/**
 * One-shot snapshot of `docker stats` (NDJSON, one object per container).
 */
export async function containerStats(profile: Profile): Promise<DockerEntity[]> {
  const result = await dockerExec(profile, [
    'stats', '--no-stream', '--format', '{{json .}}',
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'docker stats failed');
  }
  return parseDockerJsonOutput(result.stdout);
}

export type PruneTarget = 'containers' | 'images' | 'volumes' | 'system';

/** `docker <obj> prune -f`; `system` maps to `system prune -f` (без --all). */
export function pruneArgs(target: PruneTarget): string[] {
  const obj =
    target === 'containers' ? 'container'
    : target === 'images' ? 'image'
    : target === 'volumes' ? 'volume'
    : 'system';
  return [obj, 'prune', '-f'];
}

/** Returns the raw prune output (содержит строку «Total reclaimed space: …»). */
export async function prune(profile: Profile, target: PruneTarget): Promise<string> {
  const result = await dockerExec(profile, pruneArgs(target), { timeoutMs: 300000 });
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export type ComposeKind = 'v2' | 'v1';

interface ComposeInfo {
  kind: ComposeKind;
  /** Shell-префикс команды: `<dockerCommand> compose` (v2) или `docker-compose` (v1). */
  base: string;
}

// Детект compose на профиль кэшируется: `compose version` — дорогой лишний
// SSH-exec на каждый запрос.
const composeCache = new Map<string, ComposeInfo | null>();

/**
 * Определяет доступность compose на профиле: сначала плагин v2
 * (`<dockerCommand> compose version`), затем standalone v1
 * (`docker-compose version`). null — compose недоступен.
 */
export async function detectCompose(profile: Profile): Promise<ComposeInfo | null> {
  if (composeCache.has(profile.id)) {
    return composeCache.get(profile.id) ?? null;
  }
  let info: ComposeInfo | null = null;
  const v2 = await exec(profile, `${profile.dockerCommand?.trim() || 'docker'} compose version`);
  if (v2.code === 0) {
    info = { kind: 'v2', base: `${profile.dockerCommand?.trim() || 'docker'} compose` };
  } else {
    const v1 = await exec(profile, 'docker-compose version');
    if (v1.code === 0) {
      info = { kind: 'v1', base: 'docker-compose' };
    }
  }
  composeCache.set(profile.id, info);
  return info;
}

/**
 * Аргументы compose-команды для проекта в `path`. Только v2: у v1
 * (`docker-compose`) нет `--project-directory` до ps и нет `--format json`
 * у ps — текстовый вывод парсить хрупко, поэтому v1 не поддерживается
 * (роут возвращает понятную ошибку).
 */
export function composeArgs(path: string, actionArgs: string[]): string[] {
  return ['--project-directory', path, ...actionArgs];
}

function composeCommand(info: ComposeInfo, args: string[]): string {
  return `${info.base} ${args.map(shq).join(' ')}`;
}

async function requireComposeV2(profile: Profile): Promise<ComposeInfo> {
  const info = await detectCompose(profile);
  if (!info) {
    throw new Error('Docker Compose не найден на сервере');
  }
  if (info.kind !== 'v2') {
    throw new Error('Поддерживается только Docker Compose v2 (плагин `docker compose`); v1 (`docker-compose`) не поддерживается');
  }
  return info;
}

async function composeExec(
  profile: Profile,
  path: string,
  actionArgs: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  const info = await requireComposeV2(profile);
  return exec(profile, composeCommand(info, composeArgs(path, actionArgs)), opts);
}

export async function composePs(profile: Profile, path: string): Promise<DockerEntity[]> {
  const result = await composeExec(profile, path, ['ps', '--format', 'json']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'compose ps failed');
  }
  return parseDockerJsonOutput(result.stdout);
}

export async function composeUp(profile: Profile, path: string): Promise<string> {
  const result = await composeExec(profile, path, ['up', '-d'], { timeoutMs: 600000 });
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

export async function composeDown(profile: Profile, path: string): Promise<string> {
  const result = await composeExec(profile, path, ['down'], { timeoutMs: 300000 });
  checkCode(result);
  return (result.stdout || result.stderr).trim();
}

