import type { ServerMetrics } from './metrics.js';

/**
 * Лёгкий срез снимка метрик для графика нагрузки: процессы, диски и прочие
 * тяжёлые поля не копятся — только то, что рисуется на «Обзоре» и «Серверах».
 */
export interface HistorySample {
  /** Момент снимка (мс, серверное время ssh-commander). */
  t: number;
  cpu: number | null;
  memPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  load1: number | null;
}

// Минимальный промежуток между сэмплами — равен TTL кэша collectMetrics:
// кэш возвращает тот же промис (тот же timestamp), повторная запись не нужна,
// а два независимых снимка ближе 2 с всё равно не случаются.
const MIN_SAMPLE_GAP_MS = 2000;
// ~12 ч при базовом 10-с опросе (сайдбар), ~3,5 ч при плотном 3-с («Обзор»).
const MAX_SAMPLES_PER_PROFILE = 4320;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Хранилище только в памяти: история живёт, пока работает процесс и интерфейс
// её кормит опросами (как реестр туннелей). После рестарта копится заново.
const history = new Map<string, HistorySample[]>();

export function toSample(metrics: ServerMetrics): HistorySample {
  return {
    t: metrics.timestamp,
    cpu: metrics.cpu.percent,
    memPct: metrics.memory.usedPercent,
    memUsedBytes: metrics.memory.usedBytes,
    memTotalBytes: metrics.memory.totalBytes,
    load1: metrics.loadAverage ? metrics.loadAverage[0] : null,
  };
}

/** Сэмпл стоит записать: первый для профиля либо отстоящий от последнего ≥ 2 с. */
export function shouldAppend(samples: HistorySample[], sample: HistorySample): boolean {
  const last = samples[samples.length - 1];
  if (!last) return true;
  return sample.t - last.t >= MIN_SAMPLE_GAP_MS;
}

/**
 * Обрезка истории: выбрасываются сэмплы старше maxAgeMs и всё, что сверх
 * maxSamples (остаются самые свежие). Массив не копируется, если резать нечего.
 */
export function trimSamples(
  samples: HistorySample[],
  now: number,
  maxSamples: number = MAX_SAMPLES_PER_PROFILE,
  maxAgeMs: number = MAX_AGE_MS,
): HistorySample[] {
  const minT = now - maxAgeMs;
  let start = 0;
  while (start < samples.length && samples[start].t < minT) start++;
  let out = start > 0 ? samples.slice(start) : samples;
  if (out.length > maxSamples) {
    out = out.slice(out.length - maxSamples);
  }
  return out;
}

/**
 * Равномерная выборка до maxPoints точек (первая и последняя сохраняются),
 * чтобы ответ API не раздувался при больших окнах истории. Всегда возвращает
 * новый массив — вызывающий может его мутировать, не задев реестр.
 */
export function decimate(samples: HistorySample[], maxPoints: number): HistorySample[] {
  if (samples.length <= maxPoints) return samples.slice();
  const step = (samples.length - 1) / (maxPoints - 1);
  const out: HistorySample[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    out.push(samples[Math.floor(i * step)]);
  }
  out.push(samples[samples.length - 1]);
  return out;
}

/** Записать сэмпл из свежего снимка (вызывается из collectMetrics). */
export function appendSample(profileId: string, metrics: ServerMetrics): void {
  const samples = history.get(profileId) ?? [];
  const sample = toSample(metrics);
  if (!shouldAppend(samples, sample)) return;
  history.set(profileId, trimSamples([...samples, sample], sample.t));
}

/**
 * История одного профиля (копия, прореженная до maxPoints). Возраст отмеряется
 * и при отдаче — по wall clock: пока профиль лежит и новых сэмплов нет,
 * вчерашние точки не должны выглядеть актуальными (trimSamples при записи
 * отрезает хвост только относительно свежего сэмпла).
 */
export function getHistory(profileId: string, maxPoints = 360): HistorySample[] {
  const samples = history.get(profileId);
  if (!samples) return [];
  return decimate(trimSamples(samples, Date.now()), maxPoints);
}

/** История всех профилей для сводного экрана «Серверы». */
export function getAllHistory(
  maxPoints = 120,
): Array<{ id: string; samples: HistorySample[] }> {
  return [...history.entries()].map(([id, samples]) => ({
    id,
    samples: decimate(trimSamples(samples, Date.now()), maxPoints),
  }));
}

/** Удаляется вместе с профилем, чтобы реестр не тек. */
export function clearHistory(profileId: string): void {
  history.delete(profileId);
}
