import type { Profile } from '../types.js';
import { dockerExec, parseDockerJsonOutput, type DockerEntity } from './docker.js';
import { parseInspectPorts } from './container-ports.js';

export type DbEngine = 'postgres' | 'mysql';

/** MariaDB отличается от MySQL именем переменной таймаута (секунды vs мс). */
export type MysqlFlavor = 'mysql' | 'mariadb';

export interface DbInstance {
  /** Id docker-контейнера. */
  id: string;
  name: string;
  engine: DbEngine;
  image: string;
  /** Пользователь CLI-клиента (из env контейнера, дефолты образов). */
  user: string;
  /** База по умолчанию (POSTGRES_DB / MYSQL_DATABASE), null — нет. */
  database: string | null;
  /** MySQL: имя env-переменной с паролем — разворачивается внутри контейнера. */
  passwordEnv?: string;
  /** MySQL: семейство образа — влияет на синтаксис SET таймаута. */
  flavor?: MysqlFlavor;
}

/** Контейнер с портом СУБД, но неопознанным образом — подсказка, не инстанс. */
export interface DbHint {
  id: string;
  name: string;
  port: number;
}

export interface DbDiscoveryResult {
  instances: DbInstance[];
  hints: DbHint[];
}

/** Репозитории образов → движок. Список расширяемый (эпик 12, план). */
const PG_REPOS = new Set(['postgres', 'postgis/postgis', 'bitnami/postgresql']);
const MYSQL_REPOS = new Set(['mysql', 'mysql/mysql-server', 'bitnami/mysql']);
const MARIADB_REPOS = new Set(['mariadb', 'bitnami/mariadb']);

/** Порты, по которым контейнер попадает в подсказки при неопознанном образе. */
const DB_PORT_HINTS = new Set([5432, 3306]);

/**
 * Репозиторий из референса образа: отрезает registry (компонент до первого
 * `/` с точкой/двоеточием или `localhost`), тег после последнего `:` и
 * digest после `@`. Чистая функция — весь матчинг движков под unit-тесты.
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
  // Официальные образы на Hub живут в `library/` — ref'ы вида
  // `docker.io/library/mysql` указывают на тот же образ, что и `mysql`.
  if (ref.startsWith('library/')) ref = ref.slice('library/'.length);
  return ref;
}

/** Матчит образ на поддерживаемый движок; null — не СУБД. */
export function matchDbEngine(imageRef: string): DbEngine | null {
  const repo = imageRepository(imageRef);
  if (PG_REPOS.has(repo)) return 'postgres';
  if (repo.startsWith('timescale/')) return 'postgres';
  if (MYSQL_REPOS.has(repo)) return 'mysql';
  if (MARIADB_REPOS.has(repo)) return 'mysql';
  return null;
}

/** Семейство MySQL-образа: mariadb имеет другой синтаксис таймаута. */
export function matchMysqlFlavor(imageRef: string): MysqlFlavor {
  return MARIADB_REPOS.has(imageRepository(imageRef)) ? 'mariadb' : 'mysql';
}

/** `KEY=VALUE`-строки `Config.Env` → словарь (значение может содержать `=`). */
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
 * Inspect-объект → инстанс СУБД; null — образ не опознан. Креденшалы не
 * спрашиваем у пользователя: official-образы несут их в env (PG подключается
 * по локальному сокету без пароля, пароль MySQL разворачивается внутри
 * контейнера из `$MYSQL_ROOT_PASSWORD` — в argv сервера его нет).
 */
export function toDbInstance(entity: DockerEntity): DbInstance | null {
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
      user,
      database: env.POSTGRES_DB || user,
    };
  }
  // MySQL: пара MYSQL_USER+MYSQL_PASSWORD создаёт отдельного пользователя;
  // иначе root с MYSQL_ROOT_PASSWORD. Схему с именем пользователя MySQL (в
  // отличие от PG) не создаёт — без MYSQL_DATABASE дефолта нет, null.
  if (env.MYSQL_USER && env.MYSQL_PASSWORD) {
    return {
      id,
      name,
      engine,
      image,
      user: env.MYSQL_USER,
      database: env.MYSQL_DATABASE || null,
      passwordEnv: 'MYSQL_PASSWORD',
      flavor: matchMysqlFlavor(image),
    };
  }
  return {
    id,
    name,
    engine,
    image,
    user: 'root',
    database: env.MYSQL_DATABASE || null,
    passwordEnv: 'MYSQL_ROOT_PASSWORD',
    flavor: matchMysqlFlavor(image),
  };
}

/** Контейнер с портом 5432/3306, но неопознанным образом → подсказка. */
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
 * Обнаружение инстансов СУБД на профиле: `docker ps` + один батч-
 * `docker inspect` (паттерн `container-ports.ts`). Креденшалы берутся из
 * `Config.Env`. Кэш 2 с на профиль; docker недоступен → reject (роут решает,
 * как деградировать).
 */
export function discoverDbInstances(profile: Profile): Promise<DbDiscoveryResult> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = fetchDbInstances(profile);
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

/** Ищет инстанс по id в свежем discovery (для роутов query/tables/dump). */
export async function requireDbInstance(
  profile: Profile,
  instanceId: string,
): Promise<DbInstance> {
  const { instances } = await discoverDbInstances(profile);
  const found = instances.find((i) => i.id === instanceId);
  if (!found) {
    throw new Error('Контейнер не найден среди инстансов БД (возможно, перезапущен — обновите список)');
  }
  return found;
}

async function fetchDbInstances(profile: Profile): Promise<DbDiscoveryResult> {
  const psResult = await dockerExec(profile, ['ps', '--format', '{{json .}}']);
  if (psResult.code !== 0) {
    throw new Error(psResult.stderr.trim() || 'docker ps failed');
  }
  const containers = parseDockerJsonOutput(psResult.stdout);
  const ids = containers.map((c) => String(c.ID ?? c.Id ?? '')).filter(Boolean);
  if (ids.length === 0) return { instances: [], hints: [] };

  const inspectResult = await dockerExec(profile, ['inspect', ...ids]);
  if (inspectResult.code !== 0) {
    throw new Error(inspectResult.stderr.trim() || 'docker inspect failed');
  }
  const inspected = parseDockerJsonOutput(inspectResult.stdout);

  const instances: DbInstance[] = [];
  const hints: DbHint[] = [];
  for (const entity of inspected) {
    const instance = toDbInstance(entity);
    if (instance) {
      instances.push(instance);
      continue;
    }
    const hint = toDbHint(entity);
    if (hint) hints.push(hint);
  }
  return { instances, hints };
}
