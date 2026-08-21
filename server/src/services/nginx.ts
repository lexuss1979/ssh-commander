import { exec } from '../ssh/manager.js';
import { dockerExec, parseDockerJsonOutput } from './docker.js';
import { imageRepository } from './db-discovery.js';
import { shq } from '../util/shell.js';
import {
  certInfoFromPem,
  parseCertBatch,
  parseNginxDump,
  toSiteEntry,
} from './nginx-parser.js';
import type {
  ExecResult,
  NginxSourceRef,
  NginxSourceSnapshot,
  NginxSnapshot,
  Profile,
} from '../types.js';

/**
 * I/O слой вкладки «Nginx»: discovery (решение 2), снапшот `nginx -T` +
 * `nginx -t` + сертификаты (решения 1, 5, 10), guard-перезагрузка (решение 4).
 * Паттерн cron.ts/ports.ts: кэш снапшота 2 с на профиль, сертификаты —
 * отдельный кэш 10 мин.
 */

/** Репозитории образов с nginx (через imageRepository из db-discovery.ts). */
const NGINX_IMAGE_REPOS = new Set([
  'nginx',
  'nginxproxy/nginx-proxy',
  'jc21/nginx-proxy-manager',
  'openresty/openresty',
]);

/** Лимит вывода `nginx -T`: реальный дамп с сотнями сайтов больше дефолтных 2 МБ. */
const DUMP_MAX_OUTPUT = 8 * 1024 * 1024;

const SNAPSHOT_CACHE_TTL_MS = 2000;
const CERT_CACHE_TTL_MS = 10 * 60 * 1000;

const snapshotCache = new Map<string, { at: number; promise: Promise<NginxSnapshot> }>();
/** Ключ: `<profileId>:<source>` → путь → {at, pem}. */
const certCache = new Map<string, Map<string, { at: number; pem: string }>>();

// ---------------------------------------------------------------------------
// Билдеры команд (чистые, под unit-тесты)
// ---------------------------------------------------------------------------

/** Команда для native — shell-строка; для контейнера — docker-аргументы
 * (экранирование dockerCommand + shq делает `dockerExec` внутри docker.ts). */
export type NginxCmd = string | string[];

export function buildDumpCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -T`;
  return ['exec', source.containerId, 'nginx', '-T'];
}

export function buildTestCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -t`;
  return ['exec', source.containerId, 'nginx', '-t'];
}

export function buildReloadCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -s reload`;
  return ['exec', source.containerId, 'nginx', '-s', 'reload'];
}

/** `nginx -v` пишет версию в stderr. */
export function buildVersionCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -v`;
  return ['exec', source.containerId, 'nginx', '-v'];
}

/**
 * Батч-чтение PEM-файлов одной командой с маркерами `=== <путь>`
 * (паттерн `/etc/cron.d`, решение 5). `[ -f ]`-гвард: непрочитанный файл
 * не даёт секции в stdout — сборщик помечает его «недоступен», а не мусором.
 */
export function buildCertBatchCmd(source: NginxSourceRef, paths: string[]): NginxCmd {
  const loop =
    `for f in ${paths.map(shq).join(' ')}; do ` +
    `if [ -f "$f" ]; then echo "=== $f"; cat -- "$f"; fi; done`;
  if (source.type === 'native') return loop;
  return ['exec', source.containerId, 'sh', '-c', loop];
}

/** Выполнение команды источника: строка — exec, массив — dockerExec. */
async function runSource(
  profile: Profile,
  cmd: NginxCmd,
  opts?: { maxOutput?: number },
): Promise<ExecResult> {
  if (Array.isArray(cmd)) return dockerExec(profile, cmd, opts);
  return exec(profile, cmd, opts);
}

/** Версия nginx из stderr `nginx version: nginx/1.25.3`; null — не распознана. */
export function parseVersion(stderr: string): string | null {
  const m = stderr.match(/nginx version: nginx\/(\S+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Discovery (решение 2): native первым, контейнер — best-effort
// ---------------------------------------------------------------------------

/** Детект нативного бинаря кэшируется на профиль (как compose-детект в docker.ts). */
const nativeCache = new Map<string, string | null>();

async function detectNativeNginx(profile: Profile): Promise<string | null> {
  if (nativeCache.has(profile.id)) return nativeCache.get(profile.id) ?? null;
  let bin: string | null = null;
  const which = await exec(profile, 'command -v nginx');
  if (which.code === 0 && which.stdout.trim()) {
    bin = which.stdout.trim().split('\n')[0];
  } else {
    const fallback = await exec(profile, 'test -x /usr/sbin/nginx && echo yes');
    if (fallback.code === 0 && fallback.stdout.trim() === 'yes') bin = '/usr/sbin/nginx';
  }
  nativeCache.set(profile.id, bin);
  return bin;
}

interface NginxContainer {
  id: string;
  name: string;
  image: string;
}

/**
 * Матчинг контейнера: репозиторий образа в белом списке плюс подстрока
 * `nginx` в имени образа или контейнера (ловит self-built `web-nginx`).
 * Известный промах: контейнер с совсем чужим именем/образом не найдётся —
 * задокументировано в пустом состоянии вкладки (решение 2).
 */
export function isNginxContainer(image: string, name: string): boolean {
  const repo = imageRepository(image);
  const img = image.toLowerCase();
  const nm = name.toLowerCase();
  return NGINX_IMAGE_REPOS.has(repo) || img.includes('nginx') || nm.includes('nginx');
}

/** docker недоступен → reject; discoverNginx ловит и продолжает с native. */
async function findNginxContainers(profile: Profile): Promise<NginxContainer[]> {
  const result = await dockerExec(profile, ['ps', '--format', '{{json .}}']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'docker ps failed');
  }
  const containers = parseDockerJsonOutput(result.stdout);
  const out: NginxContainer[] = [];
  for (const c of containers) {
    const id = String(c.ID ?? c.Id ?? '');
    const name = String(c.Names ?? '').replace(/^\//, '');
    const image = String(c.Image ?? '');
    if (!id || !name) continue;
    if (isNginxContainer(image, name)) out.push({ id, name, image });
  }
  return out;
}

/**
 * Discovery: native (detect кэшируется на профиль) + контейнеры
 * (живут в кэше снапшота — состав контейнеров может меняться).
 */
export async function discoverNginx(profile: Profile): Promise<NginxSourceRef[]> {
  const sources: NginxSourceRef[] = [];
  const nativeBin = await detectNativeNginx(profile);
  if (nativeBin) sources.push({ type: 'native', bin: nativeBin });
  try {
    for (const c of await findNginxContainers(profile)) {
      sources.push({ type: 'container', containerId: c.id, containerName: c.name });
    }
  } catch {
    // docker недоступен — контейнерный nginx не ищем (best-effort, решение 2).
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Сертификаты: батч-чтение + кэш 10 мин на (профиль, источник)
// ---------------------------------------------------------------------------

/** Читает PEM по путям с кэшем; в Map попадают только прочитанные файлы. */
async function readCerts(
  profile: Profile,
  source: NginxSourceRef,
  paths: string[],
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const cacheKey =
    source.type === 'native' ? `${profile.id}:native` : `${profile.id}:container:${source.containerId}`;
  const now = Date.now();
  let cache = certCache.get(cacheKey);
  if (!cache) {
    cache = new Map();
    certCache.set(cacheKey, cache);
  }
  const fresh = new Map<string, string>();
  const missing: string[] = [];
  for (const p of paths) {
    const hit = cache.get(p);
    if (hit && now - hit.at < CERT_CACHE_TTL_MS) fresh.set(p, hit.pem);
    else missing.push(p);
  }
  if (missing.length > 0) {
    const result = await runSource(profile, buildCertBatchCmd(source, missing));
    if (result.code === 0) {
      const parsed = parseCertBatch(result.stdout);
      for (const p of missing) {
        const pem = parsed.get(p);
        if (pem !== undefined) {
          fresh.set(p, pem);
          cache.set(p, { at: now, pem });
        }
      }
    }
    // Команда упала целиком — прочитанные ранее пути из кэша уже в fresh;
    // непрочитанные помечаются «недоступен» в сборщике.
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Снапшот: discovery → параллельно по источникам -T/-t/-v → сертификаты
// ---------------------------------------------------------------------------

function sourceBase(source: NginxSourceRef): NginxSourceSnapshot {
  return source.type === 'native'
    ? { type: 'native', version: null, configTest: { ok: false, output: '' }, sites: [] }
    : {
        type: 'container',
        containerId: source.containerId,
        containerName: source.containerName,
        version: null,
        configTest: { ok: false, output: '' },
        sites: [],
      };
}

async function collectSource(profile: Profile, source: NginxSourceRef): Promise<NginxSourceSnapshot> {
  const [dump, test, version] = await Promise.all([
    runSource(profile, buildDumpCmd(source), { maxOutput: DUMP_MAX_OUTPUT }),
    runSource(profile, buildTestCmd(source)),
    runSource(profile, buildVersionCmd(source)),
  ]);

  const snap = sourceBase(source);
  snap.configTest = { ok: test.code === 0, output: (test.stderr || test.stdout).trim() };
  snap.version = version.code === 0 ? parseVersion(version.stderr) : null;

  if (dump.code !== 0) {
    snap.error = `nginx -T: ${(dump.stderr || dump.stdout).trim() || `код ${dump.code}`}`;
    return snap;
  }
  // Признак обрезки по лимиту: exec молча режет на maxOutput — честная
  // ошибка вместо частичного (и вводящего в заблуждение) конфига.
  if (dump.stdout.length >= DUMP_MAX_OUTPUT) {
    snap.error = 'конфиг слишком большой (превышен лимит 8 МБ) — сайты не показаны';
    return snap;
  }

  const parsed = parseNginxDump(dump.stdout);
  const httpDefaults = { sslCertificate: parsed.httpSslCertificate };
  // Дедуп путей сертификатов перед батчем (общий сертификат на много сайтов).
  const certPaths = [
    ...new Set(
      parsed.sites
        .map((b) => b.sslCertificate ?? parsed.httpSslCertificate)
        .filter((p): p is string => Boolean(p)),
    ),
  ];
  const certs = await readCerts(profile, source, certPaths);

  snap.sites = parsed.sites.map((block) => {
    const { certPath, ...site } = toSiteEntry(block, httpDefaults);
    if (certPath) {
      const pem = certs.get(certPath);
      if (pem === undefined) {
        site.cert = { path: certPath, error: 'файл не прочитан' };
      } else {
        const info = certInfoFromPem(pem);
        site.cert = info
          ? { path: certPath, notAfter: info.notAfter.toISOString(), daysLeft: info.daysLeft }
          : { path: certPath, error: 'не удалось разобрать PEM' };
      }
    }
    return site;
  });
  return snap;
}

async function collectNginxUncached(profile: Profile): Promise<NginxSnapshot> {
  const sources = await discoverNginx(profile);
  const sourceSnaps = await Promise.all(
    sources.map((s) =>
      collectSource(profile, s).catch((err) => {
        // Источник упал на exec (таймаут, обрыв SSH) — секция с ошибкой,
        // снапшот в целом не падает (решение 1, allSettled-семантика).
        const snap = sourceBase(s);
        snap.error = (err as Error).message;
        return snap;
      }),
    ),
  );
  return { timestamp: Date.now(), sources: sourceSnaps };
}

/**
 * Снимок nginx-сайтов профиля. Кэш 2 с на профиль (параллельные вызовы
 * делят одни exec'ы) — как у портов/метрик; reject удаляет запись из кэша.
 * nginx не найден нигде → `{timestamp, sources: []}` — пустое состояние
 * решает UI, не 404.
 */
export function getNginxSnapshot(profile: Profile): Promise<NginxSnapshot> {
  const now = Date.now();
  const hit = snapshotCache.get(profile.id);
  if (hit && now - hit.at < SNAPSHOT_CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = collectNginxUncached(profile);
  snapshotCache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (snapshotCache.get(profile.id)?.promise === promise) {
      snapshotCache.delete(profile.id);
    }
  });
  return promise;
}

/** Очистка кэшей профиля при его удалении (паттерн clearHistory в metrics-history). */
export function clearNginxCaches(profileId: string): void {
  snapshotCache.delete(profileId);
  nativeCache.delete(profileId);
  for (const key of certCache.keys()) {
    if (key.startsWith(`${profileId}:`)) certCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// nginx -t / reload с guard'ом (решение 4)
// ---------------------------------------------------------------------------

export interface NginxTestResult {
  ok: boolean;
  output: string;
}

/** `nginx -t`: вывод читается из stderr (nginx пишет туда), + stdout. */
export async function testNginxConfig(
  profile: Profile,
  source: NginxSourceRef,
): Promise<NginxTestResult> {
  const r = await runSource(profile, buildTestCmd(source));
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
}

/** Guard reload'а: при красном `nginx -t` reload не выполняется. */
export class NginxTestFailedError extends Error {
  readonly code = 'NGINX_TEST_FAILED';
  readonly output: string;

  constructor(output: string) {
    super('nginx -t не прошёл — перезагрузка отменена');
    this.name = 'NginxTestFailedError';
    this.output = output;
  }
}

/** Reload: сначала `nginx -t`; тест красный → NginxTestFailedError (409 в роуте). */
export async function reloadNginx(
  profile: Profile,
  source: NginxSourceRef,
): Promise<NginxTestResult> {
  const test = await testNginxConfig(profile, source);
  if (!test.ok) throw new NginxTestFailedError(test.output);
  const r = await runSource(profile, buildReloadCmd(source));
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
}

/** Парсинг source из тела запроса: 'native' | 'container:<id>'. */
export function parseSourceRef(raw: string): NginxSourceRef | null {
  if (raw === 'native') return { type: 'native', bin: '' };
  if (raw.startsWith('container:')) {
    const containerId = raw.slice('container:'.length);
    if (containerId) return { type: 'container', containerId, containerName: '' };
  }
  return null;
}

/**
 * Валидация источника против актуального discovery: нельзя адресовать
 * произвольный контейнер — только реально обнаруженные (решение 2).
 * Возвращает реальный источник (с bin/именем) или null.
 */
export async function findSource(
  profile: Profile,
  raw: string,
): Promise<NginxSourceRef | null> {
  const ref = parseSourceRef(raw);
  if (!ref) return null;
  const sources = await discoverNginx(profile);
  return (
    sources.find((s) => {
      if (s.type === 'container' && ref.type === 'container') {
        return s.containerId === ref.containerId;
      }
      return s.type === 'native' && ref.type === 'native';
    }) ?? null
  );
}
