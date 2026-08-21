import { useEffect, useState } from 'react';
import { fetchAiUsage, formatUsd } from '../api';
import type { AiUsageAgg, AiUsageDay, AiUsageReport } from '../api';

/**
 * Вкладка «ИИ-расходы» (docs/ai-costs-plan.md): глобальная страница вне
 * таббара профиля (как «Серверы»). Отчёт по дням × профилям с итогами.
 * Данные кросс-профильные: затраты привязаны к домашнему профилю диалога.
 * Ошибки загрузки показываются через empty-state (showError не нужен —
 * страница read-only, тостов нет).
 */
interface Props {
  visible: boolean;
}

const POLL_INTERVAL_MS = 60_000;

const PERIODS: Array<{ label: string; value: number | 'all' }> = [
  { label: '7 дней', value: 7 },
  { label: '30 дней', value: 30 },
  { label: '90 дней', value: 90 },
  { label: 'Всё время', value: 'all' },
];

const emptyAgg = (): AiUsageAgg => ({
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
});

function sumAgg(aggs: Array<AiUsageAgg | undefined>): AiUsageAgg {
  const total = emptyAgg();
  for (const a of aggs) {
    if (!a) continue;
    total.calls += a.calls;
    total.promptTokens += a.promptTokens;
    total.cachedTokens += a.cachedTokens;
    total.completionTokens += a.completionTokens;
    total.costUsd += a.costUsd;
    total.unpricedCalls += a.unpricedCalls;
  }
  return total;
}

function cellTooltip(agg: AiUsageAgg): string {
  const parts = [
    `Запросов: ${agg.calls}`,
    `Вход: ${agg.promptTokens.toLocaleString('ru-RU')} токенов`,
    `Кэш входа: ${agg.cachedTokens.toLocaleString('ru-RU')} токенов`,
    `Выход: ${agg.completionTokens.toLocaleString('ru-RU')} токенов`,
  ];
  if (agg.unpricedCalls > 0) {
    parts.push(`Неполная сумма: ${agg.unpricedCalls} вызовов без цены`);
  }
  return parts.join('\n');
}

/** Ячейка матрицы: стоимость; запросы и токены — в tooltip. */
function CostCell({ agg }: { agg: AiUsageAgg }) {
  return (
    <span className="cost-cell" title={cellTooltip(agg)}>
      {formatUsd(agg.costUsd)}
      {agg.unpricedCalls > 0 ? '*' : ''}
    </span>
  );
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

export function AiCostsPage({ visible }: Props) {
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number | 'all'>(30);
  const [updatedAt, setUpdatedAt] = useState<number>(0);
  const [reloadKey, setReloadKey] = useState(0);

  // Загрузка при видимости + polling 60 с; на паузе при скрытой вкладке.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await fetchAiUsage(days);
        if (cancelled) return;
        setReport(r);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (cancelled) return;
        // Фоновая ошибка при уже показанном отчёте не роняет страницу —
        // остаётся последний снимок, статус в тулбаре показывает «нет связи».
        setError((err as Error).message);
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [visible, days, reloadKey]);

  // Итог по колонке профиля (сумма по всем дням отчёта).
  const profileTotals = (report?.profiles ?? []).map((p) => ({
    profile: p,
    total: sumAgg((report?.days ?? []).map((d) => d.byProfile[p.id])),
  }));

  return (
    <div className="page costs-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? `Нет связи: ${error}`
            : report
              ? `Обновлено ${new Date(updatedAt).toLocaleTimeString('ru-RU')}`
              : 'Загрузка…'}
        </span>
        <select
          className="search-input"
          value={String(days)}
          onChange={(e) => setDays(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          title="Период отчёта"
        >
          {PERIODS.map((p) => (
            <option key={String(p.value)} value={String(p.value)}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      {error && !report ? (
        <div className="empty-state">
          <p>Не удалось загрузить отчёт о расходах: {error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      ) : (
        <>
          {report && (
            <>
              <div className="cost-cards">
                <div className="cost-card">
                  <div className="cost-card-label">Всего за период</div>
                  <div className="cost-card-value">{formatUsd(report.totals.costUsd)}</div>
                </div>
                <div className="cost-card">
                  <div className="cost-card-label">Среднее в день</div>
                  <div className="cost-card-value">
                    {formatUsd(report.days.length ? report.totals.costUsd / report.days.length : 0)}
                  </div>
                </div>
                <div className="cost-card">
                  <div className="cost-card-label">Запросов</div>
                  <div className="cost-card-value">{report.totals.calls.toLocaleString('ru-RU')}</div>
                </div>
              </div>
              {report.totals.unpricedCalls > 0 && (
                <p className="muted costs-hint">
                  * {report.totals.unpricedCalls} вызовов без цены модели — суммы неполны. Добавьте цены
                  в <code>data/ai-prices.json</code>.
                </p>
              )}
              <div className="costs-scroll">
                <table className="data-table cost-matrix">
                  <thead>
                    <tr>
                      <th className="col-date">Дата</th>
                      {report.profiles.map((p) => (
                        <th key={p.id} title={p.name}>
                          {p.name}
                        </th>
                      ))}
                      <th>Итого</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.days.map((day: AiUsageDay) => (
                      <tr key={day.date}>
                        <td className="muted cost-date">{formatDay(day.date)}</td>
                        {report.profiles.map((p) => {
                          const agg = day.byProfile[p.id];
                          return (
                            <td key={p.id} className="cost-cell-td">
                              {agg ? <CostCell agg={agg} /> : '—'}
                            </td>
                          );
                        })}
                        <td className="cost-cell-td">
                          <CostCell agg={day.total} />
                        </td>
                      </tr>
                    ))}
                    {report.days.length === 0 && (
                      <tr>
                        <td colSpan={report.profiles.length + 2} className="muted">
                          За выбранный период расходов нет
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {report.days.length > 0 && (
                    <tfoot>
                      <tr>
                        <td className="muted">Итого</td>
                        {profileTotals.map(({ profile, total }) => (
                          <td key={profile.id} className="cost-cell-td">
                            {total.calls > 0 ? <CostCell agg={total} /> : '—'}
                          </td>
                        ))}
                        <td className="cost-cell-td">
                          <CostCell agg={report.totals} />
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </>
          )}
          {!report && !error && (
            <div className="empty-state">
              <p>Загрузка отчёта о расходах…</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
