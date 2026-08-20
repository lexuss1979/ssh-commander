import type { Profile } from '../types.js';
import { dockerExec, parseDockerJsonOutput, type DockerEntity } from './docker.js';
import { parseInspectPorts } from './container-ports.js';

export type DbEngine = 'postgres' | 'mysql';

/** MariaDB отличается от MySQL именем переменной таймаута (секунды vs мс). */
export type MysqlFlavor = 'mysql' | 'mariadb';

/**
 * Обнаруженный контейнер СУБД — подсказка для формы подключения (итерация 2):
 * автозаполняет движок, пользователя и базу по умолчанию из env официальных
 * образов. Креденшалы пользователь задаёт явно — env контейнера может
 * протухнуть (причина отката итерации 1), пароль вводит человек.
 */
export interface DbContainerSuggestion {
  /** Id docker-контейнера. */
  id: string;
  name: string;
  engine: DbEngine;
  image: string;
  /** Подсказка пользователя из POSTGRES_USER / MYSQL_USER (root для mysql). */
  suggestedUser: string;
  /** Подсказка базы из POSTGRES_DB / MYSQL_DATABASE; null — нет. */
  suggestedDatabase: string | null;
  /** MySQL: семейство образа — влияет на синтаксис SET таймаута. */
  flavor?: MysqlFlavor;
}

/** Контейнер с портом СУБД, но неопознанным образом — подсказка, не вариант формы. */
export interface DbHint {
  id: string;
  name: string;
  port: number;
}

export interface DbDiscoveryResult {
  suggestions: DbContainerSuggestion[];
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
 * Inspect-объект → подсказка для формы подключения; null — образ не опознан.
 * env используется только как автозаполнение: пароль из env мог протухнуть
 * (наблюдено на проде в итерации 1), источник истины — человек в форме.
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
  // MySQL: пара MYSQL_USER+MYSQL_PASSWORD создаёт отдельного пользователя,
  // иначе root. Схему с именем пользователя MySQL (в отличие от PG) не
  // создаёт — без MYSQL_DATABASE подсказки базы нет.
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
 * Обнаружение контейнеров СУБД на профиле: `docker ps` + один батч-
 * `docker inspect` (паттерн `container-ports.ts`). Кэш 2 с на профиль;
 * docker недоступен → reject (роут решает, как деградировать).
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
