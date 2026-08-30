import { useEffect, useState } from 'react';
import { fetchAiUsage, formatUsd } from '../api';
import type { AiUsageAgg, AiUsageDay, AiUsageReport } from '../api';
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';

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

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

const POLL_INTERVAL_MS = 60_000;

const PERIODS: Array<{ labelKey: I18nKey; value: number | 'all' }> = [
  { labelKey: 'aiCosts.period7', value: 7 },
  { labelKey: 'aiCosts.period30', value: 30 },
  { labelKey: 'aiCosts.period90', value: 90 },
  { labelKey: 'aiCosts.periodAll', value: 'all' },
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

function cellTooltip(agg: AiUsageAgg, t: TFn, locale: string): string {
  const parts = [
    t('aiCosts.tipCalls', { n: agg.calls }),
    t('aiCosts.tipPrompt', { n: agg.promptTokens.toLocaleString(locale) }),
    t('aiCosts.tipCached', { n: agg.cachedTokens.toLocaleString(locale) }),
    t('aiCosts.tipCompletion', { n: agg.completionTokens.toLocaleString(locale) }),
  ];
  if (agg.unpricedCalls > 0) {
    parts.push(t('aiCosts.tipUnpriced', { n: agg.unpricedCalls }));
  }
  return parts.join('\n');
}

/** Ячейка матрицы: стоимость; запросы и токены — в tooltip. */
function CostCell({ agg }: { agg: AiUsageAgg }) {
  const { t, locale } = useT();
  return (
    <span className="cost-cell" title={cellTooltip(agg, t, locale)}>
      {formatUsd(agg.costUsd)}
      {agg.unpricedCalls > 0 ? '*' : ''}
    </span>
  );
}

function formatDay(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

export function AiCostsPage({ visible }: Props) {
  const { t, locale } = useT();
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
            ? t('aiCosts.noConnection', { error })
            : report
              ? t('common.updated', { time: new Date(updatedAt).toLocaleTimeString(locale) })
              : t('common.loading')}
        </span>
        <select
          className="search-input"
          value={String(days)}
          onChange={(e) => setDays(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          title={t('aiCosts.periodTitle')}
        >
          {PERIODS.map((p) => (
            <option key={String(p.value)} value={String(p.value)}>
              {t(p.labelKey)}
            </option>
          ))}
        </select>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error && !report ? (
        <div className="empty-state">
          <p>{t('aiCosts.loadFailed', { error })}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          {report && (
            <>
              <div className="cost-cards">
                <div className="cost-card">
                  <div className="cost-card-label">{t('aiCosts.totalForPeriod')}</div>
                  <div className="cost-card-value">{formatUsd(report.totals.costUsd)}</div>
                </div>
                <div className="cost-card">
                  <div className="cost-card-label">{t('aiCosts.avgPerDay')}</div>
                  <div className="cost-card-value">
                    {formatUsd(report.days.length ? report.totals.costUsd / report.days.length : 0)}
                  </div>
                </div>
                <div className="cost-card">
                  <div className="cost-card-label">{t('aiCosts.calls')}</div>
                  <div className="cost-card-value">{report.totals.calls.toLocaleString(locale)}</div>
                </div>
              </div>
              {report.totals.unpricedCalls > 0 && (
                <p className="muted costs-hint">
                  * {t('aiCosts.unpricedHint', { n: report.totals.unpricedCalls })}{' '}
                  <code>data/ai-prices.json</code>.
                </p>
              )}
              <div className="costs-scroll">
                <table className="data-table cost-matrix">
                  <thead>
                    <tr>
                      <th className="col-date">{t('aiCosts.date')}</th>
                      {report.profiles.map((p) => (
                        <th key={p.id} title={p.name}>
                          {p.name}
                        </th>
                      ))}
                      <th>{t('aiCosts.total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.days.map((day: AiUsageDay) => (
                      <tr key={day.date}>
                        <td className="muted cost-date">{formatDay(day.date, locale)}</td>
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
                          {t('aiCosts.emptyPeriod')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {report.days.length > 0 && (
                    <tfoot>
                      <tr>
                        <td className="muted">{t('aiCosts.total')}</td>
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
              <p>{t('aiCosts.loading')}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
