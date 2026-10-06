import type { Profile } from '../types.js';
import { dockerExec, parseDockerJsonOutput, type DockerEntity } from './docker.js';
import { parseInspectPorts } from './container-ports.js';

export type DbEngine = 'postgres' | 'mysql';

/** MariaDB differs from MySQL in the timeout variable name (seconds vs ms). */
export type MysqlFlavor = 'mysql' | 'mariadb';

/**
 * A discovered DB container — a hint for the connection form (iteration 2):
 * auto-fills the engine, user and default database from the official images'
 * env. Credentials are entered explicitly by the user — the container env
 * may go stale (the reason iteration 1 was rolled back), the password is
 * typed by a human.
 */
export interface DbContainerSuggestion {
  /** Docker container id. */
  id: string;
  name: string;
  engine: DbEngine;
  image: string;
  /** User hint from POSTGRES_USER / MYSQL_USER (root for mysql). */
  suggestedUser: string;
  /** Database hint from POSTGRES_DB / MYSQL_DATABASE; null — none. */
  suggestedDatabase: string | null;
  /** MySQL: the image family — affects the timeout SET syntax. */
  flavor?: MysqlFlavor;
}

/** A container with a DB port but an unrecognized image — a hint, not a form option. */
export interface DbHint {
  id: string;
  name: string;
  port: number;
}

export interface DbDiscoveryResult {
  suggestions: DbContainerSuggestion[];
  hints: DbHint[];
}

/** Image repositories → engine. The list is extensible (epic 12, the plan). */
const PG_REPOS = new Set(['postgres', 'postgis/postgis', 'bitnami/postgresql']);
const MYSQL_REPOS = new Set(['mysql', 'mysql/mysql-server', 'bitnami/mysql']);
const MARIADB_REPOS = new Set(['mariadb', 'bitnami/mariadb']);

/** Ports by which a container with an unrecognized image gets into hints. */
const DB_PORT_HINTS = new Set([5432, 3306]);

/**
 * Repository from an image reference: cuts off the registry (the component
 * before the first `/` with a dot/colon or `localhost`), the tag after the
 * last `:` and the digest after `@`. A pure function — all engine matching
 * is under unit tests.
 */
export function imageRepository(imageRef: string): string {
  let ref = imageRef.trim().toLowerCase();
  const digestAt = ref.indexOf('@');
  if (digestAt >= 0) ref = ref.slice(0, digestAt);
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) ref = ref.slice(0, lastColon);
  const firstSlash = ref.indexOf('/');
  if (firstSlash > 0) {
    const head = ref.slice(0, firstSlash);
    if (head === 'localhost' || head.includes('.') || head.includes(':')) {
      ref = ref.slice(firstSlash + 1);
    }
  }
  // Official Hub images live in `library/` — refs like
  // `docker.io/library/mysql` point to the same image as `mysql`.
  if (ref.startsWith('library/')) ref = ref.slice('library/'.length);
  return ref;
}

/** Matches an image against a supported engine; null — not a DB. */
export function matchDbEngine(imageRef: string): DbEngine | null {
  const repo = imageRepository(imageRef);
  if (PG_REPOS.has(repo)) return 'postgres';
  if (repo.startsWith('timescale/')) return 'postgres';
  if (MYSQL_REPOS.has(repo)) return 'mysql';
  if (MARIADB_REPOS.has(repo)) return 'mysql';
  return null;
}

/** MySQL image family: mariadb has a different timeout syntax. */
export function matchMysqlFlavor(imageRef: string): MysqlFlavor {
  return MARIADB_REPOS.has(imageRepository(imageRef)) ? 'mariadb' : 'mysql';
}

/** `Config.Env` `KEY=VALUE` lines → a map (a value may contain `=`). */
export function extractEnv(env: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of env ?? []) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

/**
 * An inspect object → a connection form hint; null — the image is not
 * recognized. env is used for auto-fill only: the env password may have gone
 * stale (observed in production in iteration 1), the source of truth is the
 * human in the form.
 */
export function toDbSuggestion(entity: DockerEntity): DbContainerSuggestion | null {
  const config = (entity.Config as DockerEntity | undefined) ?? {};
  const image = String(config.Image ?? '');
  const engine = matchDbEngine(image);
  if (!engine) return null;
  const env = extractEnv(config.Env as string[] | undefined);
  const id = String(entity.Id ?? '');
  const name = String(entity.Name ?? '').replace(/^\//, '');
  if (!id || !name) return null;

  if (engine === 'postgres') {
    const user = env.POSTGRES_USER || 'postgres';
    return {
      id,
      name,
      engine,
      image,
      suggestedUser: user,
      suggestedDatabase: env.POSTGRES_DB || user,
    };
  }
  // MySQL: the MYSQL_USER+MYSQL_PASSWORD pair creates a separate user,
  // otherwise root. It does not create a schema named after the MySQL user
  // (unlike PG) — without MYSQL_DATABASE there is no database hint.
  return {
    id,
    name,
    engine,
    image,
    suggestedUser: env.MYSQL_USER || 'root',
    suggestedDatabase: env.MYSQL_DATABASE || null,
    flavor: matchMysqlFlavor(image),
  };
}

/** A container with port 5432/3306 but an unrecognized image → a hint. */
export function toDbHint(entity: DockerEntity): DbHint | null {
  const engine = matchDbEngine(String((entity.Config as DockerEntity | undefined)?.Image ?? ''));
  if (engine) return null;
  const ports = parseInspectPorts(entity);
  const hit = ports.find((p) => p.proto === 'tcp' && DB_PORT_HINTS.has(p.containerPort));
  if (!hit) return null;
  const id = String(entity.Id ?? '');
  const name = String(entity.Name ?? '').replace(/^\//, '');
  if (!id || !name) return null;
  return { id, name, port: hit.containerPort };
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; promise: Promise<DbDiscoveryResult> }>();

/**
 * Discovery of DB containers on a profile: `docker ps` + a single batch
 * `docker inspect` (the `container-ports.ts` pattern). A 2 s cache per
 * profile; docker unavailable → reject (the route decides how to degrade).
 */
export function discoverDbContainers(profile: Profile): Promise<DbDiscoveryResult> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = fetchDbDiscovery(profile);
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

async function fetchDbDiscovery(profile: Profile): Promise<DbDiscoveryResult> {
  const psResult = await dockerExec(profile, ['ps', '--format', '{{json .}}']);
  if (psResult.code !== 0) {
    throw new Error(psResult.stderr.trim() || 'docker ps failed');
  }
  const containers = parseDockerJsonOutput(psResult.stdout);
  const ids = containers.map((c) => String(c.ID ?? c.Id ?? '')).filter(Boolean);
  if (ids.length === 0) return { suggestions: [], hints: [] };

  const inspectResult = await dockerExec(profile, ['inspect', ...ids]);
  if (inspectResult.code !== 0) {
    throw new Error(inspectResult.stderr.trim() || 'docker inspect failed');
  }
  const inspected = parseDockerJsonOutput(inspectResult.stdout);

  const suggestions: DbContainerSuggestion[] = [];
  const hints: DbHint[] = [];
  for (const entity of inspected) {
    const suggestion = toDbSuggestion(entity);
    if (suggestion) {
      suggestions.push(suggestion);
      continue;
    }
    const hint = toDbHint(entity);
    if (hint) hints.push(hint);
  }
  return { suggestions, hints };
}
