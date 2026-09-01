import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createSnippet,
  deleteSnippet,
  fetchSnippets,
  runSnippet,
  updateSnippet,
  type OverviewServerEntry,
  type Snippet,
  type SnippetRunResponse,
} from '../api';
import type { AgentAskMode, Profile } from '../types';
import { Modal } from './Modal';
import { useT } from '../i18n';

interface Props {
  showError: (msg: string) => void;
  onAskAgent: (text: string, mode?: AgentAskMode) => void;
  /** Цели запуска — из списка профилей App (overview бывает пуст/устаревшим). */
  profiles: Profile[];
  /** Свежий снимок /api/overview — статус-точки у целей (необязательное украшение). */
  servers: OverviewServerEntry[] | null;
}

// Контекст для «В чат»: хвост объединённого вывода до 4 КБ.
const ASK_TAIL_CHARS = 4096;

/** Форма редактора сниппета: null в profileIds = «на всех серверах». */
interface SnippetForm {
  name: string;
  command: string;
  description: string;
  allServers: boolean;
  profileIds: Set<string>;
}

function emptyForm(): SnippetForm {
  return { name: '', command: '', description: '', allServers: true, profileIds: new Set() };
}

function snippetToForm(s: Snippet): SnippetForm {
  return {
    name: s.name,
    command: s.command,
    description: s.description ?? '',
    allServers: !s.profileIds,
    profileIds: new Set(s.profileIds ?? []),
  };
}

function buildAskText(command: string, serverName: string, stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.trim() || '(пустой вывод)';
  const tail = output.length > ASK_TAIL_CHARS ? `…${output.slice(-ASK_TAIL_CHARS)}` : output;
  return `Объясни вывод команды "${command}" на сервере ${serverName}:\n\`\`\`\n${tail}\n\`\`\``;
}

/**
 * Раздел «Команды» на странице «Серверы» (эпик 18): список сохранённых
 * команд + параллельный запуск на выбранных серверах с подтверждением и
 * разбором результатов. Команда исполняется как есть (уровень терминала) —
 * защита не фильтрацией, а модалкой с явным перечислением целей.
 */
export function SnippetsSection({ showError, onAskAgent, profiles, servers }: Props) {
  const { t } = useT();
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<{ snippet: Snippet | null; form: SnippetForm } | null>(null);
  const [saving, setSaving] = useState(false);

  // Цели запуска: общий выбор для сниппетов и разовой команды.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adhoc, setAdhoc] = useState('');
  // scope — область сниппета (null = все серверы): запуски сниппета с областью
  // предвыбирают именно его цели, модалке остаётся показать выходы за область.
  const [confirming, setConfirming] = useState<{ command: string; scope: string[] | null } | null>(null);
  const [running, setRunning] = useState(false);
  // Замороженные цели и отмена: чекбоксы во время запуска меняют selected,
  // а выполняется то, что ушло с запросом (AbortController — UI освобождается
  // сразу, на сервере команда дорабатывает своё).
  const [runTargets, setRunTargets] = useState<string[]>([]);
  const runAbortRef = useRef<AbortController | null>(null);
  const [results, setResults] = useState<SnippetRunResponse | null>(null);
  const [openResults, setOpenResults] = useState<Set<string>>(new Set());

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const statusById = useMemo(
    () => new Map((servers ?? []).map((s) => [s.id, { ok: s.ok, error: s.error }])),
    [servers],
  );

  useEffect(() => {
    let cancelled = false;
    fetchSnippets()
      .then((list) => {
        if (!cancelled) setSnippets(list);
      })
      .catch((err) => {
        if (!cancelled) showError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, showError]);

  // Профиль удалили — убираем его из выбора и целей сниппетов не теряем:
  // запуск валидирует цели на сервере, здесь чистим только чекбоксы.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => profileById.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [profileById]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openEditor = (snippet: Snippet | null) => {
    setEditing({ snippet, form: snippet ? snippetToForm(snippet) : emptyForm() });
  };

  const saveEditor = async () => {
    if (!editing) return;
    const { snippet, form } = editing;
    const input = {
      name: form.name.trim(),
      command: form.command,
      description: form.description.trim() || undefined,
      profileIds: form.allServers ? null : [...form.profileIds],
    };
    setSaving(true);
    try {
      if (snippet) await updateSnippet(snippet.id, input);
      else await createSnippet(input);
      setEditing(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeSnippet = async (snippet: Snippet) => {
    if (!window.confirm(t('snippets.deleteConfirm', { name: snippet.name }))) return;
    try {
      await deleteSnippet(snippet.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const startRun = (command: string, snippet?: Snippet) => {
    // Сниппет с областью предвыбирает свои цели — настройка «только на этих
    // серверах» должна значить что-то, а не молча наследовать прошлый выбор.
    const scope = snippet?.profileIds ?? null;
    let effective = selected;
    if (scope) {
      effective = new Set(scope.filter((id) => profileById.has(id)));
      setSelected(effective);
    }
    if (effective.size === 0) {
      showError(t('snippets.errorNoTargets'));
      return;
    }
    setConfirming({ command, scope });
  };

  const cancelRun = () => {
    runAbortRef.current?.abort();
  };

  const confirmRun = async () => {
    if (!confirming) return;
    const targets = [...selected];
    setConfirming(null);
    setRunning(true);
    setResults(null);
    setRunTargets(targets);
    const controller = new AbortController();
    runAbortRef.current = controller;
    try {
      // Уходит именно command — та строка, что показана в модалке; серверный
      // путь со snippetId перечитал бы стор и мог выполнить уже отредактированную команду.
      const res = await runSnippet({ command: confirming.command, profileIds: targets }, controller.signal);
      setResults(res);
      // Разворачиваем первый проблемный результат, остальные свёрнуты.
      const firstBad = res.results.find((r) => !r.ok);
      setOpenResults(new Set(firstBad ? [firstBad.profileId] : []));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        showError((err as Error).message);
      } else {
        showError(t('snippets.runAborted'));
      }
    } finally {
      runAbortRef.current = null;
      setRunning(false);
    }
  };

  const toggleResult = (profileId: string) => {
    setOpenResults((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });
  };

  const askAgent = (profileId: string) => {
    if (!results) return;
    const r = results.results.find((x) => x.profileId === profileId);
    if (!r) return;
    const name = profileById.get(profileId)?.name ?? profileId;
    const codePart = r.code === null ? `ошибка выполнения: ${r.error ?? 'неизвестно'}` : `exit code ${r.code}`;
    onAskAgent(
      `${buildAskText(results.command, name, r.stdout, r.stderr)}\n(${codePart})${r.truncated ? '\n(вывод обрезан)' : ''}`,
      'send',
    );
  };

  if (profiles.length === 0) return null;

  return (
    <section className="snippets-section">
      <div className="snippets-head">
        <h3>{t('snippets.title')}</h3>
        <button className="btn btn-ghost btn-mini" onClick={() => openEditor(null)}>
          {t('snippets.new')}
        </button>
      </div>

      {snippets === null ? (
        <div className="muted">{t('common.loading')}</div>
      ) : snippets.length === 0 ? (
        <div className="muted">
          {t('snippets.empty')}
        </div>
      ) : (
        <div className="snippets-list">
          {snippets.map((s) => (
            <div key={s.id} className="snippet-item">
              <div className="snippet-info">
                <div className="snippet-name-row">
                  <span className="snippet-name">{s.name}</span>
                  <span className="snippet-scope muted">
                    {s.profileIds
                      ? t('snippets.scopeServers', s.profileIds.length)
                      : t('snippets.scopeAll')}
                  </span>
                </div>
                <code className="snippet-cmd" title={s.command}>{s.command}</code>
                {s.description && <div className="snippet-desc muted">{s.description}</div>}
              </div>
              <div className="snippet-actions">
                <button
                  className="btn btn-mini"
                  disabled={running}
                  onClick={() => startRun(s.command, s)}
                >
                  {t('snippets.run')}
                </button>
                <button className="btn btn-ghost btn-mini" onClick={() => openEditor(s)} title={t('snippets.edit')}>
                  ✎
                </button>
                <button
                  className="btn btn-ghost btn-mini"
                  onClick={() => void removeSnippet(s)}
                  title={t('common.delete')}
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="snippets-adhoc">
        <textarea
          className="snippets-adhoc-input"
          placeholder={t('snippets.adhocPlaceholder')}
          value={adhoc}
          rows={2}
          spellCheck={false}
          onChange={(e) => setAdhoc(e.target.value)}
        />
        <button
          className="btn btn-mini"
          disabled={running || !adhoc.trim()}
          onClick={() => startRun(adhoc.trim())}
        >
          {t('snippets.runAdhoc')}
        </button>
      </div>

      <div className="snippets-targets">
        <div className="snippets-targets-head">
          <span className="sidebar-label">{t('snippets.targetsLabel')}</span>
          {profiles.length > 1 && (
            <button
              className="btn btn-ghost btn-mini"
              onClick={() =>
                setSelected((prev) =>
                  prev.size === profiles.length ? new Set() : new Set(profiles.map((p) => p.id)),
                )
              }
            >
              {selected.size === profiles.length ? t('snippets.deselectAll') : t('snippets.selectAll')}
            </button>
          )}
        </div>
        <div className="snippets-target-list">
          {profiles.map((p) => {
            const st = statusById.get(p.id);
            return (
              <label key={p.id} className={`snippets-target${running ? ' disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  disabled={running}
                  onChange={() => toggleSelected(p.id)}
                />
                <span
                  className={`status-dot${st ? (st.ok ? ' connected' : ' error') : ''}`}
                  title={st ? (st.ok ? t('snippets.targetAvailable') : t('snippets.targetUnavailable', { error: st.error ?? t('servers.noData') })) : ''}
                />
                <span className="snippet-target-name">{p.name}</span>
                <span className="muted">
                  {p.username}@{p.host}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {running && (
        <div className="snippets-running">
          <span className="muted">{t('snippets.runningOn', runTargets.length)}</span>
          <button className="btn btn-ghost btn-mini" onClick={cancelRun}>
            {t('snippets.cancelRun')}
          </button>
        </div>
      )}

      {results && (
        <div className="snippets-results">
          <div className="snippets-results-head">
            <span className="sidebar-label">{t('snippets.resultsTitle')}</span>
            <span className="muted">
              {t('snippets.resultsOk', { ok: results.results.filter((r) => r.ok).length, total: results.results.length })}
            </span>
          </div>
          <div className="snippets-result-list">
            {results.results.map((r) => {
              const p = profileById.get(r.profileId);
              const open = openResults.has(r.profileId);
              return (
                <div key={r.profileId} className={`snippet-result${r.ok ? '' : ' failed'}`}>
                  <button type="button" className="snippet-result-head" onClick={() => toggleResult(r.profileId)}>
                    <span className={`snippet-badge ${r.ok ? 'ok' : 'fail'}`}>
                      {r.code === null ? t('snippets.badgeError') : r.code}
                    </span>
                    <span className="snippet-target-name">{p?.name ?? r.profileId}</span>
                    <span className="muted">{t('snippets.ms', { n: r.ms })}</span>
                    {r.truncated && <span className="muted">{t('snippets.truncated')}</span>}
                    <span className="snippet-result-caret">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <div className="snippet-result-body">
                      {r.error ? (
                        <pre className="snippets-output">{r.error}</pre>
                      ) : (
                        <>
                          {r.stdout && <pre className="snippets-output">{r.stdout}</pre>}
                          {r.stderr && <pre className="snippets-output stderr">{r.stderr}</pre>}
                          {!r.stdout && !r.stderr && <div className="muted">{t('snippets.emptyOutput')}</div>}
                        </>
                      )}
                      <button className="btn btn-ghost btn-mini" onClick={() => askAgent(r.profileId)}>
                        {t('snippets.toChat')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {editing && (
        <SnippetEditorModal
          editing={editing}
          profiles={profiles}
          saving={saving}
          onChange={(form) => setEditing((prev) => (prev ? { ...prev, form } : prev))}
          onClose={() => setEditing(null)}
          onSave={() => void saveEditor()}
        />
      )}

      {confirming && (
        <Modal title={t('snippets.confirmTitle')} onClose={() => setConfirming(null)}>
          <div className="snippets-confirm">
            <p>
              {t('snippets.confirmPre')}<strong>{t('snippets.confirmStrong')}</strong>{t('snippets.confirmPost')}{' '}
              {t('snippets.confirmRunOn', selected.size)}
            </p>
            {confirming.scope && (
              <p className="field-hint">
                {t('snippets.scopeReset', {
                  names: confirming.scope.map((id) => profileById.get(id)?.name ?? id).join(', ') || t('snippets.noExistingServers'),
                })}
              </p>
            )}
            <ul className="snippets-confirm-targets">
              {[...selected].map((id) => {
                const p = profileById.get(id);
                return (
                  <li key={id}>
                    {p ? `${p.name} — ${p.username}@${p.host}` : id}
                  </li>
                );
              })}
            </ul>
            <pre className="snippets-output">{confirming.command}</pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirming(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={() => void confirmRun()}>
                {t('snippets.run')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function SnippetEditorModal({
  editing,
  profiles,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  editing: { snippet: Snippet | null; form: SnippetForm };
  profiles: Profile[];
  saving: boolean;
  onChange: (form: SnippetForm) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useT();
  const { snippet, form } = editing;
  const valid = form.name.trim() !== '' && form.command.trim() !== '';
  const set = (patch: Partial<SnippetForm>) => onChange({ ...form, ...patch });
  const toggleTarget = (id: string) => {
    const next = new Set(form.profileIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ profileIds: next });
  };

  return (
    <Modal title={snippet ? t('snippets.editorEditTitle') : t('snippets.editorNewTitle')} onClose={onClose}>
      <div className="form-grid snippets-form">
        <label>
          <span>{t('snippets.fieldName')}</span>
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={t('snippets.namePlaceholder')}
            autoFocus
          />
        </label>
        <label>
          <span>{t('snippets.fieldDescription')}</span>
          <input
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder={t('snippets.descriptionPlaceholder')}
          />
        </label>
        <label className="span-2">
          <span>{t('snippets.fieldCommand')}</span>
          <textarea
            value={form.command}
            onChange={(e) => set({ command: e.target.value })}
            rows={3}
            spellCheck={false}
            placeholder="cat /etc/os-release"
          />
        </label>
        <label className="snippets-check span-2">
          <input
            type="checkbox"
            checked={form.allServers}
            onChange={(e) => set({ allServers: e.target.checked })}
          />
          <span>{t('snippets.allServers')}</span>
        </label>
        {!form.allServers && (
          <div className="snippets-target-list span-2">
            {profiles.map((p) => (
              <label key={p.id} className="snippets-target">
                <input
                  type="checkbox"
                  checked={form.profileIds.has(p.id)}
                  onChange={() => toggleTarget(p.id)}
                />
                <span className="snippet-target-name">{p.name}</span>
                <span className="muted">
                  {p.username}@{p.host}
                </span>
              </label>
            ))}
            {form.profileIds.size === 0 && (
              <div className="field-hint">{t('snippets.noServersSelected')}</div>
            )}
          </div>
        )}
        <div className="modal-actions span-2">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid || saving || (!form.allServers && form.profileIds.size === 0)}
            onClick={onSave}
          >
            {saving ? t('snippets.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
