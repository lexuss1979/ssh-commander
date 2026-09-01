import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import {
  createDbConnection,
  deleteDbConnection,
  downloadDbDump,
  fetchDbColumns,
  fetchDbConnections,
  fetchDbDiscovery,
  fetchDbOverview,
  fetchDbTables,
  fetchDbTableDetail,
  formatSize,
  runDbQuery,
  testDbConnection,
  updateDbConnection,
  type DbColumnInfo,
  type DbConnectionInfo,
  type DbConnectionInput,
  type DbEngine,
  type DbHint,
  type DbOverview,
  type DbQueryErrorInfo,
  type DbQueryResult,
  type DbSuggestion,
  type DbTableDetail,
  type DbTableInfo,
  type MysqlFlavor,
} from '../api';
import type { AgentAskMode, Profile } from '../types';
import { useT } from '../i18n';

// Редактор с подсветкой — тот же чанк, что и в файловом менеджере
const CodeEditor = lazy(() => import('../components/CodeEditor'));

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  /** «Спросить агента»: собрать промпт с движком и схемой в AgentPage. */
  onAskAgent: (text: string, mode?: AgentAskMode, source?: string) => void;
  /** Одноразовая вставка SQL из чата агента (кнопка «→ SQL»), расходуется эффектом. */
  sqlInsert?: { id: number; sql: string } | null;
  onSqlInsertConsumed?: () => void;
}

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL/MariaDB',
};

const HISTORY_KEY = (profileId: string) => `sc-db-history-${profileId}`;
const HISTORY_LIMIT = 50;
/** Лимит контекста схемы для «Спросить агента» (как у терминала). */
const SCHEMA_CONTEXT_LIMIT = 4096;

/** Короткая версия: «PostgreSQL 16.4» из полной строки version(), «8.0.36» из @@version. */
function shortVersion(engine: string, version: string): string {
  if (!version) return '';
  if (engine === 'postgres') {
    const m = /PostgreSQL\s+(\d+(\.\d+)*)/i.exec(version);
    return m ? `PostgreSQL ${m[1]}` : version.split(',')[0];
  }
  const m = /^(\d+(?:\.\d+){0,2})/.exec(version.trim());
  return m ? m[1] : version.split(',')[0];
}

/** Схема для промпта агента: «schema.table (col1, col2, …)» по строке на
 * таблицу; колонок нет — имена таблиц. */
function buildSchemaText(tables: DbTableInfo[] | null, columns: DbColumnInfo[] | null): string {
  if (columns && columns.length > 0) {
    const byTable = new Map<string, string[]>();
    for (const c of columns) {
      const key = `${c.schema}.${c.table}`;
      const list = byTable.get(key) ?? [];
      list.push(c.name);
      byTable.set(key, list);
    }
    return [...byTable.entries()].map(([t, cols]) => `- ${t} (${cols.join(', ')})`).join('\n');
  }
  return (tables ?? []).map((t) => `- ${t.schema}.${t.name}`).join('\n');
}

function loadHistory(profileId: string): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY(profileId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory(profileId: string, items: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY(profileId), JSON.stringify(items));
  } catch {
    /* localStorage может быть недоступен */
  }
}

/** Палитра истории запросов (паттерн Ctrl+R терминала, данные — localStorage). */
function QueryHistoryPalette({
  history,
  onPick,
  onClose,
}: {
  history: string[];
  onPick: (sql: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return history;
    return history.filter((c) => c.toLowerCase().includes(q));
  }, [history, filter]);

  useEffect(() => {
    setSelected(0);
  }, [filter]);

  useEffect(() => {
    listRef.current
      ?.querySelector('.history-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[selected];
      if (cmd) onPick(cmd);
    }
  };

  return (
    <div className="history-palette" onKeyDown={onKeyDown}>
      <input
        className="history-filter"
        autoFocus
        placeholder={t('databases.historyPlaceholder')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="history-list" ref={listRef}>
        {filtered.length === 0 && (
          <div className="history-empty">
            {history.length === 0 ? t('databases.historyEmpty') : t('databases.historyNoMatches')}
          </div>
        )}
        {filtered.map((sql, i) => (
          <button
            key={`${i}:${sql}`}
            type="button"
            className={`history-item${i === selected ? ' selected' : ''}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => onPick(sql)}
          >
            {sql}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Форма подключения (модалка): креденшалы задаются явно, как в DBeaver.
 * Discovery автозаполняет движок/пользователя/базу из env контейнера —
 * но это подсказка: env мог протухнуть, источник истины — человек.
 */
function ConnectionModal({
  profileId,
  editing,
  onClose,
  onSaved,
  onDeleted,
  showError,
}: {
  profileId: string;
  editing: DbConnectionInfo | null;
  onClose: () => void;
  onSaved: (conn: DbConnectionInfo) => void;
  onDeleted: (id: string) => void;
  showError: (msg: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(editing?.name ?? '');
  const [engine, setEngine] = useState<DbEngine>(editing?.engine ?? 'postgres');
  const [containerId, setContainerId] = useState(
    editing?.target.kind === 'container' ? editing.target.containerId : '',
  );
  const [username, setUsername] = useState(editing?.username ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [defaultDatabase, setDefaultDatabase] = useState(editing?.defaultDatabase ?? '');
  const [flavor, setFlavor] = useState<MysqlFlavor | undefined>(editing?.flavor);

  const [suggestions, setSuggestions] = useState<DbSuggestion[] | null>(null);
  const [hints, setHints] = useState<DbHint[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ phase: 'ok' | 'error'; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDbDiscovery(profileId)
      .then((res) => {
        if (cancelled) return;
        setSuggestions(res.suggestions);
        setHints(res.hints ?? []);
      })
      .catch((err) => {
        if (!cancelled) setDiscoveryError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  // Выбор контейнера автозаполняет форму подсказками discovery (движок,
  // пользователь, база, семейство mysql/mariadb; имя — только если пусто).
  const pickContainer = (id: string) => {
    setContainerId(id);
    const s = suggestions?.find((x) => x.id === id);
    if (!s) return;
    setEngine(s.engine);
    setUsername(s.suggestedUser);
    setDefaultDatabase(s.suggestedDatabase ?? '');
    setFlavor(s.flavor);
    setName((prev) => prev || s.name);
  };

  const buildInput = (): DbConnectionInput => ({
    profileId,
    name: name.trim(),
    engine,
    target: { kind: 'container', containerId: containerId.trim() },
    username: username.trim(),
    ...(password ? { password } : {}),
    ...(defaultDatabase.trim() ? { defaultDatabase: defaultDatabase.trim() } : {}),
    ...(engine === 'mysql' && flavor ? { flavor } : {}),
  });

  const save = async () => {
    if (!name.trim() || !containerId.trim() || !username.trim()) {
      showError(t('databases.errorRequiredFields'));
      return;
    }
    setBusy(true);
    try {
      const conn = editing
        ? await updateDbConnection(editing.id, buildInput())
        : await createDbConnection(buildInput());
      onSaved(conn);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!containerId.trim() || !username.trim()) {
      showError(t('databases.errorTestRequiredFields'));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const input = buildInput();
      await testDbConnection(editing ? { ...input, id: editing.id } : input);
      setTestResult({ phase: 'ok', message: t('databases.testOk') });
    } catch (err) {
      const info = (err as { info?: DbQueryErrorInfo }).info;
      setTestResult({
        phase: 'error',
        message: info?.stderr || info?.message || (err as Error).message,
      });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!window.confirm(t('databases.deleteConfirm', { name: editing.name }))) return;
    setBusy(true);
    try {
      await deleteDbConnection(editing.id);
      onDeleted(editing.id);
    } catch (err) {
      showError((err as Error).message);
      setBusy(false);
    }
  };

  // Контейнер правки мог не попасть в свежий discovery (перезапущен под
  // другим id) — показываем сохранённый id отдельной опцией.
  const editingContainerId =
    editing?.target.kind === 'container' ? editing.target.containerId : null;
  const editingContainerMissing =
    editingContainerId !== null && !suggestions?.some((s) => s.id === editingContainerId);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <h2>{editing ? t('databases.editTitle') : t('databases.newTitle')}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label className="span-2">
              {t('databases.fieldContainer')}
              <select value={containerId} onChange={(e) => pickContainer(e.target.value)}>
                <option value="">{t('databases.selectContainer')}</option>
                {suggestions?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.image})
                  </option>
                ))}
                {editingContainerMissing && editingContainerId && (
                  <option value={editingContainerId}>
                    {editingContainerId}{t('databases.savedSuffix')}
                  </option>
                )}
              </select>
              <span className="field-hint">
                {discoveryError
                  ? t('databases.discoveryError', { error: discoveryError })
                  : suggestions === null
                    ? t('databases.loadingContainers')
                    : suggestions.length === 0
                      ? t('databases.noContainers')
                      : t('databases.pickHint')}
              </span>
            </label>
            <label>
              {t('databases.fieldEngine')}
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as DbEngine)}
              >
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL / MariaDB</option>
              </select>
            </label>
            <label>
              {t('databases.fieldName')}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="prod-postgres"
              />
            </label>
            <label>
              {t('databases.fieldUsername')}
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="postgres / root"
              />
            </label>
            <label>
              {t('databases.fieldPassword')}
              <div className="inline-field">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editing ? t('databases.passwordPlaceholderEdit') : t('databases.passwordPlaceholderNew')}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? t('databases.hidePassword') : t('databases.showPassword')}
                </button>
              </div>
              <span className="field-hint">
                {t('databases.passwordHint')}
              </span>
            </label>
            <label>
              {t('databases.fieldDefaultDatabase')}
              <input
                value={defaultDatabase}
                onChange={(e) => setDefaultDatabase(e.target.value)}
                placeholder="postgres"
              />
            </label>
          </div>

          {hints.length > 0 && (
            <div className="db-hints">
              {hints.map((h) => (
                <p key={h.id} className="muted" title={t('databases.hintTitle', { name: h.name, port: h.port })}>
                  {t('databases.hintText', { name: h.name, port: h.port })}
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy || testing}>
            {busy ? t('databases.saving') : t('common.save')}
          </button>
          <button className="btn" onClick={runTest} disabled={busy || testing}>
            {testing ? t('databases.testing') : t('databases.testConnection')}
          </button>
          {editing && (
            <button className="btn btn-danger" onClick={remove} disabled={busy || testing}>
              {t('common.delete')}
            </button>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
        </div>
        {testResult && (
          <p className={`test-result ${testResult.phase === 'ok' ? 'test-result-ok' : 'test-result-error'}`}>
            {testResult.message}
          </p>
        )}
      </div>
    </div>
  );
}

export function DatabasesPage({
  profile,
  showError,
  visible,
  onAskAgent,
  sqlInsert,
  onSqlInsertConsumed,
}: Props) {
  const { t } = useT();
  // Подключения (обновление по кнопке и после правок — polling нет)
  const [connections, setConnections] = useState<DbConnectionInfo[] | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<DbConnectionInfo | null>(null);

  // Выбор: подключение → база → таблицы/колонки
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [overview, setOverview] = useState<DbOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [database, setDatabase] = useState<string | null>(null);
  const [tables, setTables] = useState<DbTableInfo[] | null>(null);
  /** Ошибка загрузки таблиц: пустой список и сбой — разные состояния. */
  const [tablesError, setTablesError] = useState<string | null>(null);
  /** Колонки выбранной базы — для схемы в промпте «Спросить агента». */
  const [columns, setColumns] = useState<DbColumnInfo[] | null>(null);
  /** Сервер обрезал колонки по лимиту (4000) — пометка в промпте. */
  const [columnsTruncated, setColumnsTruncated] = useState(false);

  // Раскрытие таблицы (поля + индексы): ключ `${schema}.${name}` → детали.
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [tableDetails, setTableDetails] = useState<Record<string, DbTableDetail>>({});
  const [tableDetailLoading, setTableDetailLoading] = useState<Record<string, boolean>>({});
  const tableDetailKey = (t: DbTableInfo) => `${t.schema}.${t.name}`;

  // Консоль
  const [sql, setSql] = useState('');
  /** Только чтение: защита от случайности (серверный SET перед запросом),
   * не персистится — каждая монтировка вкладки начинается с ON. */
  const [readOnly, setReadOnly] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [queryError, setQueryError] = useState<DbQueryErrorInfo | null>(null);
  const [dumping, setDumping] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(() => loadHistory(profile.id));
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Счётчик контекста: инкремент при смене подключения/базы — ответ
   * выполнявшегося запроса, вернувшийся после смены, не трогает стейт. */
  const runSeqRef = useRef(0);
  const dbRootRef = useRef<HTMLDivElement>(null);
  /** Курсор над вкладкой: Ctrl+R перехватываем при фокусе внутри вкладки ИЛИ
   * при наведённом курсоре — после закрытия палитры фокус падает на body и
   * без hover второй Ctrl+R улетал бы в reload страницы. */
  const dbHoverRef = useRef(false);

  const connection = useMemo(
    () => connections?.find((c) => c.id === connectionId) ?? null,
    [connections, connectionId],
  );

  // Загрузка списка подключений при первом показе вкладки и по кнопке.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setConnectionsError(null);
    fetchDbConnections(profile.id)
      .then((list) => {
        if (cancelled) return;
        setConnections(list);
        // Первое подключение выбирается автоматически; выбранное удалено —
        // переходим на первое оставшееся.
        setConnectionId((prev) =>
          prev && list.some((c) => c.id === prev) ? prev : list[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setConnectionsError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, visible, reloadKey]);

  // Сменилось подключение — тащим обзор (версия, базы с размерами). Прошлые
  // база/таблицы/результаты недействительны сразу: без сброса database
  // таблицы успели бы запроситься у нового подключения со старой базой.
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    runSeqRef.current++;
    setOverview(null);
    setOverviewError(null);
    setTables(null);
    setTablesError(null);
    setColumns(null);
    setColumnsTruncated(false);
    setDatabase(null);
    setResult(null);
    setQueryError(null);
    fetchDbOverview(profile.id, connectionId)
      .then((res) => {
        if (cancelled) return;
        setOverview(res);
        // Первая база выбирается автоматически — сразу можно писать SELECT.
        setDatabase(res.databases[0]?.name ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setOverviewError((err as Error).message);
        setDatabase(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, connectionId]);

  // Сменилась база — список таблиц и колонки; результаты прошлого контекста
  // больше не относятся к экрану.
  useEffect(() => {
    if (!connectionId || !database) {
      setTables(null);
      setTablesError(null);
      setColumns(null);
      setColumnsTruncated(false);
      return;
    }
    runSeqRef.current++;
    setResult(null);
    setQueryError(null);
    let cancelled = false;
    setTables(null);
    setTablesError(null);
    setColumns(null);
    setColumnsTruncated(false);
    fetchDbTables(profile.id, connectionId, database)
      .then((res) => {
        if (!cancelled) setTables(res);
      })
      .catch((err) => {
        // Сбой не маскируем пустым списком: «Таблиц нет» и «не загрузились» —
        // разные состояния, ошибка видна прямо в секции.
        if (cancelled) return;
        setTablesError((err as Error).message);
      });
    // Колонки — вспомогательные (схема для агента): тишина при неудаче.
    fetchDbColumns(profile.id, connectionId, database)
      .then((res) => {
        if (!cancelled) {
          setColumns(res.columns);
          setColumnsTruncated(Boolean(res.truncated));
        }
      })
      .catch(() => {
        if (!cancelled) setColumns(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, connectionId, database, showError]);

  // Ctrl+R — палитра истории запросов (как в терминале). Перехватываем при
  // фокусе внутри вкладки или наведённом на неё курсоре: в панели агента и
  // вне вкладки Ctrl+R остаётся браузерным reload.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.key.toLowerCase() !== 'r') return;
      const inPage =
        dbHoverRef.current || dbRootRef.current?.contains(document.activeElement) === true;
      if (!inPage) return;
      e.preventDefault();
      setHistoryOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible]);

  // Вставка SQL из чата агента (кнопка «→ SQL»).
  const lastSqlInsertRef = useRef(0);
  useEffect(() => {
    if (!sqlInsert || sqlInsert.id === lastSqlInsertRef.current) return;
    lastSqlInsertRef.current = sqlInsert.id;
    setSql(sqlInsert.sql);
    onSqlInsertConsumed?.();
  }, [sqlInsert, onSqlInsertConsumed]);

  const pushHistory = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      const next = [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, HISTORY_LIMIT);
      saveHistory(profile.id, next);
      return next;
    });
  }, [profile.id]);

  const runQuery = useCallback(async () => {
    if (!connection || !database) {
      showError(t('databases.errorNoSelection'));
      return;
    }
    if (!sql.trim() || running) return;
    // Поколение контекста: если подключение/база сменились, пока шёл запрос
    // (до 120 с), его результат относится к прошлому экрану — не кладём.
    const seq = ++runSeqRef.current;
    setRunning(true);
    setQueryError(null);
    try {
      const res = await runDbQuery(profile.id, {
        connectionId: connection.id,
        database,
        sql,
        readOnly,
      });
      if (runSeqRef.current !== seq) return;
      setResult(res);
      pushHistory(sql);
    } catch (err) {
      if (runSeqRef.current !== seq) return;
      setResult(null);
      const info = (err as { info?: DbQueryErrorInfo }).info;
      if (info) setQueryError(info);
      else showError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [connection, database, sql, running, readOnly, profile.id, showError, pushHistory, t]);

  const handleDump = async (dbName: string) => {
    if (!connection || dumping) return;
    setDumping(dbName);
    try {
      await downloadDbDump(profile.id, connection.id, dbName);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setDumping(null);
    }
  };

  // EXPLAIN — по синтаксису движка: PG (ANALYZE, BUFFERS), MySQL/MariaDB —
  // обычный EXPLAIN (EXPLAIN ANALYZE есть только в MySQL 8.0.18+).
  const insertExplain = () => {
    if (!connection) return;
    setSql((prev) => {
      const body = prev.trim();
      if (!body || /^EXPLAIN/i.test(body)) return prev;
      const prefix = connection.engine === 'postgres'
        ? 'EXPLAIN (ANALYZE, BUFFERS)\n'
        : 'EXPLAIN\n';
      return `${prefix}${body}\n`;
    });
  };

  const prefillTable = (tbl: DbTableInfo) => {
    const quote = (s: string) => (connection?.engine === 'postgres' ? `"${s}"` : `\`${s}\``);
    setSql(`SELECT *\nFROM ${quote(tbl.schema)}.${quote(tbl.name)}\nLIMIT 100;`);
  };

  // Раскрытие таблицы: показать/скрыть поля и индексы (деталь кэшируется).
  const toggleTableDetail = async (tbl: DbTableInfo) => {
    const key = tableDetailKey(tbl);
    if (expandedTable === key) {
      setExpandedTable(null);
      return;
    }
    setExpandedTable(key);
    if (!tableDetails[key] && connection && database) {
      setTableDetailLoading((prev) => ({ ...prev, [key]: true }));
      try {
        const detail = await fetchDbTableDetail(profile.id, connection.id, database, tbl.schema, tbl.name);
        setTableDetails((prev) => ({ ...prev, [key]: detail }));
      } catch (err) {
        showError((err as Error).message);
      } finally {
        setTableDetailLoading((prev) => ({ ...prev, [key]: false }));
      }
    }
  };

  // «Спросить агента»: промпт собираем здесь (движок, версия, черновик,
  // схема с колонками ≤4 КБ), AgentPage отправляет его как есть (mode
  // 'send'). Выполняет сгенерированный запрос всегда пользователь.
  const askAgent = () => {
    if (!connection) {
      showError(t('databases.errorNoConnection'));
      return;
    }
    const task = sql.trim();
    if (!task) {
      showError(t('databases.errorNoTask'));
      return;
    }
    const engineLabel = ENGINE_LABEL[connection.engine] ?? connection.engine;
    const version = overview ? shortVersion(overview.engine, overview.version) : '';
    // Схема — «таблица (колонки)» по строке на таблицу; без колонок (ещё
    // грузятся или не нужны серверу) — хотя бы имена таблиц. Обрезку по
    // серверному лимиту честно помечаем в самом тексте.
    let schema = buildSchemaText(tables, columns).slice(0, SCHEMA_CONTEXT_LIMIT);
    if (columnsTruncated) {
      schema += '\n' + t('databases.askSchemaTruncated');
    }
    const versionSuffix = version ? t('databases.askSqlVersion', { version }) : '';
    const schemaBlock = schema ? t('databases.askSqlSchema', { db: database ?? '', schema }) : '';
    const message = t('databases.askSqlPrompt', {
      engine: engineLabel,
      version: versionSuffix,
      task,
      schemaBlock,
    });
    onAskAgent(message, 'send', 'db');
  };

  const openCreateModal = () => {
    setEditingConnection(null);
    setModalOpen(true);
  };

  const openEditModal = (conn: DbConnectionInfo) => {
    setEditingConnection(conn);
    setModalOpen(true);
  };

  const handleSaved = (conn: DbConnectionInfo) => {
    setModalOpen(false);
    setConnectionId(conn.id);
    setReloadKey((k) => k + 1);
  };

  const handleDeleted = () => {
    setModalOpen(false);
    setReloadKey((k) => k + 1);
  };

  return (
    <div
      className="page db-page"
      ref={dbRootRef}
      onMouseEnter={() => {
        dbHoverRef.current = true;
      }}
      onMouseLeave={() => {
        dbHoverRef.current = false;
      }}
    >
      <div className="toolbar">
        <span className={`status-dot ${connectionsError ? 'error' : connections ? 'connected' : ''}`} />
        <span className="status-text">
          {connectionsError
            ? t('databases.errorPrefix', { error: connectionsError })
            : connections
              ? t('databases.connectionsCount', connections.length)
              : t('common.loading')}
        </span>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {connectionsError && !connections ? (
        <div className="empty-state">
          <p>{t('databases.loadFailed')}</p>
          <p className="error-text">{connectionsError}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      ) : !connections ? (
        <div className="empty-state">
          <p>{t('databases.loadingConnections')}</p>
        </div>
      ) : connections.length === 0 ? (
        <div className="empty-state">
          <p>{t('databases.empty')}</p>
          <p className="muted">
            {t('databases.emptyHint')}
          </p>
          <button className="btn btn-primary" onClick={openCreateModal}>
            {t('databases.addConnection')}
          </button>
        </div>
      ) : (
        <div className="db-layout">
          <aside className="db-sidebar">
            <div className="db-section-header">
              <h3 className="section-title">{t('databases.connectionsTitle')}</h3>
              <button
                type="button"
                className="btn btn-ghost btn-mini"
                onClick={openCreateModal}
                title={t('databases.newTitle')}
              >
                {t('databases.addButton')}
              </button>
            </div>
            {connections.map((c) => (
              <div
                key={c.id}
                className={`db-item-row${c.id === connectionId ? ' selected' : ''}`}
              >
                <button
                  type="button"
                  className="db-item"
                  onClick={() => setConnectionId(c.id)}
                  title={`${ENGINE_LABEL[c.engine] ?? c.engine} · ${c.username}`}
                >
                  <span className={`db-engine-badge ${c.engine}`}>
                    {c.engine === 'postgres' ? 'PG' : 'MY'}
                  </span>
                  <span className="db-item-body">
                    <strong>{c.name}</strong>
                    <span className="muted">{ENGINE_LABEL[c.engine] ?? c.engine} · {c.username}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-mini"
                  onClick={() => openEditModal(c)}
                  title={t('databases.editConnectionTitle')}
                >
                  ✎
                </button>
              </div>
            ))}

            {connection && (
              <>
                <h3 className="section-title">
                  {t('databases.databasesTitle')}
                  {overview && (
                    <span className="muted db-version">
                      {' · '}
                      {shortVersion(overview.engine, overview.version)}
                    </span>
                  )}
                </h3>
                {overviewError && <p className="error-text">{overviewError}</p>}
                {!overview && !overviewError && <p className="muted">{t('common.loading')}</p>}
                {overview && overview.databases.length === 0 && (
                  <p className="muted db-sidebar-empty">{t('databases.noDatabases')}</p>
                )}
                {overview?.databases.map((db) => (
                  <div
                    key={db.name}
                    className={`db-item-row${db.name === database ? ' selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="db-item db-item-db"
                      onClick={() => setDatabase(db.name)}
                    >
                      <span className="db-item-body">
                        <strong>{db.name}</strong>
                        <span className="muted">
                          {db.sizeBytes !== null ? formatSize(db.sizeBytes) : ''}
                          {db.tableCount !== null ? t('databases.tablesSuffix', db.tableCount) : ''}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-mini"
                      onClick={() => handleDump(db.name)}
                      disabled={dumping !== null}
                      title={t('databases.dumpTitle')}
                    >
                      {dumping === db.name ? '…' : '⤓'}
                    </button>
                  </div>
                ))}

                <h3 className="section-title">
                  {t('databases.tablesTitle')}{database ? t('databases.tablesFor', { name: database }) : ''}
                </h3>
                {tablesError && <p className="error-text" title={tablesError}>{t('databases.tablesLoadFailed', { error: tablesError })}</p>}
                {tables === null && database && !tablesError && <p className="muted">{t('common.loading')}</p>}
                {tables !== null && tables.length === 0 && !tablesError && (
                  <p className="muted db-sidebar-empty">{t('databases.noTables')}</p>
                )}
                <div className="db-tables">
                  {tables?.map((tbl) => {
                    const key = tableDetailKey(tbl);
                    const open = expandedTable === key;
                    const detail = tableDetails[key];
                    const loading = tableDetailLoading[key];
                    return (
                      <div key={key} className={`db-table-row${open ? ' open' : ''}`}>
                        <div className="db-table-line">
                          <button
                            type="button"
                            className="db-table-chev"
                            onClick={() => void toggleTableDetail(tbl)}
                            title={t('databases.tableDetailTitle')}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 6l6 6-6 6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="db-table-item"
                            onClick={() => prefillTable(tbl)}
                            title={t('databases.prefillTitle')}
                          >
                            {tbl.name}
                          </button>
                        </div>
                        {open && (
                          <div className="db-table-detail">
                            {loading && !detail && <p className="muted db-detail-loading">{t('common.loading')}</p>}
                            {detail && (
                              <>
                                {detail.columns.length > 0 && (
                                  <>
                                    <p className="db-detail-label">{t('databases.detailColumns')}</p>
                                    <div className="db-detail-cols">
                                      {detail.columns.map((c) => (
                                        <div key={c.name} className="db-detail-col">
                                          <span className="cname">{c.name}</span>
                                          <span className="ctype">{c.type}</span>
                                          {c.key && <span className={`ckey ${c.key}`}>{c.key === 'pk' ? 'PK' : c.key === 'fk' ? 'FK' : 'UQ'}</span>}
                                        </div>
                                      ))}
                                    </div>
                                  </>
                                )}
                                {detail.indexes.length > 0 && (
                                  <>
                                    <p className="db-detail-label">{t('databases.detailIndexes')}</p>
                                    <div className="db-detail-idx">
                                      {detail.indexes.map((ix) => (
                                        <div key={ix.name} className="db-detail-idx-row">
                                          <span className="iname">{ix.name}</span>
                                          <span className="icols">({ix.columns.join(', ')})</span>
                                          {ix.primary && <span className="ckey pk">PK</span>}
                                          {!ix.primary && ix.unique && <span className="ckey uq">UQ</span>}
                                        </div>
                                      ))}
                                    </div>
                                  </>
                                )}
                                {detail.columns.length === 0 && detail.indexes.length === 0 && (
                                  <p className="muted db-detail-empty">{t('databases.noData')}</p>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </aside>

          <section className="db-main">
            <div className="db-editor-toolbar">
              <label className="db-readonly-toggle" title={t('databases.readOnlyTitle')}>
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                />
                {t('databases.readOnlyLabel')}
              </label>
              <button
                className="btn btn-primary"
                onClick={runQuery}
                disabled={running || !connection || !database}
              >
                {running ? t('databases.running') : t('databases.run')}
              </button>
              <button
                className="btn btn-ghost"
                onClick={insertExplain}
                title={
                  connection?.engine === 'postgres'
                    ? t('databases.explainTitlePostgres')
                    : t('databases.explainTitle')
                }
              >
                EXPLAIN
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setHistoryOpen(true)}
                title={t('databases.historyTitle')}
              >
                {t('databases.historyButton')}
              </button>
              <button className="btn btn-ghost" onClick={askAgent} title={t('databases.askAgentTitle')}>
                {t('databases.askAgent')}
              </button>
              <span className="muted db-shortcut">{t('databases.shortcutRun')}</span>
            </div>

            <div className="db-editor">
              <Suspense fallback={<p className="muted">{t('databases.editorLoading')}</p>}>
                <CodeEditor
                  value={sql}
                  fileName="query.sql"
                  onChange={setSql}
                  onRun={runQuery}
                />
              </Suspense>
            </div>

            {queryError && (
              <div className="db-query-error">
                <p className="error-text">{queryError.message}</p>
                {queryError.stderr && <pre className="mono">{queryError.stderr}</pre>}
                <p className="muted">exit code: {queryError.exitCode ?? '—'}</p>
              </div>
            )}

            {result && (
              <div className="db-result">
                <div className="db-result-meta">
                  {result.columns.length > 0 ? (
                    <span>
                      {t('databases.rowsCount', result.rowCount)}
                      {result.totalRows > result.rowCount
                        ? t('databases.rowsShownFirst', { shown: result.rowCount, total: result.totalRows })
                        : ''}
                    </span>
                  ) : (
                    <span className="muted">{t('databases.noResultSet')}</span>
                  )}
                  <span className="muted">{t('databases.ms', { n: result.durationMs })}</span>
                  {result.truncated && (
                    <span className="error-text">{t('databases.truncatedOutput')}</span>
                  )}
                </div>
                {result.columns.length > 0 && (
                  <div className="db-grid-wrap">
                    <table className="data-table db-grid">
                      <thead>
                        <tr>
                          {result.columns.map((c, i) => (
                            <th key={`${i}:${c}`}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((cell, ci) => (
                              <td key={ci} title={cell}>
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {result.rows.length === 0 && (
                          <tr>
                            <td colSpan={result.columns.length} className="muted">
                              {t('databases.zeroRows')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                {result.rawOutput && (
                  <details className="db-raw-output">
                    <summary>{t('databases.rawOutput')}</summary>
                    <pre className="mono">{result.rawOutput}</pre>
                  </details>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {historyOpen && (
        <QueryHistoryPalette
          history={history}
          onPick={(q) => {
            setSql(q);
            setHistoryOpen(false);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {modalOpen && (
        <ConnectionModal
          profileId={profile.id}
          editing={editingConnection}
          onClose={() => setModalOpen(false)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          showError={showError}
        />
      )}
    </div>
  );
}
