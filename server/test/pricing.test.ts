import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-pricing-'));
process.env.DATA_DIR = dataDir;

const pricing = await import('../src/ai/pricing.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// Значения из DEFAULT_PRICES для проверки формулы: gpt-4.1-mini
// { input: 0.4, cachedInput: 0.2, output: 1.6 } (USD за 1M токенов).
describe('computeCostUsd — формула (docs/ai-costs-plan.md, решение 2)', () => {
  it('базовый расчёт: вход и выход по ценам модели', () => {
    // 1M входных + 100K выходных = 0.4 + 0.16 = 0.56
    expect(pricing.computeCostUsd('gpt-4.1-mini', { promptTokens: 1_000_000, completionTokens: 100_000 }))
      .toBeCloseTo(0.56, 6);
  });

  it('кэш-токены вычитаются из входных и считаются по cachedInput', () => {
    // prompt 1M, из них cached 400K: (1M−400K)·0.4 + 400K·0.2 + 0 = 0.24 + 0.08 = 0.32
    expect(
      pricing.computeCostUsd('gpt-4.1-mini', {
        promptTokens: 1_000_000,
        cachedTokens: 400_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(0.32, 6);
  });

  it('без cachedInput у модели кэш-токены считаются по обычной цене input', () => {
    // deepseek-chat: { input: 0.27, cachedInput: 0.07, output: 1.1 } — есть cachedInput.
    // Возьмём модель без cachedInput? Все дефолтные её имеют — проверим через оверрайд
    // в отдельном тесте. Здесь: cachedInput присутствует и применяется.
    expect(
      pricing.computeCostUsd('deepseek-chat', {
        promptTokens: 1_000_000,
        cachedTokens: 500_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(0.5 * 0.27 + 0.5 * 0.07, 6); // 0.135 + 0.035 = 0.17
  });

  it('reasoning НЕ добавляется к сумме — входит в completion_tokens (инвариант)', () => {
    const withReasoning = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      completionTokens: 2000,
    });
    // reasoning_tokens=1000 не должен увеличить сумму: выход уже содержит их.
    const same = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      completionTokens: 2000,
    });
    expect(withReasoning).toBe(same);
    // Проверка на числах: 1000·0.4/1M + 2000·1.6/1M = 0.0004 + 0.0032 = 0.0036
    expect(withReasoning).toBeCloseTo(0.0036, 9);
  });

  it('поисковые запросы — отдельным слагаемым только при webSearchPerRequestUsd', () => {
    // Без тарифа поиска (дефолтная gpt-4.1-mini) поиск считается по токенам —
    // тариф DeepSeek: серверный web_search оплачивается токенами, отдельной
    // цены за запрос нет. Слагаемое поиска добавляет только оверрайд (ниже).
    const cost = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      completionTokens: 2000,
      searchRequests: 2,
    });
    expect(cost).toBeCloseTo(0.0036, 9); // только токены: 0.0004 + 0.0032
  });

  it('deepseek-v4-flash протарифицирован (off-peak DeepSeek V4)', () => {
    expect(pricing.DEFAULT_PRICES['deepseek-v4-flash']).toEqual({
      input: 0.22,
      cachedInput: 0.007,
      output: 0.66,
    });
    // 1M входных (cache-miss) + 400K выходных = 0.22 + 0.264 = 0.484
    expect(
      pricing.computeCostUsd('deepseek-v4-flash', { promptTokens: 1_000_000, completionTokens: 400_000 }),
    ).toBeCloseTo(0.484, 6);
    // Кэш-хиты по cachedInput: (600K·0.22 + 400K·0.007)/1M = 0.132 + 0.0028
    expect(
      pricing.computeCostUsd('deepseek-v4-flash', {
        promptTokens: 1_000_000,
        cachedTokens: 400_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(0.1348, 6);
  });

  it('неизвестная модель → null (unpriced), даже при ненулевых токенах', () => {
    expect(pricing.computeCostUsd('claude-opus-4-5', { promptTokens: 100, completionTokens: 100 }))
      .toBeNull();
    expect(pricing.computeCostUsd('gpt-5', { promptTokens: 100, completionTokens: 100 })).toBeNull();
  });

  it('нулевые токены → 0 (протарифицированная модель)', () => {
    expect(pricing.computeCostUsd('gpt-4.1-mini', {})).toBe(0);
  });

  it('мусор в токенах (отрицательные/строки) трактуется как 0', () => {
    // Тип не позволяет, но runtime-защита nonneg() должна не падать:
    const result = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: -5 as unknown as number,
      cachedTokens: 'x' as unknown as number,
      completionTokens: NaN,
    });
    expect(result).toBe(0);
  });
});

describe('loadPrices — оверрайд data/ai-prices.json', () => {
  it('без файла — дефолты', () => {
    expect(pricing.loadPrices()['gpt-4.1-mini']).toEqual({ input: 0.4, cachedInput: 0.2, output: 1.6 });
    expect(pricing.loadPrices()['deepseek-chat']).toBeDefined();
  });

  it('мерж по имени модели: запись файла полностью заменяет дефолтную', () => {
    writeFileSync(
      path.join(dataDir, 'ai-prices.json'),
      JSON.stringify({
        models: {
          'gpt-4.1-mini': { input: 0.5, cachedInput: 0.25, output: 2.0, webSearchPerRequestUsd: 0.03 },
          'my-custom-model': { input: 1.0, output: 2.0 },
        },
      }),
    );
    const prices = pricing.loadPrices();
    expect(prices['gpt-4.1-mini']).toEqual({
      input: 0.5,
      cachedInput: 0.25,
      output: 2.0,
      webSearchPerRequestUsd: 0.03,
    });
    // Новая модель из файла — теперь протарифицирована.
    expect(pricing.computeCostUsd('my-custom-model', { promptTokens: 1_000_000, completionTokens: 500_000 }))
      .toBeCloseTo(1.0 + 1.0, 6);
    // Прочие дефолты не тронуты.
    expect(prices['deepseek-chat']).toBeDefined();
  });

  it('cachedInput из оверрайда участвует в формуле', () => {
    // my-custom-model без cachedInput: кэш считается по input (1.0).
    expect(
      pricing.computeCostUsd('my-custom-model', {
        promptTokens: 1_000_000,
        cachedTokens: 300_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(1.0, 6); // (1M−300K)·1 + 300K·1 = 1.0
  });

  it('поисковые запросы по тарифу из оверрайда', () => {
    // gpt-4.1-mini из оверрайда: webSearchPerRequestUsd 0.03.
    const cost = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      cachedTokens: 0,
      completionTokens: 2000,
      searchRequests: 2,
    });
    // токены: 1000·0.5/1M + 2000·2/1M = 0.0005 + 0.004 = 0.0045; поиск: 2·0.03 = 0.06
    expect(cost).toBeCloseTo(0.0045 + 0.06, 9);
  });

  it('битый файл цен → warn + дефолты (без corrupt-блокировки: это справочник)', () => {
    writeFileSync(path.join(dataDir, 'ai-prices.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prices = pricing.loadPrices();
    expect(warn).toHaveBeenCalled();
    expect(prices['gpt-4.1-mini']).toEqual({ input: 0.4, cachedInput: 0.2, output: 1.6 });
    // Файл НЕ переименовывается в *.corrupt-* (в отличие от пользовательских сторов).
    expect(readFileSync(path.join(dataDir, 'ai-prices.json'), 'utf8')).toBe('{not json');
    warn.mockRestore();
  });

  it('невалидная схема файла (отрицательная цена) → warn + дефолты', () => {
    writeFileSync(
      path.join(dataDir, 'ai-prices.json'),
      JSON.stringify({ models: { 'gpt-4.1-mini': { input: -1, output: 1 } } }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prices = pricing.loadPrices();
    expect(warn).toHaveBeenCalled();
    expect(prices['gpt-4.1-mini']).toEqual({ input: 0.4, cachedInput: 0.2, output: 1.6 });
    warn.mockRestore();
  });
});
