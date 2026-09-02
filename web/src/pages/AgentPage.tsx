import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatRelativeDate, formatUsd } from '../api';
import type {
  AgentAskMode,
  Dialogue,
  DialogueMessage,
  DialogueSummary,
  DialogueUsageTotals,
  Profile,
} from '../types';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  /** Одноразовый запрос «Спросить агента» (терминал/вкладка БД; расходуется эффектом ниже). */
  agentRequest?: { id: number; text: string; mode?: AgentAskMode; source?: string } | null;
  onAgentRequestConsumed?: () => void;
  /** Индикатор активности в сайдбаре: 'pending' (ждёт approve) важнее 'running'. */
  onActivity?: (profileId: string, state: 'running' | 'pending' | null) => void;
  /**
   * «→ SQL» на sql-блоках ответов (когда активный запрос пришёл со вкладки
   * «Базы данных»): вставить SQL в редактор консоли и переключить вкладку.
   */
  onSqlInsert?: (profileId: string, sql: string) => void;
}

interface AttachedServer {
  id: string;
  name: string;
  host: string;
  username: string;
}

interface ToolCallView {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'pending' | 'ok' | 'error' | 'rejected';
  output?: string;
  truncated?: boolean;
  /** Имя сервера из событий tool_start/tool_pending/tool_result (бейдж). */
  server?: string;
}

interface ChatMessageView {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  toolCalls?: ToolCallView[];
}

let nextId = 1;

// Иконки для кнопки копирования сообщения агента.
function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

// Шаблон запроса по выводу терминала (режимы 'explain' и 'new-dialogue').
function terminalContextMessage(
  t: (key: I18nKey, params?: I18nParams | number) => string,
  text: string,
  serverName: string,
): string {
  return t('agent.terminalExplainPrompt', { serverName, text });
}

export function AgentPage({ profile, showError, agentRequest, onAgentRequestConsumed, onActivity, onSqlInsert }: Props) {
  // lang (в отличие от t) — в deps WS-эффекта: смена языка интерфейса
  // пересоздаёт подключение, чтобы агент отвечал на языке UI.
  const { t, lang, locale } = useT();
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [dialogues, setDialogues] = useState<DialogueSummary[]>([]);
  const [activeDialogueId, setActiveDialogueId] = useState('');
  const [loading, setLoading] = useState(true);
  // Режим планирования: сообщения уходят с planMode=true, агент сначала
  // составляет план без инструментов и ждёт approve_plan.
  const [planMode, setPlanMode] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  // Модалка «Проверка безопасности»: необязательный sudo-пароль для root-секций аудита.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditPassword, setAuditPassword] = useState('');
  // Сервер, на котором запускать аудит ('' — домашний профиль диалога).
  const [auditServerId, setAuditServerId] = useState('');
  // Dropdown с историей диалогов (кнопка «История» в тулбаре).
  const [historyOpen, setHistoryOpen] = useState(false);
  // Серверы, подключённые к диалогу (событие WS `servers`): домашний первым.
  const [serversInfo, setServersInfo] = useState<{ home: string; attached: AttachedServer[] } | null>(null);
  // Dropdown кнопки «+» — профили, которые можно подключить к диалогу.
  const [addOpen, setAddOpen] = useState(false);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  // Решение по мутирующему вызову отправлено (кнопки плашки заблокированы
  // до tool_result); смена диалога сбрасывает.
  const [decidedCalls, setDecidedCalls] = useState<Set<string>>(() => new Set());
  // Живые итоги расходов диалога (WS-событие usage): обновляются после каждой
  // записи в журнал — бейдж двигается во время длинных прогонов, а не только
  // по done (refreshDialogues). Сбрасываются при смене диалога.
  const [liveUsage, setLiveUsage] = useState<DialogueUsageTotals | null>(null);
  // Подсказка вероятного ответа (WS-событие suggestion): плейсхолдер пустого
  // поля ввода, Tab подставляет текст. Живёт только в стейте страницы — до
  // следующего хода (сброс на running/send/error/смену диалога), из
  // persisted-диалога не восстанавливается. Автоотправки нет никогда.
  const [suggestion, setSuggestion] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  // Отложенная отправка первого сообщения в только что созданный диалог
  // ('new-dialogue' из терминала): заполняется после успешного POST, а
  // отправляется в ws.onopen, когда WS нового диалога готов.
  const pendingSendRef = useRef<{ content: string; dialogueId: string } | null>(null);
  // Поле ввода — для фокуса/курсора после prefill из терминала.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // DOM-карточки вызовов в ленте — клик по плашке подтверждения скроллит к карточке.
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  // Актуальные значения для эффекта «Спросить агента» — без добавления в deps,
  // чтобы смена состояния не расходовала запрос повторно.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const runningRef = useRef(running);
  runningRef.current = running;
  const activeDialogueIdRef = useRef(activeDialogueId);
  activeDialogueIdRef.current = activeDialogueId;
  // t для WS-эффекта без добавления в deps: переводы не должны
  // пересоздавать подключение (паттерн tRef из TerminalPage). Сам язык
  // (lang) в deps есть — его смена пересоздаёт WS намеренно.
  const tRef = useRef(t);
  tRef.current = t;

  const pushAssistantToken = useCallback((token: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + token }];
      }
      return [...prev, { id: nextId++, role: 'assistant', content: token, streaming: true }];
    });
  }, []);

  const finalizeAssistant = useCallback((content: string, toolCalls?: ToolCallView[]) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content, streaming: false, toolCalls: [...(last.toolCalls ?? []), ...(toolCalls ?? [])] }];
      }
      return [...prev, { id: nextId++, role: 'assistant', content, toolCalls }];
    });
  }, []);

  // Карточка инструмента: 'running' — read-only вызов исполняется (tool_start),
  // 'pending' — мутрующий ждёт подтверждения (tool_pending).
  const addToolCard = useCallback((
    callId: string,
    name: string,
    args: Record<string, unknown>,
    status: 'running' | 'pending',
    server?: string,
  ) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      const toolCall: ToolCallView = { callId, name, args, status, server };
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls ?? []), toolCall] }];
      }
      return [...prev, { id: nextId++, role: 'assistant', content: '', toolCalls: [toolCall] }];
    });
  }, []);

  const updateTool = useCallback((callId: string, patch: Partial<ToolCallView>) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.toolCalls?.some((tc) => tc.callId === callId)
          ? { ...m, toolCalls: m.toolCalls.map((tc) => (tc.callId === callId ? { ...tc, ...patch } : tc)) }
          : m,
      ),
    );
  }, []);

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const registerCard = useCallback((callId: string, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(callId, el);
    else cardRefs.current.delete(callId);
  }, []);

  // Решение по мутирующему вызову: единственная точка — закреплённая плашка
  // у поля ввода. callId запоминается до tool_result, чтобы кнопки не мигали.
  const decide = useCallback(
    (callId: string, action: 'approve' | 'reject') => {
      setDecidedCalls((prev) => {
        const next = new Set(prev);
        next.add(callId);
        return next;
      });
      sendWs({ type: action, callId });
    },
    [sendWs],
  );

  const scrollToCard = useCallback((callId: string) => {
    cardRefs.current.get(callId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const refreshDialogues = useCallback(async () => {
    try {
      const list = await api<{ dialogues: DialogueSummary[] }>(
        `/api/ai/dialogues?profileId=${encodeURIComponent(profile.id)}`,
      );
      setDialogues(list.dialogues);
    } catch {
      /* список обновится при следующем открытии */
    }
  }, [profile.id]);

  // Возвращает id созданного диалога (null при ошибке) — «открыть в новом
  // чате» из терминала привязывает к нему отложенную отправку.
  const startNewDialogue = useCallback(async (): Promise<string | null> => {
    try {
      const { dialogue } = await api<{ dialogue: Dialogue }>('/api/ai/dialogues', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id }),
      });
      setDialogues((prev) => [toSummary(dialogue), ...prev]);
      setActiveDialogueId(dialogue.id);
      setSqlInsertEnabled(false);
      return dialogue.id;
    } catch (err) {
      showError((err as Error).message);
      return null;
    }
  }, [profile.id, showError]);

  const removeDialogue = useCallback(
    async (id: string) => {
      if (id === activeDialogueId && running) {
        showError(t('agent.errorDialogueRunning'));
        return;
      }
      if (!window.confirm(t('agent.deleteConfirm'))) return;
      try {
        await api(`/api/ai/dialogues/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const remaining = dialogues.filter((d) => d.id !== id);
        setDialogues(remaining);
        if (id === activeDialogueId) {
          if (remaining.length > 0) {
            setActiveDialogueId(remaining[0].id);
          } else {
            await startNewDialogue();
          }
        }
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeDialogueId, running, dialogues, startNewDialogue, showError, t],
  );

  // Загрузка списка диалогов профиля; при отсутствии — создаём первый.
  useEffect(() => {
    let cancelled = false;
    setDialogues([]);
    setActiveDialogueId('');
    setMessages([]);
    setRunning(false);
    setPlanReady(false);
    setLoading(true);
    void (async () => {
      try {
        const list = await api<{ dialogues: DialogueSummary[] }>(
          `/api/ai/dialogues?profileId=${encodeURIComponent(profile.id)}`,
        );
        if (cancelled) return;
        setDialogues(list.dialogues);
        if (list.dialogues.length > 0) {
          setActiveDialogueId(list.dialogues[0].id);
        } else {
          const { dialogue } = await api<{ dialogue: Dialogue }>('/api/ai/dialogues', {
            method: 'POST',
            body: JSON.stringify({ profileId: profile.id }),
          });
          if (cancelled) return;
          setDialogues([toSummary(dialogue)]);
          setActiveDialogueId(dialogue.id);
        }
      } catch (err) {
        showError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile.id, showError]);

  // Подключение WS и загрузка истории выбранного диалога.
  useEffect(() => {
    if (!activeDialogueId) return;
    let cancelled = false;
    setMessages([]);
    setRunning(false);
    setPlanReady(false);
    setDecidedCalls(new Set());
    setLiveUsage(null);
    setSuggestion('');

    void api<{ dialogue: Dialogue }>(`/api/ai/dialogues/${encodeURIComponent(activeDialogueId)}`)
      .then(({ dialogue }) => {
        if (!cancelled) {
          setMessages((prev) => (prev.length === 0 ? messagesToViews(dialogue.messages) : prev));
        }
      })
      .catch(() => undefined);

    const ws = new WebSocket(
      `/ws/agent?profileId=${encodeURIComponent(profile.id)}&dialogueId=${encodeURIComponent(activeDialogueId)}&lang=${lang}`,
    );
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      // Отложенное первое сообщение нового диалога ('new-dialogue' из
      // терминала): сверка dialogueId закрывает гонку «пользователь успел
      // переключить диалог, пока коннектился» — замыкание держит id именно
      // этого WS. planMode: false — это готовый вопрос, а не планирование.
      const pending = pendingSendRef.current;
      if (pending && pending.dialogueId === activeDialogueId) {
        pendingSendRef.current = null;
        setMessages((prev) => [...prev, { id: nextId++, role: 'user', content: pending.content }]);
        setPlanReady(false);
        ws.send(JSON.stringify({ type: 'message', content: pending.content, planMode: false }));
      }
    };
    // Обрыв WS между кликом и tool_result: результат уже не придёт, снимаем
    // блокировку, чтобы плашка не зависала навсегда в «выполняется…»
    // (перезагрузка диалога пересоздаст сессию и состояние в любом случае).
    ws.onclose = () => {
      setConnected(false);
      setDecidedCalls(new Set());
    };
    ws.onerror = () => {
      setConnected(false);
      setDecidedCalls(new Set());
    };
    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'dialogue': {
          const id = String(msg.id ?? '');
          if (id && id !== activeDialogueId) setActiveDialogueId(id);
          break;
        }
        case 'token':
          pushAssistantToken(String(msg.content ?? ''));
          break;
        case 'message':
          finalizeAssistant(String(msg.content ?? ''));
          break;
        case 'suggestion':
          // Подсказка вероятного ответа агента: плейсхолдер поля ввода,
          // подставляется по Tab. На done не сбрасываем — агент ждёт ответа.
          setSuggestion(String(msg.text ?? ''));
          break;
        case 'tool_start':
          addToolCard(
            String(msg.callId ?? ''),
            String(msg.name ?? ''),
            (msg.args ?? {}) as Record<string, unknown>,
            'running',
            typeof msg.server === 'string' && msg.server ? msg.server : undefined,
          );
          break;
        case 'tool_pending':
          addToolCard(
            String(msg.callId ?? ''),
            String(msg.name ?? ''),
            (msg.args ?? {}) as Record<string, unknown>,
            'pending',
            typeof msg.server === 'string' && msg.server ? msg.server : undefined,
          );
          break;
        case 'servers': {
          const attached = Array.isArray(msg.attached) ? (msg.attached as AttachedServer[]) : [];
          setServersInfo({ home: String(msg.home ?? profile.id), attached });
          break;
        }
        case 'usage': {
          // Кумулятивные итоги диалога после каждой записи в журнал расходов.
          const totals = msg.totals as DialogueUsageTotals | undefined;
          if (totals && typeof totals.calls === 'number') setLiveUsage(totals);
          break;
        }
        case 'tool_result': {
          const callId = String(msg.callId ?? '');
          const status = msg.status === 'rejected' ? 'rejected' : msg.status === 'error' ? 'error' : 'ok';
          updateTool(callId, {
            status,
            output: String(msg.output ?? ''),
            truncated: Boolean(msg.truncated),
          });
          setDecidedCalls((prev) => {
            if (!prev.has(callId)) return prev;
            const next = new Set(prev);
            next.delete(callId);
            return next;
          });
          break;
        }
        case 'running':
          setRunning(true);
          setPlanReady(false);
          setSuggestion('');
          break;
        case 'plan_ready':
          setPlanReady(true);
          break;
        case 'done': {
          setRunning(false);
          if (msg.note) {
            setMessages((prev) => [...prev, { id: nextId++, role: 'assistant', content: `⚠️ ${String(msg.note)}` }]);
          }
          void refreshDialogues();
          break;
        }
        case 'error':
          setRunning(false);
          setSuggestion('');
          showError(String(msg.message ?? tRef.current('agent.errorFallback')));
          void refreshDialogues();
          break;
      }
    };
    return () => {
      cancelled = true;
      // Протухший pending: пользователь ушёл с диалога до onopen —
      // отложенное сообщение сбрасываем, чтобы не выстрелило при
      // следующем открытии этого диалога. Условно: безусловная очистка
      // роняла бы основной путь — ref заполняется до ре-рендера от
      // setActiveDialogueId, и cleanup предыдущего effect'а выполняется
      // уже после заполнения (там pending чужого dialogueId).
      if (pendingSendRef.current?.dialogueId === activeDialogueId) {
        pendingSendRef.current = null;
      }
      ws.close();
      wsRef.current = null;
    };
  }, [
    activeDialogueId,
    profile.id,
    // Смена языка интерфейса пересоздаёт WS: диалог тот же (dialogueId
    // сохраняется), но сессия агента собирается с новым языком промпта.
    // Обрыв стрима на середине при этом редком действии приемлем.
    lang,
    pushAssistantToken,
    finalizeAssistant,
    addToolCard,
    updateTool,
    showError,
    refreshDialogues,
  ]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Dropdown истории: закрывается по клику вне его и по Escape.
  useEffect(() => {
    if (!historyOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [historyOpen]);

  // Dropdown «+» (подключить сервер): закрывается по клику вне его и по Escape.
  useEffect(() => {
    if (!addOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAddOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [addOpen]);

  // Одновременно висит максимум одно подтверждение (сервер обрабатывает
  // вызовы последовательно) — плашка показывает ровно один pending-вызов.
  const pendingTool: ToolCallView | null =
    messages.flatMap((m) => m.toolCalls ?? []).find((tc) => tc.status === 'pending') ?? null;

  // Индикатор активности для сайдбара (App): висящее подтверждение (pending)
  // важнее, чем просто «работает» — без него агент молча ждёт approve в фоне.
  const hasPending = pendingTool !== null;
  useEffect(() => {
    onActivity?.(profile.id, hasPending ? 'pending' : running ? 'running' : null);
  }, [hasPending, running, onActivity, profile.id]);
  useEffect(() => {
    const id = profile.id;
    return () => onActivity?.(id, null);
  }, [onActivity, profile.id]);

  // Запрос «Спросить агента» из терминала: если WS готов и агент свободен —
  // отправляем сообщение сразу; иначе (нет соединения или идёт выполнение)
  // подставляем текст в поле ввода, чтобы пользователь отправил сам и текущий
  // поток не сломался. Запрос одноразовый: id запоминаем, App сбрасывает стейт.
  // mode: 'explain' (кнопка «Спросить агента») — как выше; 'prefill' — всегда
  // только вставка в поле ввода; 'new-dialogue' — создать диалог и отправить
  // текст первым сообщением (отложенно, в ws.onopen нового диалога);
  // 'send' — текст уже собран отправителем (SQL-консоль вкладки «Базы данных»),
  // отправляется как есть.
  const lastHandledRequestRef = useRef(0);
  // «→ SQL» на sql-блоках: активен, пока последний разовый запрос пришёл со
  // вкладки «Базы данных» (source === 'db'). Пассивный сброс при назначении
  // диалога (оно бывает поздним — при монтировании панели) не делаем: гасим
  // флаг только в явных действиях пользователя (новый диалог, выбор из
  // истории) — контекст запроса к этим моментам точно устарел.
  const [sqlInsertEnabled, setSqlInsertEnabled] = useState(false);
  useEffect(() => {
    if (!agentRequest || agentRequest.id === lastHandledRequestRef.current) return;
    lastHandledRequestRef.current = agentRequest.id;
    setSqlInsertEnabled(agentRequest.source === 'db');
    const mode = agentRequest.mode ?? 'explain';
    if (mode === 'prefill') {
      // Цитата без инструкции «объясни» — пользователь допишет свой вопрос;
      // набранное не затираем. Фокус и курсор в конец — после применённого
      // стейта, поэтому requestAnimationFrame.
      const block = t('agent.terminalPrefillBlock', { serverName: profile.name, text: agentRequest.text });
      setInput((prev) => (prev ? `${prev}\n\n${block}` : block));
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
      onAgentRequestConsumed?.();
      return;
    }
    if (mode === 'new-dialogue') {
      if (runningRef.current) {
        showError(t('agent.errorBusy'));
        onAgentRequestConsumed?.();
        return;
      }
      const content = terminalContextMessage(t, agentRequest.text, profile.name);
      void startNewDialogue().then((id) => {
        if (id) pendingSendRef.current = { content, dialogueId: id };
      });
      onAgentRequestConsumed?.();
      return;
    }
    // 'explain' и 'send' идут одним путём; 'send' текст не оборачивает.
    const content = mode === 'send'
      ? agentRequest.text
      : terminalContextMessage(t, agentRequest.text, profile.name);
    if (connectedRef.current && !runningRef.current && activeDialogueIdRef.current) {
      setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
      setPlanReady(false);
      sendWs({ type: 'message', content, planMode });
    } else {
      setInput(content);
    }
    onAgentRequestConsumed?.();
  }, [agentRequest, planMode, sendWs, onAgentRequestConsumed, profile.name, showError, startNewDialogue, t]);

  // «→ SQL» из sql-блока ответа: SQL уходит в редактор консоли нужного
  // профиля, App переключает на вкладку «Базы данных».
  const handleSqlInsert = useCallback(
    (sql: string) => onSqlInsert?.(profile.id, sql),
    [onSqlInsert, profile.id],
  );

  // Копирование текста сообщения агента (кнопка в бабле при наведении).
  const handleCopyMessage = useCallback(async (m: ChatMessageView) => {
    const text = m.content ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard может быть недоступен (http) — молча игнорируем.
      return;
    }
    setCopiedId(m.id);
    setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1600);
  }, []);

  // Подключённые серверы для чипов и модалки аудита: до события `servers`
  // показываем только домашний профиль.
  const attachedServers: AttachedServer[] = serversInfo?.attached ?? [
    { id: profile.id, name: profile.name, host: profile.host, username: profile.username },
  ];
  const homeServerId = serversInfo?.home ?? profile.id;
  const availableProfiles = allProfiles.filter((p) => !attachedServers.some((s) => s.id === p.id));

  // Итоги расходов текущего диалога: живое WS-значение (во время прогона)
  // важнее summary-значения из списка (обновляется по done/error).
  const activeUsage: DialogueUsageTotals | null =
    liveUsage ?? dialogues.find((d) => d.id === activeDialogueId)?.usage ?? null;

  // Кнопка «+»: при открытии подгружаем полный список профилей.
  const toggleAdd = () => {
    const next = !addOpen;
    setAddOpen(next);
    if (next) {
      void api<Profile[]>('/api/profiles')
        .then(setAllProfiles)
        .catch(() => undefined);
    }
  };

  const send = () => {
    const content = input.trim();
    if (!content || !connected || running || !activeDialogueId) return;
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
    setInput('');
    setPlanReady(false);
    setSuggestion('');
    // Правки к ожидающему плану — это тоже message с planMode=true:
    // сервер пересоставит план. Выход из режима — снять переключатель «План».
    sendWs({ type: 'message', content, planMode });
  };

  // Запуск «Проверки безопасности»: пароль (если введён) уходит отдельным
  // WS-сообщением sudo_credentials и хранится только в памяти сессии агента —
  // в текст запроса и историю диалога он не попадает. Если агент занят или
  // соединения нет — не запускаем (модалка остаётся открытой).
  const startAudit = () => {
    if (!connected || !activeDialogueId) {
      showError(t('agent.auditNoConnection'));
      return;
    }
    if (running) {
      showError(t('agent.errorBusyNow'));
      return;
    }
    const password = auditPassword;
    const targetId = auditServerId || profile.id;
    const targetName = attachedServers.find((s) => s.id === targetId)?.name ?? profile.name;
    if (password) {
      sendWs({ type: 'sudo_credentials', password, profileId: targetId });
    }
    const content =
      t('agent.auditPrompt') +
      (targetId !== profile.id ? t('agent.auditPromptServer', { name: targetName }) : '') +
      (password ? t('agent.auditPromptPrivileged') : '') +
      t('agent.auditPromptTail');
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
    setPlanReady(false);
    // planMode: false — аудит запускается сразу, минуя режим планирования.
    sendWs({ type: 'message', content, planMode: false });
    setAuditPassword('');
    setAuditServerId('');
    setAuditOpen(false);
  };

  return (
    <div className="page agent-page">
      <div className="agent-chat">
        <div className="agent-head">
          <span className="agent-brand">
            <span className="mark">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 3l1.9 5.8 5.8 1.9-5.8 1.9L12 18.4l-1.9-5.8-5.8-1.9 5.8-1.9z" />
              </svg>
            </span>
            {t('app.agent')}
          </span>
          <div className="agent-head-actions">
            <div className="agent-history" ref={historyRef}>
              <button
                className={`headbtn ${historyOpen ? 'open' : ''}`}
                title={t('agent.historyTitle')}
                onClick={() => {
                  const next = !historyOpen;
                  setHistoryOpen(next);
                  if (next) void refreshDialogues();
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l4 2" />
                </svg>
              </button>
              {historyOpen && (
                <div className="agent-history-dropdown">
                  <div className="agent-history-head">
                    <span className="sidebar-label">{t('agent.dialogues')}</span>
                    <button
                      className="btn btn-primary btn-mini"
                      onClick={() => {
                        setHistoryOpen(false);
                        void startNewDialogue();
                      }}
                    >
                      {t('agent.new')}
                    </button>
                  </div>
                  <div className="agent-history-list">
                    {dialogues.length === 0 && !loading && (
                      <div className="muted dialogue-empty">{t('agent.emptyDialogues')}</div>
                    )}
                    {dialogues.map((d) => (
                      <div
                        key={d.id}
                        className={`dialogue-item ${d.id === activeDialogueId ? 'active' : ''}`}
                        onClick={() => {
                          setActiveDialogueId(d.id);
                          setSqlInsertEnabled(false);
                          setHistoryOpen(false);
                        }}
                      >
                        <div className="dialogue-item-title" title={d.title}>
                          {d.title}
                        </div>
                        {d.extraProfileIds && d.extraProfileIds.length > 0 && (
                          <span
                            className="dialogue-badge"
                            title={t('agent.multiServerTitle', { n: d.extraProfileIds.length })}
                          >
                            +{d.extraProfileIds.length}
                          </span>
                        )}
                        <div className="dialogue-item-meta">
                          {formatRelativeDate(d.updatedAt)}
                          {d.usage && d.usage.calls > 0 ? ` · ${formatUsd(d.usage.costUsd)}` : ''}
                        </div>
                        <button
                          className="dialogue-delete"
                          title={t('agent.deleteDialogueTitle')}
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeDialogue(d.id);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              className="headbtn"
              title={t('agent.newDialogueTitle')}
              onClick={() => void startNewDialogue()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
              </svg>
            </button>
            <button
              className="headbtn"
              title={t('agent.auditButtonTitle')}
              onClick={() => {
                setAuditServerId('');
                setAuditOpen(true);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="agent-status">
          <span
            className={`status-dot ${connected ? (running ? 'pending' : 'connected') : 'disconnected'}`}
          />
          <span className="status-label">
            {running ? t('agent.statusRunning') : connected ? t('agent.statusReady') : t('agent.statusDisconnected')}
          </span>
          <span className="sep" />
          <span className="agent-ctx" title={`${profile.name} — ${profile.username}@${profile.host}`}>
            {profile.name} ({profile.username}@{profile.host})
          </span>
          <div className="agent-status-right">
            {activeUsage && activeUsage.calls > 0 && (
              <span
                className="cost-badge"
                title={usageTooltip(activeUsage, t, locale)}
                data-unpriced={activeUsage.unpricedCalls > 0 ? 'true' : undefined}
              >
                {/* Ни один вызов не протарифицирован — $0.0000 врал бы «бесплатно» */}
                ≈ {activeUsage.costUsd === 0 && activeUsage.unpricedCalls > 0 ? '—' : formatUsd(activeUsage.costUsd)}
              </span>
            )}
            <label
              className="mini-switch"
              title={t('agent.planSwitchTitle')}
            >
              <input
                type="checkbox"
                checked={planMode}
                onChange={(e) => setPlanMode(e.target.checked)}
              />
              <span className="sw" />
              {t('agent.planSwitch')}
            </label>
            {running && (
              <button className="btn btn-danger" onClick={() => sendWs({ type: 'stop' })}>
                {t('agent.stop')}
              </button>
            )}
          </div>
        </div>

        <div className="agent-servers">
          {attachedServers.map((s) => (
            <span
              key={s.id}
              className={`server-chip${s.id === homeServerId ? ' home' : ''}`}
              title={`${s.username}@${s.host}`}
            >
              {s.name}
              {s.id !== homeServerId && (
                <button
                  className="server-chip-remove"
                  title={t('agent.detachServerTitle')}
                  onClick={() => sendWs({ type: 'detach_server', profileId: s.id })}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          <div className="server-add" ref={addRef}>
            <button
              className="btn btn-ghost btn-mini"
              title={t('agent.attachServerTitle')}
              onClick={toggleAdd}
            >
              +
            </button>
            {addOpen && (
              <div className="server-add-dropdown">
                {availableProfiles.length === 0 && (
                  <div className="muted server-add-empty">{t('agent.noOtherServers')}</div>
                )}
                {availableProfiles.map((p) => (
                  <button
                    key={p.id}
                    className="server-add-item"
                    onClick={() => {
                      sendWs({ type: 'attach_server', profileId: p.id });
                      setAddOpen(false);
                    }}
                  >
                    <strong>{p.name}</strong>
                    <span className="muted">
                      {p.username}@{p.host}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="agent-messages" ref={listRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <p>{t('agent.emptyHintTask')}</p>
              <p className="muted">{t('agent.emptyHintRules')}</p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-row ${m.role}`}>
              {m.content && (
                <div className="bubble">
                  <Markdown
                    content={m.content}
                    onInsertSql={sqlInsertEnabled && onSqlInsert ? handleSqlInsert : undefined}
                  />
                  {m.role === 'assistant' && !m.streaming && (
                    <button
                      className={`copy-bubble-btn ${copiedId === m.id ? 'copied' : ''}`}
                      onClick={() => handleCopyMessage(m)}
                      title={t('agent.copyTitle')}
                    >
                      {copiedId === m.id ? <CheckIcon /> : <CopyIcon />}
                    </button>
                  )}
                </div>
              )}
              {m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {m.toolCalls.map((tc) => (
                    <ToolCard
                      key={tc.callId}
                      tool={tc}
                      decided={decidedCalls.has(tc.callId)}
                      registerCard={registerCard}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {planReady && !running && (
          <PlanCard onExecute={() => sendWs({ type: 'approve_plan' })} />
        )}

        {pendingTool && (
          <PendingBar
            tool={pendingTool}
            decided={decidedCalls.has(pendingTool.callId)}
            onApprove={() => decide(pendingTool.callId, 'approve')}
            onReject={() => decide(pendingTool.callId, 'reject')}
            onScrollToCard={() => scrollToCard(pendingTool.callId)}
          />
        )}

        <div className="agent-input">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              // Tab подставляет подсказку агента — только при строго пустом
              // поле (иначе сохраняем нативное поведение — переход фокуса).
              // Подставленный текст — обычное содержимое поля: правится
              // перед отправкой, Enter всегда нажимает пользователь.
              if (
                e.key === 'Tab' &&
                !e.shiftKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.metaKey &&
                suggestion &&
                input === ''
              ) {
                e.preventDefault();
                setInput(suggestion);
                requestAnimationFrame(() => {
                  const el = inputRef.current;
                  if (!el) return;
                  el.focus();
                  el.setSelectionRange(el.value.length, el.value.length);
                });
              }
            }}
            placeholder={
              suggestion ? t('agent.suggestionPlaceholder', { suggestion }) : t('agent.inputPlaceholder')
            }
            rows={2}
          />
          <button
            className="btn btn-primary"
            onClick={send}
            disabled={!connected || running || !input.trim() || !activeDialogueId}
          >
            {t('agent.send')}
          </button>
        </div>
      </div>

      {auditOpen && (
        <Modal title={t('agent.auditTitle')} onClose={() => setAuditOpen(false)}>
          <p className="muted">
            {t('agent.auditDesc')}
          </p>
          <div className="form-grid">
            <label>
              {t('agent.auditServerLabel')}
              <select value={auditServerId || homeServerId} onChange={(e) => setAuditServerId(e.target.value)}>
                {attachedServers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.username}@{s.host})
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('agent.auditPasswordLabel')}
              <input
                type="password"
                autoComplete="new-password"
                value={auditPassword}
                onChange={(e) => setAuditPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    startAudit();
                  }
                }}
                placeholder={t('agent.auditPasswordPlaceholder')}
              />
            </label>
          </div>
          <p className="muted">
            {t('agent.auditPasswordNote')}
          </p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setAuditOpen(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={startAudit}>
              {t('agent.auditStart')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function toSummary(d: Dialogue): DialogueSummary {
  return {
    id: d.id,
    title: d.title,
    preview: d.preview,
    messageCount: d.messageCount,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    extraProfileIds: d.extraProfileIds,
    usage: d.usage,
  };
}

// Подсказка бейджа стоимости: вызовы и токены (вход/выход/кэш); при вызовах
// без цены модели — честная пометка «неполная сумма».
function usageTooltip(u: DialogueUsageTotals, t: TFn, locale: string): string {
  const parts = [
    t('agent.usageCalls', { n: u.calls }),
    t('aiCosts.tipPrompt', { n: u.promptTokens.toLocaleString(locale) }),
    t('aiCosts.tipCached', { n: u.cachedTokens.toLocaleString(locale) }),
    t('aiCosts.tipCompletion', { n: u.completionTokens.toLocaleString(locale) }),
  ];
  if (u.unpricedCalls > 0) {
    parts.push(t('agent.usageUnpriced', { n: u.unpricedCalls }));
  }
  return parts.join('\n');
}

function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

function toolStatusFromContent(content: string): ToolCallView['status'] {
  const text = content.trim();
  if (text.startsWith('Ошибка:') || text.startsWith('Отклонено:')) return 'error';
  if (text.includes('Пользователь отклонил') || text.includes('Агент остановлен')) return 'rejected';
  return 'ok';
}

function messagesToViews(messages: DialogueMessage[]): ChatMessageView[] {
  const views: ChatMessageView[] = [];
  let lastAssistant: ChatMessageView | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      views.push({ id: nextId++, role: 'user', content: m.content ?? '' });
      lastAssistant = null;
    } else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls ?? []).map((tc) => ({
        callId: tc.id,
        name: tc.function?.name ?? '',
        args: parseToolArgs(tc.function?.arguments),
        status: 'ok' as const,
      }));
      const view: ChatMessageView = {
        id: nextId++,
        role: 'assistant',
        content: m.content ?? '',
        toolCalls: toolCalls.length ? toolCalls : undefined,
      };
      views.push(view);
      lastAssistant = toolCalls.length ? view : null;
    } else if (m.role === 'tool' && lastAssistant) {
      const tool = lastAssistant.toolCalls?.find((t) => t.callId === m.tool_call_id);
      if (tool) {
        tool.output = m.content ?? '';
        tool.status = toolStatusFromContent(m.content ?? '');
      }
    }
  }
  return views;
}

const TOOL_LABEL_KEYS: Record<string, I18nKey> = {
  exec: 'agent.tool.exec',
  exec_readonly: 'agent.tool.execReadonly',
  read_file: 'agent.tool.readFile',
  read_memory: 'agent.tool.readMemory',
  list_dir: 'agent.tool.listDir',
  write_file: 'agent.tool.writeFile',
  write_memory: 'agent.tool.writeMemory',
  docker_ps: 'agent.tool.dockerPs',
  docker_logs: 'agent.tool.dockerLogs',
  docker_inspect: 'agent.tool.dockerInspect',
  docker_action: 'agent.tool.dockerAction',
  security_audit: 'agent.tool.securityAudit',
  web_search: 'agent.tool.webSearch',
  list_servers: 'agent.tool.listServers',
};

// Человекочитаемый лейбл вызова; connect_server — карточка-вопрос про целевой
// сервер (приходит в поле server события, он ещё не подключён; фолбэк — args.server).
function toolLabel(tool: ToolCallView, t: TFn): string {
  if (tool.name === 'connect_server') {
    const target = tool.server ?? String(tool.args?.server ?? '');
    return t('agent.toolConnectServer', { target }) + (tool.status === 'pending' ? '?' : '');
  }
  const key = TOOL_LABEL_KEYS[tool.name];
  return key ? t(key) : tool.name;
}

// Главный аргумент вызова (запрос поиска, команда, путь) — видно,
// чем занят агент или что именно он предлагает выполнить.
function mainArgPreview(args?: Record<string, unknown>): string {
  for (const key of ['query', 'command', 'path', 'target', 'containerId']) {
    const v = args?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

// Полный главный аргумент для раскрытия в плашке подтверждения:
// команда exec целиком (многострочная), путь + размер содержимого
// write_file, сводка write_memory, docker-действие с целью;
// без главного аргумента — pretty-JSON args (как «Детали» карточки).
function fullArgText(tool: ToolCallView, t: TFn, locale: string): string {
  const args = tool.args ?? {};
  if (tool.name === 'write_file') {
    const lines = [t('agent.argPath', { path: typeof args.path === 'string' && args.path ? args.path : '—' })];
    if (typeof args.content === 'string') {
      lines.push(t('agent.argContent', { n: args.content.length.toLocaleString(locale) }));
    }
    return lines.join('\n');
  }
  if (tool.name === 'write_memory') {
    const lines: string[] = [];
    if (typeof args.reason === 'string' && args.reason.trim()) lines.push(t('agent.argReason', { reason: args.reason.trim() }));
    if (typeof args.content === 'string') {
      lines.push(t('agent.argMemoryContent', { n: args.content.length.toLocaleString(locale) }));
    }
    return lines.join('\n');
  }
  if (tool.name === 'docker_action') {
    const lines = [t('agent.argAction', { action: typeof args.action === 'string' && args.action ? args.action : '—' })];
    const parts: Array<[string, I18nKey]> = [
      ['target', 'agent.argLabelTarget'],
      ['image', 'agent.argLabelImage'],
      ['name', 'agent.argLabelName'],
      ['command', 'agent.argLabelCommand'],
    ];
    for (const [key, labelKey] of parts) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) lines.push(`${t(labelKey)}: ${v}`);
    }
    return lines.join('\n');
  }
  const main = mainArgPreview(args);
  return main || JSON.stringify(args, null, 2);
}

function ToolCard({ tool, decided, registerCard }: {
  tool: ToolCallView;
  decided: boolean;
  registerCard: (callId: string, el: HTMLDivElement | null) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const name = toolLabel(tool, t);
  // Пока инструмент выполняется или ждёт подтверждения, вместо вывода
  // показываем его главный аргумент (запрос поиска, команду, путь).
  const argPreview = mainArgPreview(tool.args);
  const preview = (
    tool.status === 'running' || tool.status === 'pending' ? argPreview : (tool.output ?? '')
  )
    .replace(/\s+/g, ' ')
    .trim();
  const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;

  return (
    <div
      className={`tool-card ${tool.status}${tool.name === 'web_search' ? ' web' : ''}`}
      ref={(el) => registerCard(tool.callId, el)}
    >
      <div className="tool-card-row">
        <span className={`tool-dot ${tool.status}`} />
        <span className="tool-name" title={name}>{name}</span>
        {tool.server && tool.name !== 'connect_server' && (
          <span className="tool-server" title={t('agent.serverBadgeTitle', { name: tool.server })}>
            {tool.server}
          </span>
        )}
        {tool.status === 'pending' ? (
          <>
            <span className="tool-status">
              {decided ? t('agent.statusRunning') : t('agent.toolWaiting')}
            </span>
            <span className="tool-preview" title={preview}>{short || '—'}</span>
          </>
        ) : (
          <>
            <span className={`tool-status ${tool.status}`}>
              {tool.status === 'running'
                ? t('agent.statusRunning')
                : tool.status === 'ok'
                  ? t('agent.toolOk')
                  : tool.status === 'rejected'
                    ? t('agent.toolRejected')
                    : t('agent.toolError')}
            </span>
            <span className="tool-preview" title={preview}>{short || '—'}</span>
          </>
        )}
        <button className="btn btn-ghost btn-mini tool-toggle" onClick={() => setExpanded((x) => !x)}>
          {expanded ? t('agent.hide') : t('agent.details')}
        </button>
      </div>
      {expanded && (
        <div className="tool-details">
          {Object.keys(tool.args).length > 0 && (
            <>
              <div className="tool-details-label">{t('agent.argsLabel')}</div>
              <pre className="args-view">{JSON.stringify(tool.args, null, 2)}</pre>
            </>
          )}
          {tool.output !== undefined && (
            <>
              <div className="tool-details-label">{t('agent.outputLabel')}{tool.truncated ? t('agent.outputTruncated') : ''}</div>
              <pre className="output-view">{tool.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Закреплённая плашка подтверждения мутирующего вызова — единая точка
// решения (кнопки из карточек в ленте убраны), всегда видна у поля ввода.
// Клик по строке скроллит ленту к карточке вызова; «Подробнее» раскрывает
// полный главный аргумент. После клика кнопки блокируются до tool_result.
function PendingBar({ tool, decided, onApprove, onReject, onScrollToCard }: {
  tool: ToolCallView;
  decided: boolean;
  onApprove: () => void;
  onReject: () => void;
  onScrollToCard: () => void;
}) {
  const { t, locale } = useT();
  const [expanded, setExpanded] = useState(false);
  // Очередь подтверждений: смена вызова мгновенно заменяет содержимое
  // плашки — раскрытие не переносится на следующий вызов.
  useEffect(() => {
    setExpanded(false);
  }, [tool.callId]);
  const name = toolLabel(tool, t);
  const preview = mainArgPreview(tool.args).replace(/\s+/g, ' ').trim();
  const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;

  return (
    <div className="pending-bar">
      <div
        className="pending-bar-row"
        title={t('agent.showCardTitle')}
        onClick={onScrollToCard}
      >
        <span className={`tool-dot ${decided ? 'running' : 'pending'}`} />
        <span className="pending-bar-name" title={name}>{name}</span>
        {tool.server && tool.name !== 'connect_server' && (
          <span className="tool-server" title={t('agent.serverBadgeTitle', { name: tool.server })}>
            {tool.server}
          </span>
        )}
        <span className="pending-bar-preview" title={preview}>{short || '—'}</span>
        <button
          className="btn btn-ghost btn-mini"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((x) => !x);
          }}
        >
          {expanded ? t('agent.hide') : t('agent.more')}
        </button>
        {decided ? (
          <span className="tool-status running">{t('agent.statusRunning')}</span>
        ) : (
          <>
            <button
              className="btn btn-primary btn-mini"
              onClick={(e) => {
                e.stopPropagation();
                onApprove();
              }}
            >
              {t('agent.approve')}
            </button>
            <button
              className="btn btn-danger btn-mini"
              onClick={(e) => {
                e.stopPropagation();
                onReject();
              }}
            >
              {t('agent.reject')}
            </button>
          </>
        )}
      </div>
      {expanded && (
        <pre className="args-view pending-bar-details">{fullArgText(tool, t, locale)}</pre>
      )}
    </div>
  );
}

// Карточка «План готов»: запускает исполнение плана (approve_plan).
// Отказ от плана — просто написать правки в чат: план будет пересоставлен.
function PlanCard({ onExecute }: { onExecute: () => void }) {
  const { t } = useT();
  // Решение отправлено на сервер — блокируем кнопку (паттерн как в ToolCard).
  const [sent, setSent] = useState(false);
  return (
    <div className="plan-card">
      <div className="plan-card-info">
        <span className="plan-card-title">{t('agent.planReady')}</span>
        <span className="plan-card-hint muted">
          {t('agent.planHint')}
        </span>
      </div>
      <button
        className="btn btn-primary"
        disabled={sent}
        onClick={() => {
          setSent(true);
          onExecute();
        }}
      >
        {sent ? t('agent.planStarted') : t('agent.planExecute')}
      </button>
    </div>
  );
}
