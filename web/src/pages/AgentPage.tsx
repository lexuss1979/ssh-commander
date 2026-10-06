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
import { TipBanner } from '../components/TipBanner';
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';
import { markTipSeen } from '../tips';

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  /** One-shot "Ask the agent" request (terminal/databases tab; consumed by the effect below). */
  agentRequest?: { id: number; text: string; mode?: AgentAskMode; source?: string } | null;
  onAgentRequestConsumed?: () => void;
  /** Sidebar activity indicator: 'pending' (awaiting approve) outranks 'running'. */
  onActivity?: (profileId: string, state: 'running' | 'pending' | null) => void;
  /**
   * "→ SQL" on sql blocks in replies (when the active request came from the
   * "Databases" tab): insert the SQL into the console editor and switch tabs.
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
  /** Server name from the tool_start/tool_pending/tool_result events (badge). */
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

// Icons for the agent message copy button.
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

// Template of a request built from terminal output ('explain' and 'new-dialogue' modes).
function terminalContextMessage(
  t: (key: I18nKey, params?: I18nParams | number) => string,
  text: string,
  serverName: string,
): string {
  return t('agent.terminalExplainPrompt', { serverName, text });
}

export function AgentPage({ profile, showError, agentRequest, onAgentRequestConsumed, onActivity, onSqlInsert }: Props) {
  // lang (unlike t) is in the WS effect deps: a UI language change
  // recreates the connection so the agent answers in the UI language.
  const { t, lang, locale } = useT();
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [dialogues, setDialogues] = useState<DialogueSummary[]>([]);
  const [activeDialogueId, setActiveDialogueId] = useState('');
  const [loading, setLoading] = useState(true);
  // Planning mode: messages are sent with planMode=true; the agent first
  // drafts a plan without tools and waits for approve_plan.
  const [planMode, setPlanMode] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  // The "Security audit" modal: an optional sudo password for the audit's root sections.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditPassword, setAuditPassword] = useState('');
  // The server to run the audit on ('' — the dialogue's home profile).
  const [auditServerId, setAuditServerId] = useState('');
  // Dropdown with the dialogue history (the "History" button in the toolbar).
  const [historyOpen, setHistoryOpen] = useState(false);
  // Servers attached to the dialogue (the WS `servers` event): home first.
  const [serversInfo, setServersInfo] = useState<{ home: string; attached: AttachedServer[] } | null>(null);
  // The "+" button dropdown — profiles that can be attached to the dialogue.
  const [addOpen, setAddOpen] = useState(false);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  // The decision on a mutating call has been sent (the bar buttons stay
  // disabled until tool_result); a dialogue switch resets it.
  const [decidedCalls, setDecidedCalls] = useState<Set<string>>(() => new Set());
  // Live spend totals of the dialogue (the WS `usage` event): updated after
  // every journal write — the badge moves during long runs, not only on
  // done (refreshDialogues). Reset on a dialogue switch.
  const [liveUsage, setLiveUsage] = useState<DialogueUsageTotals | null>(null);
  // Suggested likely reply (the WS `suggestion` event): the placeholder of the
  // empty input, Tab inserts the text. Lives only in the page state — until
  // the next turn (reset on running/send/error/dialogue switch), never
  // restored from the persisted dialogue. There is never any auto-send.
  const [suggestion, setSuggestion] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  // Deferred send of the first message into a just-created dialogue
  // ('new-dialogue' from the terminal): filled after a successful POST and
  // sent in ws.onopen once the new dialogue's WS is ready.
  const pendingSendRef = useRef<{ content: string; dialogueId: string } | null>(null);
  // The input field — for focus/caret after a terminal prefill.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // DOM cards of calls in the feed — clicking the confirmation bar scrolls to the card.
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  // Current values for the "Ask the agent" effect — kept out of deps,
  // so a state change does not consume the request twice.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const runningRef = useRef(running);
  runningRef.current = running;
  const activeDialogueIdRef = useRef(activeDialogueId);
  activeDialogueIdRef.current = activeDialogueId;
  // t for the WS effect kept out of deps: translations must not recreate the
  // connection (the tRef pattern from TerminalPage). The language itself
  // (lang) is in deps — changing it recreates the WS deliberately.
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

  // Tool card: 'running' — a read-only call is executing (tool_start),
  // 'pending' — a mutating one awaits approval (tool_pending).
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

  // The decision on a mutating call: the single place is the pinned bar by
  // the input field. callId is remembered before tool_result so the buttons
  // do not flicker.
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
      /* the list refreshes on the next open */
    }
  }, [profile.id]);

  // Returns the created dialogue id (null on error) — "open in a new chat"
  // from the terminal attaches its deferred send to it.
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

  // Load the dialogue list of the profile; create the first one when empty.
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

  // The multi-server tip (docs/feature-discovery-plan.md, item 3) must know up
  // front that there is something to attach: allProfiles is otherwise loaded
  // only when the "+" dropdown opens — too late for the banner condition.
  // The dropdown keeps refreshing the list on every open.
  useEffect(() => {
    let cancelled = false;
    void api<Profile[]>('/api/profiles')
      .then((list) => {
        if (!cancelled) setAllProfiles(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  // WS connection and history load for the selected dialogue.
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
      // Deferred first message of a new dialogue ('new-dialogue' from the
      // terminal): the dialogueId check closes the race "the user managed to
      // switch dialogues while connecting" — the closure holds the id of this
      // very WS. planMode: false — this is a ready question, not planning.
      const pending = pendingSendRef.current;
      if (pending && pending.dialogueId === activeDialogueId) {
        pendingSendRef.current = null;
        setMessages((prev) => [...prev, { id: nextId++, role: 'user', content: pending.content }]);
        setPlanReady(false);
        ws.send(JSON.stringify({ type: 'message', content: pending.content, planMode: false }));
      }
    };
    // WS dropped between the click and tool_result: the result will never
    // arrive, so unlock to keep the bar from hanging in "running…" forever
    // (reloading the dialogue recreates the session and state anyway).
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
          // The agent's suggested likely reply: the input placeholder,
          // inserted by Tab. Not reset on done — the agent is waiting for an
          // answer.
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
          // Cumulative dialogue totals after each spend-journal write.
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
        case 'error': {
          setRunning(false);
          setPlanReady(false);
          setSuggestion('');
          const error = String(msg.message ?? tRef.current('agent.errorFallback'));
          // The error stays visible in the chat; the partial reply is no longer streaming.
          setMessages((prev) => [
            ...prev.map((message) => message.streaming ? { ...message, streaming: false } : message),
            { id: nextId++, role: 'assistant', content: `⚠️ ${error}` },
          ]);
          showError(error);
          void refreshDialogues();
          break;
        }
      }
    };
    return () => {
      cancelled = true;
      // A stale pending: the user left the dialogue before onopen — reset the
      // deferred message so it does not fire on the next open of this
      // dialogue. Conditional on purpose: an unconditional clear would break
      // the main path — the ref is filled before the re-render caused by
      // setActiveDialogueId, and the cleanup of the previous effect runs only
      // after that fill (holding a pending of a different dialogueId).
      if (pendingSendRef.current?.dialogueId === activeDialogueId) {
        pendingSendRef.current = null;
      }
      ws.close();
      wsRef.current = null;
    };
  }, [
    activeDialogueId,
    profile.id,
    // A UI language change recreates the WS: the dialogue is the same
    // (dialogueId is kept), but the agent session is assembled with the new
    // prompt language. A mid-stream break on this rare action is acceptable.
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

  // History dropdown: closes on an outside click and on Escape.
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

  // The "+" dropdown (attach a server): closes on an outside click and on Escape.
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

  // At most one confirmation is pending at a time (the server processes calls
  // sequentially) — the bar shows exactly one pending call.
  const pendingTool: ToolCallView | null =
    messages.flatMap((m) => m.toolCalls ?? []).find((tc) => tc.status === 'pending') ?? null;

  // Activity indicator for the sidebar (App): a hanging confirmation (pending)
  // matters more than just "running" — without it the agent silently waits
  // for approve in the background.
  const hasPending = pendingTool !== null;
  useEffect(() => {
    onActivity?.(profile.id, hasPending ? 'pending' : running ? 'running' : null);
  }, [hasPending, running, onActivity, profile.id]);
  useEffect(() => {
    const id = profile.id;
    return () => onActivity?.(id, null);
  }, [onActivity, profile.id]);

  // The "Ask the agent" request from the terminal: if the WS is ready and the
  // agent is idle — send the message right away; otherwise (no connection or
  // a run in progress) put the text into the input so the user sends it
  // themselves and the current stream is not broken. The request is one-shot:
  // the id is remembered and App resets the state.
  // mode: 'explain' (the "Ask the agent" button) — as above; 'prefill' —
  // always only inserts into the input; 'new-dialogue' — create a dialogue
  // and send the text as the first message (deferred, in the new dialogue's
  // ws.onopen); 'send' — the text was already composed by the sender (the SQL
  // console of the "Databases" tab), sent as is.
  const lastHandledRequestRef = useRef(0);
  // "→ SQL" on sql blocks: active while the latest one-shot request came from
  // the "Databases" tab (source === 'db'). No passive reset when a dialogue is
  // assigned (it can happen late — when the panel mounts): the flag is only
  // cleared by explicit user actions (new dialogue, picking from history) —
  // by then the request context is definitely stale.
  const [sqlInsertEnabled, setSqlInsertEnabled] = useState(false);
  useEffect(() => {
    if (!agentRequest || agentRequest.id === lastHandledRequestRef.current) return;
    lastHandledRequestRef.current = agentRequest.id;
    setSqlInsertEnabled(agentRequest.source === 'db');
    const mode = agentRequest.mode ?? 'explain';
    if (mode === 'prefill') {
      // A quote without an "explain" instruction — the user will add their own
      // question; do not wipe what is already typed. Focus and caret to the
      // end — after the state is applied, hence requestAnimationFrame.
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
    // 'explain' and 'send' share one path; 'send' does not wrap the text.
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

  // "→ SQL" from a sql block of a reply: the SQL goes to the console editor of
  // the right profile, App switches to the "Databases" tab.
  const handleSqlInsert = useCallback(
    (sql: string) => onSqlInsert?.(profile.id, sql),
    [onSqlInsert, profile.id],
  );

  // Copying the text of an agent message (the button on the bubble on hover).
  const handleCopyMessage = useCallback(async (m: ChatMessageView) => {
    const text = m.content ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable (http) — silently ignore.
      return;
    }
    setCopiedId(m.id);
    setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1600);
  }, []);

  // Attached servers for the chips and the audit modal: until the `servers`
  // event, only the home profile is shown.
  const attachedServers: AttachedServer[] = serversInfo?.attached ?? [
    { id: profile.id, name: profile.name, host: profile.host, username: profile.username },
  ];
  const homeServerId = serversInfo?.home ?? profile.id;
  const availableProfiles = allProfiles.filter((p) => !attachedServers.some((s) => s.id === p.id));

  // Spend totals of the current dialogue: the live WS value (during a run)
  // wins over the summary value from the list (updated on done/error).
  const activeUsage: DialogueUsageTotals | null =
    liveUsage ?? dialogues.find((d) => d.id === activeDialogueId)?.usage ?? null;

  // The "+" button: load the full profile list when opened.
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
    // Edits to a pending plan are also a message with planMode=true:
    // the server will redraft the plan. Leaving the mode — toggle "Plan" off.
    sendWs({ type: 'message', content, planMode });
  };

  // Starting the "Security audit": the password (if entered) goes as a separate
  // sudo_credentials WS message and is kept only in the agent session memory —
  // it never reaches the request text or the dialogue history. If the agent is
  // busy or there is no connection — do not start (the modal stays open).
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
    // planMode: false — the audit starts right away, bypassing planning mode.
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
                        <div
                          className="dialogue-item-title"
                          title={d.title}
                        >
                          {/* 'Новый диалог' — the persisted auto-title sentinel
                              (server/src/ai/dialogues.ts); not translated on
                              the server, only the display is localized. */}
                          {d.title === 'Новый диалог' ? t('agent.dialogueUntitled') : d.title}
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
                {/* No call was priced at all — $0.0000 would lie "free" */}
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
                      // The multi-server tip retires on attach: the banner
                      // hides itself via the render condition (attached grows
                      // past the home server), the flag keeps it away after F5.
                      markTipSeen('agent-multi-server');
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

        {/* Multi-server tip (docs/feature-discovery-plan.md, item 3): shown
            while only the home server is attached and there is something to
            attach; attaching a server makes the condition false. */}
        {availableProfiles.length > 0 && attachedServers.length === 1 && (
          <TipBanner id="agent-multi-server">{t('tips.agentMultiServer')}</TipBanner>
        )}

        <div className="agent-messages" ref={listRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <p>{t('agent.emptyHintTask')}</p>
              <p className="muted">{t('agent.emptyHintRules')}</p>
              <p className="muted">{t('agent.emptyHintFeatures')}</p>
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
          // Approving the plan also switches plan mode off: it is one-shot,
          // otherwise the next message would be planned again (no tools)
          // instead of executed.
          <PlanCard
            onExecute={() => {
              setPlanMode(false);
              sendWs({ type: 'approve_plan' });
            }}
          />
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
              // Tab inserts the agent suggestion — only when the field is
              // strictly empty (otherwise the native behavior — moving focus
              // — is kept). The inserted text is ordinary field content:
              // edited before sending, Enter is always pressed by the user.
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

// Cost badge tooltip: calls and tokens (prompt/completion/cached); for calls
// without a model price — an honest "incomplete sum" note.
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

// Human-readable label of a call; connect_server — a question card about the
// target server (it arrives in the server field of the event, which is not
// attached yet; fallback — args.server).
function toolLabel(tool: ToolCallView, t: TFn): string {
  if (tool.name === 'connect_server') {
    const target = tool.server ?? String(tool.args?.server ?? '');
    return t('agent.toolConnectServer', { target }) + (tool.status === 'pending' ? '?' : '');
  }
  const key = TOOL_LABEL_KEYS[tool.name];
  return key ? t(key) : tool.name;
}

// The main argument of a call (search query, command, path) — shows what the
// agent is busy with or what exactly it proposes to run.
function mainArgPreview(args?: Record<string, unknown>): string {
  for (const key of ['query', 'command', 'path', 'target', 'containerId']) {
    const v = args?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

// The full main argument for expanding in the confirmation bar:
// the whole exec command (multiline), the path + content size of
// write_file, the write_memory summary, a docker action with its target;
// without a main argument — pretty-JSON of args (like the card's "Details").
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
  // While the tool is running or awaiting approval, its main argument (a
  // search query, command, path) is shown instead of the output.
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

// The pinned confirmation bar for a mutating call — the single decision
// point (the buttons on the feed cards were removed), always visible by the
// input. Clicking the row scrolls the feed to the call card; "Details"
// expands the full main argument. After a click the buttons are disabled
// until tool_result.
function PendingBar({ tool, decided, onApprove, onReject, onScrollToCard }: {
  tool: ToolCallView;
  decided: boolean;
  onApprove: () => void;
  onReject: () => void;
  onScrollToCard: () => void;
}) {
  const { t, locale } = useT();
  const [expanded, setExpanded] = useState(false);
  // A confirmation queue: switching calls replaces the bar contents
  // instantly — the expansion does not carry over to the next call.
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

// The "Plan ready" card: starts executing the plan (approve_plan).
// Rejecting the plan — just type the edits into the chat: the plan will be
// redrafted.
function PlanCard({ onExecute }: { onExecute: () => void }) {
  const { t } = useT();
  // The decision was sent to the server — disable the button (the ToolCard pattern).
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
