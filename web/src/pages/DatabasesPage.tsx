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
        placeholder="Фильтр запросов… (↑↓ — выбор, Enter — вставить, Esc — закрыть)"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="history-list" ref={listRef}>
        {filtered.length === 0 && (
          <div className="history-empty">
            {history.length === 0 ? 'История запросов пуста' : 'Ничего не найдено'}
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
      showError('Заполните имя, контейнер и пользователя');
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
      showError('Заполните контейнер и пользователя');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const input = buildInput();
      await testDbConnection(editing ? { ...input, id: editing.id } : input);
      setTestResult({ phase: 'ok', message: 'Подключение работает' });
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
    if (!window.confirm(`Удалить подключение «${editing.name}»?`)) return;
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
          <h2>{editing ? 'Подключение к БД' : 'Новое подключение к БД'}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label className="span-2">
              Контейнер
              <select value={containerId} onChange={(e) => pickContainer(e.target.value)}>
                <option value="">— выберите контейнер —</option>
                {suggestions?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.image})
                  </option>
                ))}
                {editingContainerMissing && editingContainerId && (
                  <option value={editingContainerId}>
                    {editingContainerId} (сохранённый)
                  </option>
                )}
              </select>
              <span className="field-hint">
                {discoveryError
                  ? `Список контейнеров не получен: ${discoveryError}`
                  : suggestions === null
                    ? 'Загрузка контейнеров…'
                    : suggestions.length === 0
                      ? 'Контейнеры PostgreSQL / MySQL / MariaDB не найдены.'
                      : 'Выбор автозаполняет движок, пользователя и базу по умолчанию.'}
              </span>
            </label>
            <label>
              Движок
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as DbEngine)}
              >
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL / MariaDB</option>
              </select>
            </label>
            <label>
              Имя подключения
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="prod-postgres"
              />
            </label>
            <label>
              Пользователь БД
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="postgres / root"
              />
            </label>
            <label>
              Пароль
              <div className="inline-field">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editing ? 'сохранён — пусто = не менять' : 'для PG в контейнере часто не нужен'}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? 'Скрыть' : 'Показать'}
                </button>
              </div>
              <span className="field-hint">
                Передаётся первой строкой stdin — не светится в ps сервера. Перевод
                строки в пароле не поддерживается.
              </span>
            </label>
            <label>
              База по умолчанию (необязательно)
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
                <p key={h.id} className="muted" title={`Контейнер ${h.name}, порт ${h.port}`}>
                  «{h.name}» слушает :{h.port} — похоже на СУБД, но образ не распознан
                  (поддерживаются postgres / mysql / mariadb)
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy || testing}>
            {busy ? 'Сохранение…' : 'Сохранить'}
          </button>
          <button className="btn" onClick={runTest} disabled={busy || testing}>
            {testing ? 'Проверка…' : 'Проверить подключение'}
          </button>
          {editing && (
            <button className="btn btn-danger" onClick={remove} disabled={busy || testing}>
              Удалить
            </button>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
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
      showError('Выберите подключение и базу');
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
  }, [connection, database, sql, running, readOnly, profile.id, showError, pushHistory]);

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

  const prefillTable = (t: DbTableInfo) => {
    const quote = (s: string) => (connection?.engine === 'postgres' ? `"${s}"` : `\`${s}\``);
    setSql(`SELECT *\nFROM ${quote(t.schema)}.${quote(t.name)}\nLIMIT 100;`);
  };

  // Раскрытие таблицы: показать/скрыть поля и индексы (деталь кэшируется).
  const toggleTableDetail = async (t: DbTableInfo) => {
    const key = tableDetailKey(t);
    if (expandedTable === key) {
      setExpandedTable(null);
      return;
    }
    setExpandedTable(key);
    if (!tableDetails[key] && connection && database) {
      setTableDetailLoading((prev) => ({ ...prev, [key]: true }));
      try {
        const detail = await fetchDbTableDetail(profile.id, connection.id, database, t.schema, t.name);
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
      showError('Выберите подключение');
      return;
    }
    const task = sql.trim();
    if (!task) {
      showError('Опишите задачу или набросайте запрос в редакторе');
      return;
    }
    const engineLabel = ENGINE_LABEL[connection.engine] ?? connection.engine;
    const version = overview ? shortVersion(overview.engine, overview.version) : '';
    // Схема — «таблица (колонки)» по строке на таблицу; без колонок (ещё
    // грузятся или не нужны серверу) — хотя бы имена таблиц. Обрезку по
    // серверному лимиту честно помечаем в самом тексте.
    let schema = buildSchemaText(tables, columns).slice(0, SCHEMA_CONTEXT_LIMIT);
    if (columnsTruncated) {
      schema += '\n… (показаны не все колонки — обрезано по лимиту)';
    }
    const message =
      `Напиши SQL-запрос для ${engineLabel}${version ? ` (версия ${version})` : ''}.\n\n` +
      `Задача / черновик запроса:\n${task}\n` +
      (schema
        ? `\nСхема базы «${database ?? ''}»:\n${schema}\n`
        : '') +
      `\nОтвет дай одним блоком \`\`\`sql — я вставлю его в редактор.`;
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
            ? `Ошибка: ${connectionsError}`
            : connections
              ? `${connections.length} подключение(ий)`
              : 'Загрузка…'}
        </span>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      {connectionsError && !connections ? (
        <div className="empty-state">
          <p>Список подключений получить не удалось:</p>
          <p className="error-text">{connectionsError}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      ) : !connections ? (
        <div className="empty-state">
          <p>Загрузка подключений…</p>
        </div>
      ) : connections.length === 0 ? (
        <div className="empty-state">
          <p>Сохранённых подключений к БД нет.</p>
          <p className="muted">
            Подключение — как в DBeaver: контейнер PostgreSQL/MySQL/MariaDB,
            пользователь и пароль. Пароль вводится один раз.
          </p>
          <button className="btn btn-primary" onClick={openCreateModal}>
            Добавить подключение
          </button>
        </div>
      ) : (
        <div className="db-layout">
          <aside className="db-sidebar">
            <div className="db-section-header">
              <h3 className="section-title">Подключения</h3>
              <button
                type="button"
                className="btn btn-ghost btn-mini"
                onClick={openCreateModal}
                title="Новое подключение к БД"
              >
                + Добавить
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
                  title="Изменить подключение"
                >
                  ✎
                </button>
              </div>
            ))}

            {connection && (
              <>
                <h3 className="section-title">
                  Базы
                  {overview && (
                    <span className="muted db-version">
                      {' · '}
                      {shortVersion(overview.engine, overview.version)}
                    </span>
                  )}
                </h3>
                {overviewError && <p className="error-text">{overviewError}</p>}
                {!overview && !overviewError && <p className="muted">Загрузка…</p>}
                {overview && overview.databases.length === 0 && (
                  <p className="muted db-sidebar-empty">Баз нет</p>
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
                          {db.tableCount !== null ? ` · ${db.tableCount} табл.` : ''}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-mini"
                      onClick={() => handleDump(db.name)}
                      disabled={dumping !== null}
                      title="Скачать дамп (pg_dump/mysqldump | gzip)"
                    >
                      {dumping === db.name ? '…' : '⤓'}
                    </button>
                  </div>
                ))}

                <h3 className="section-title">
                  Таблицы{database ? ` — ${database}` : ''}
                </h3>
                {tablesError && <p className="error-text" title={tablesError}>Не загрузились: {tablesError}</p>}
                {tables === null && database && !tablesError && <p className="muted">Загрузка…</p>}
                {tables !== null && tables.length === 0 && !tablesError && (
                  <p className="muted db-sidebar-empty">Таблиц нет</p>
                )}
                <div className="db-tables">
                  {tables?.map((t) => {
                    const key = tableDetailKey(t);
                    const open = expandedTable === key;
                    const detail = tableDetails[key];
                    const loading = tableDetailLoading[key];
                    return (
                      <div key={key} className={`db-table-row${open ? ' open' : ''}`}>
                        <div className="db-table-line">
                          <button
                            type="button"
                            className="db-table-chev"
                            onClick={() => void toggleTableDetail(t)}
                            title="Поля и индексы таблицы"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 6l6 6-6 6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="db-table-item"
                            onClick={() => prefillTable(t)}
                            title="Вставить SELECT * … LIMIT 100 в редактор"
                          >
                            {t.name}
                          </button>
                        </div>
                        {open && (
                          <div className="db-table-detail">
                            {loading && !detail && <p className="muted db-detail-loading">Загрузка…</p>}
                            {detail && (
                              <>
                                {detail.columns.length > 0 && (
                                  <>
                                    <p className="db-detail-label">Поля</p>
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
                                    <p className="db-detail-label">Индексы</p>
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
                                  <p className="muted db-detail-empty">Нет данных</p>
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
              <label className="db-readonly-toggle" title="Серверный SET перед запросом. Защита от случайности, не от намеренного: пользовательский SET может снять режим.">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                />
                только чтение
              </label>
              <button
                className="btn btn-primary"
                onClick={runQuery}
                disabled={running || !connection || !database}
              >
                {running ? 'Выполняется…' : 'Выполнить'}
              </button>
              <button
                className="btn btn-ghost"
                onClick={insertExplain}
                title={
                  connection?.engine === 'postgres'
                    ? 'Обернуть запрос в EXPLAIN (ANALYZE, BUFFERS)'
                    : 'Обернуть запрос в EXPLAIN'
                }
              >
                EXPLAIN
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setHistoryOpen(true)}
                title="История запросов (Ctrl+R)"
              >
                История
              </button>
              <button className="btn btn-ghost" onClick={askAgent} title="Агент напишет SQL по задаче и схеме; схема уходит в API модели — действие осознанное">
                Спросить агента
              </button>
              <span className="muted db-shortcut">Ctrl+Enter — выполнить</span>
            </div>

            <div className="db-editor">
              <Suspense fallback={<p className="muted">Загрузка редактора…</p>}>
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
                      {result.rowCount} строк(и)
                      {result.totalRows > result.rowCount
                        ? ` — показаны первые ${result.rowCount} из ${result.totalRows}`
                        : ''}
                    </span>
                  ) : (
                    <span className="muted">Result set отсутствует (см. полный вывод)</span>
                  )}
                  <span className="muted">{result.durationMs} мс</span>
                  {result.truncated && (
                    <span className="error-text">вывод обрезан по лимиту 2 МБ</span>
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
                              0 строк
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                {result.rawOutput && (
                  <details className="db-raw-output">
                    <summary>Полный вывод</summary>
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
