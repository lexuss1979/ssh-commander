import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { streamChatCompletion, type ChatMessage, type TokenUsage, type ToolCall } from './client.js';
import { sanitizeMessages } from './messages.js';
import { buildPlanRequestMessages, toolsForRequest } from './plan.js';
import { getToolDefs, READ_ONLY_TOOLS } from './tools.js';
import { checkReadOnlyCommand } from './guard.js';
import { readMemory, writeMemory, memoryPromptBlock } from './memory.js';
import { isSearchConfigured, searchWeb, type WebSearchUsage } from './web-search.js';
import { computeCostUsd } from './pricing.js';
import { recordUsage, usageTotalsByDialogue } from './usage.js';
import {
  attachedServersNote,
  multiServerNote,
  planApprovedMessage,
  suggestInstruction,
  systemPromptBase,
  webSearchNote,
} from './prompts.js';
import {
  createSuggestionTokenFilter,
  extractSuggestion,
} from './suggest.js';
import { exec, withSftp } from '../ssh/manager.js';
import {
  readFile as sftpReadFile,
  readdir as sftpReaddir,
  writeFile as sftpWriteFile,
  stat as sftpStat,
} from '../ssh/sftp.js';
import type { ExecResult, Profile } from '../types.js';
import {
  inspect,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  containerAction,
  pullImage,
  removeImage,
  runContainer,
  dockerExec,
} from '../services/docker.js';
import { runSecurityAudit } from '../services/security-audit.js';
import {
  assertNavigablePath,
  clampAgentLimit,
  diskUsageSnapshot,
  formatAgentDiskUsage,
  normalizeDiskPath,
  precheckNavigableDir,
  topFiles,
} from '../services/disk-usage.js';
import { getProfile, listProfiles } from '../profiles.js';
import {
  attachProfileToDialogue,
  createDialogue,
  detachProfileFromDialogue,
  getDialogue,
  saveDialogueMessages,
  type Dialogue,
} from './dialogues.js';

const MAX_TOOL_OUTPUT = 12000;

// Лимит вызовов web_search на один запуск цикла (каждый вызов — до
// MAX_USES_PER_CALL реальных поисков на стороне API). Общий шаг агента
// (AI_MAX_STEPS) ограничивает и это, но поиск — платный сетевой вызов,
// держим отдельный потолок.
const MAX_SEARCH_CALLS_PER_RUN = 10;

type WsMessage = Record<string, unknown>;

interface PendingCall {
  callId: string;
  resolve: (decision: 'approved' | 'rejected' | 'aborted') => void;
}

export class AgentSession {
  private messages: ChatMessage[] = [];
  private pending = new Map<string, PendingCall>();
  private steps = 0;
  private searchCalls = 0;
  private stopRequested = false;
  private running = false;
  private wsClosed = false;
  private loopAbort: AbortController | null = null;
  // План составлен и ждёт approve_plan (или правок обычным message с planMode=true).
  private planPending = false;
  // sudo-пароли для привилегированного security_audit по серверам диалога
  // (profileId → пароль). Только в памяти сессии: не логируются, не попадают
  // в сообщения диалога/на диск, не передаются модели.
  // Очищаются в stop()/onWsClose() и при detach сервера.
  private sudoPasswords = new Map<string, string>();
  // Серверы, подключённые к диалогу: домашний всегда, остальные — через
  // connect_server (approve) или attach_server (действие пользователя).
  private attached = new Map<string, Profile>();

  constructor(
    private homeProfile: Profile,
    private ws: WebSocket,
    dialogue?: Dialogue,
  ) {
    this.dialogueId = dialogue?.id ?? createDialogue(homeProfile.id).id;
    this.attached.set(homeProfile.id, homeProfile);
    // Подгружаем серверы, сохранённые в диалоге прошлой сессией;
    // несуществующие профили пропускаем, диалог от этого не ломается.
    for (const extraId of dialogue?.extraProfileIds ?? []) {
      const extra = getProfile(extraId);
      if (extra) {
        this.attached.set(extra.id, extra);
      } else {
        console.warn(`dialogue ${this.dialogueId}: attached profile ${extraId} not found, skipped`);
      }
    }
    // Статические тексты промпта — в ai/prompts.ts (ru/en, выбор по
    // config.ai.lang); здесь только склейка динамических частей.
    const lang = config.ai.lang;
    let systemPrompt = systemPromptBase(lang, `${homeProfile.username}@${homeProfile.host}`);
    // Мульти-серверность: домашний сервер диалога + подключённые к нему.
    systemPrompt += multiServerNote(lang);
    const attachedNames = [...this.attached.values()].map((p) => p.name);
    if (attachedNames.length > 1) {
      systemPrompt += attachedServersNote(lang, attachedNames);
    }
    if (isSearchConfigured()) {
      systemPrompt += webSearchNote(lang);
    }
    // Подсказка вероятного ответа (agent-suggest): маркер вырезается из ответа
    // до персиста и контекста (ai/suggest.ts), текст подсказки уходит на
    // фронтенд отдельным WS-событием suggestion. Инструкция консервативна
    // (асимметрия в пользу молчания): подсказка — только при заведомо
    // вероятном ответе; на открытые вопросы, равнозначные варианты и
    // необратимые/рискованные действия модель молчит.
    systemPrompt += suggestInstruction(lang);
    const memoryBlock = memoryPromptBlock(homeProfile.id, lang);
    if (memoryBlock) {
      systemPrompt += `\n\n${memoryBlock}`;
    }
    this.messages.push({
      role: 'system',
      content: systemPrompt,
    });
    for (const message of dialogue?.messages ?? []) {
      if (message.role !== 'system') {
        this.messages.push(message);
      }
    }
  }

  readonly dialogueId: string;

  get isRunning(): boolean {
    return this.running;
  }

  get isPlanPending(): boolean {
    return this.planPending;
  }

  notifyDialogue(): void {
    this.send({ type: 'dialogue', id: this.dialogueId });
  }

  /** Событие `servers` — шапка панели агента синхронизируется по нему. */
  notifyServers(): void {
    this.send(this.serversEvent());
  }

  /**
   * Резолвит параметр `server` инструмента в подключённый профиль.
   * Без имени — домашний сервер; имя матчится точно, затем без учёта регистра.
   * Ошибка — не исключение: возвращается текст для обычного tool_result,
   * чтобы цикл агента не падал на опечатке модели.
   */
  resolveServer(name?: string): { profile: Profile } | { error: string } {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      return { profile: this.homeProfile };
    }
    const attached = [...this.attached.values()];
    const exact = attached.find((p) => p.name === trimmed);
    if (exact) {
      return { profile: exact };
    }
    const lower = trimmed.toLowerCase();
    const insensitive = attached.find((p) => p.name.toLowerCase() === lower);
    if (insensitive) {
      return { profile: insensitive };
    }
    const known = this.findProfileByName(trimmed);
    if (known) {
      return {
        error:
          `Сервер «${known.name}» не подключён к диалогу — вызови connect_server ` +
          'или попроси пользователя подключить его.',
      };
    }
    const available = attached.map((p) => p.name).join(', ');
    return {
      error:
        `Неизвестный сервер «${trimmed}». Подключённые к диалогу серверы: ${available}. ` +
        'Полный список профилей — инструмент list_servers.',
    };
  }

  /** Ручное подключение сервера к диалогу (WS attach_server) — без approve. */
  attachServerById(profileId: string): { ok: true } | { ok: false; error: string } {
    const profile = getProfile(profileId);
    if (!profile) {
      return { ok: false, error: `Профиль ${profileId} не найден` };
    }
    if (!this.attached.has(profile.id)) {
      try {
        attachProfileToDialogue(this.dialogueId, profile.id);
      } catch (err) {
        return { ok: false, error: String((err as Error).message ?? err) };
      }
      this.attached.set(profile.id, profile);
      this.notifyServers();
    }
    return { ok: true };
  }

  /** Отключение сервера от диалога (WS detach_server). Домашний — нельзя. */
  detachServerById(profileId: string): { ok: true } | { ok: false; error: string } {
    if (profileId === this.homeProfile.id) {
      return { ok: false, error: 'Домашний сервер диалога отцепить нельзя' };
    }
    if (this.attached.delete(profileId)) {
      try {
        detachProfileFromDialogue(this.dialogueId, profileId);
      } catch (err) {
        console.warn(`Failed to detach profile ${profileId} from dialogue ${this.dialogueId}:`, err);
      }
      this.sudoPasswords.delete(profileId);
      this.notifyServers();
    }
    return { ok: true };
  }

  private serversEvent(): WsMessage {
    return {
      type: 'servers',
      home: this.homeProfile.id,
      attached: [...this.attached.values()].map((p) => ({
        id: p.id,
        name: p.name,
        host: p.host,
        username: p.username,
      })),
    };
  }

  /** Профиль по имени среди всех профилей приложения (точно, затем без регистра). */
  private findProfileByName(name: string): Profile | undefined {
    const all = listProfiles();
    const exact = all.find((p) => p.name === name);
    if (exact) {
      return exact;
    }
    const lower = name.toLowerCase();
    return all.find((p) => p.name.toLowerCase() === lower);
  }

  /**
   * Имя сервера для событий tool_start/tool_pending/tool_result (бейдж в UI).
   * Для connect_server — имя целевого сервера (он ещё не подключён);
   * для list_servers/web_search сервер не имеет смысла — поле опускается.
   */
  private serverLabelFor(name: string, args: Record<string, unknown>): string | undefined {
    const raw = typeof args.server === 'string' ? args.server.trim() : '';
    if (name === 'connect_server') {
      return raw ? (this.findProfileByName(raw)?.name ?? raw) : undefined;
    }
    if (name === 'list_servers' || name === 'web_search') {
      return undefined;
    }
    const resolved = this.resolveServer(raw || undefined);
    if ('profile' in resolved) {
      return resolved.profile.name;
    }
    return raw || undefined;
  }

  handleClientMessage(data: WsMessage): void {
    switch (data.type) {
      case 'message': {
        const content = String(data.content ?? '').trim();
        if (content && !this.running) {
          if (data.planMode === true) {
            // Режим планирования (или правки к ожидающему плану): составляем план заново.
            void this.runPlan(content);
          } else {
            // planMode=false/отсутствует — выход из режима планирования.
            this.planPending = false;
            void this.runLoop(content);
          }
        }
        break;
      }
      case 'approve_plan': {
        // План подтверждён: продолжаем тот же диалог обычным циклом с инструментами
        // (per-tool approve для мутирующих инструментов сохраняется).
        if (this.planPending && !this.running) {
          this.planPending = false;
          void this.runLoop(planApprovedMessage(config.ai.lang));
        }
        break;
      }
      case 'approve': {
        const callId = String(data.callId ?? '');
        const pending = this.pending.get(callId);
        if (pending) {
          this.pending.delete(callId);
          pending.resolve('approved');
        }
        break;
      }
      case 'reject': {
        const callId = String(data.callId ?? '');
        const pending = this.pending.get(callId);
        if (pending) {
          this.pending.delete(callId);
          pending.resolve('rejected');
        }
        break;
      }
      case 'sudo_credentials': {
        // sudo-пароль для привилегированного security_audit: только поле сессии
        // в памяти. НЕ логировать, НЕ сохранять в диалог, НЕ передавать модели.
        // profileId выбирает сервер диалога (по умолчанию — домашний).
        const password = typeof data.password === 'string' ? data.password : '';
        const profileId =
          typeof data.profileId === 'string' && data.profileId ? data.profileId : this.homeProfile.id;
        if (password) {
          this.sudoPasswords.set(profileId, password);
        } else {
          this.sudoPasswords.delete(profileId);
        }
        break;
      }
      case 'attach_server': {
        // Ручное подключение сервера чипом «+» — действие самого пользователя,
        // approve не требуется.
        const result = this.attachServerById(String(data.profileId ?? ''));
        if (!result.ok) {
          this.send({ type: 'error', message: result.error });
        }
        break;
      }
      case 'detach_server': {
        const result = this.detachServerById(String(data.profileId ?? ''));
        if (!result.ok) {
          this.send({ type: 'error', message: result.error });
        }
        break;
      }
      case 'stop': {
        this.stop();
        break;
      }
    }
  }

  stop(): void {
    this.stopRequested = true;
    this.planPending = false;
    // Пароли sudo не должны жить дольше текущего запуска.
    this.sudoPasswords.clear();
    this.loopAbort?.abort();
    for (const pending of this.pending.values()) {
      pending.resolve('aborted');
    }
    this.pending.clear();
  }

  onWsClose(): void {
    this.wsClosed = true;
    this.stop();
  }

  private send(data: WsMessage): void {
    if (!this.wsClosed && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private save(): void {
    try {
      saveDialogueMessages(this.dialogueId, this.messages);
    } catch (err) {
      console.warn(`Failed to save dialogue ${this.dialogueId}:`, err);
    }
  }

  /**
   * Запись usage вызова чата/плана (решения 3, 5, 6, 8): стоимость считается
   * и фиксируется в момент вызова; после записи сессия шлёт WS-событие
   * `{type:'usage', totals}` с кумулятивными итогами диалога — бейдж в тулбаре
   * двигается во время длинных прогонов. Ошибки журнала не роняют цикл агента
   * (try/catch + warn, как у save()).
   */
  private recordChatUsage(kind: 'chat' | 'plan', model: string, usage: TokenUsage): void {
    try {
      recordUsage({
        ts: Date.now(),
        profileId: this.homeProfile.id,
        dialogueId: this.dialogueId,
        kind,
        model,
        promptTokens: usage.promptTokens ?? 0,
        cachedTokens: usage.cachedTokens ?? 0,
        completionTokens: usage.completionTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        costUsd: computeCostUsd(model, {
          promptTokens: usage.promptTokens,
          cachedTokens: usage.cachedTokens,
          completionTokens: usage.completionTokens,
        }),
      });
      this.sendUsageTotals();
    } catch (err) {
      console.warn(`Failed to record usage for dialogue ${this.dialogueId}:`, err);
    }
  }

  /** Запись usage вызова web_search (решение 5) — отдельный kind. */
  private recordSearchUsage(model: string, usage: WebSearchUsage): void {
    try {
      recordUsage({
        ts: Date.now(),
        profileId: this.homeProfile.id,
        dialogueId: this.dialogueId,
        kind: 'web_search',
        model,
        promptTokens: usage.promptTokens ?? 0,
        cachedTokens: 0,
        completionTokens: usage.completionTokens ?? 0,
        reasoningTokens: 0,
        searchRequests: usage.searchRequests ?? 0,
        costUsd: computeCostUsd(model, {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          searchRequests: usage.searchRequests,
        }),
      });
      this.sendUsageTotals();
    } catch (err) {
      console.warn(`Failed to record web_search usage for dialogue ${this.dialogueId}:`, err);
    }
  }

  /** WS-событие `usage`: кумулятивные итоги диалога для живого бейджа. */
  private sendUsageTotals(): void {
    const totals = usageTotalsByDialogue().get(this.dialogueId);
    if (totals) {
      this.send({ type: 'usage', totals });
    }
  }

  private waitDecision(callId: string): Promise<'approved' | 'rejected' | 'aborted'> {
    return new Promise((resolve) => {
      this.pending.set(callId, { callId, resolve });
    });
  }

  /**
   * Шаг планирования: один запрос к API БЕЗ инструментов (ключ `tools`
   * отсутствует в теле запроса) с дополненным системным промптом. Ответ
   * модели — план — стримится как обычное assistant-сообщение (token/message),
   * затем отправляется `plan_ready`, и сессия ждёт `approve_plan` или правок.
   * Шаг планирования НЕ расходует лимит AI_MAX_STEPS: счётчик шагов ведётся
   * только в runLoop (исполнение с инструментами).
   */
  private async runPlan(userContent: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.planPending = false;
    this.messages = sanitizeMessages(this.messages);
    this.messages.push({ role: 'user', content: userContent });
    this.save();
    this.send({ type: 'running', steps: config.ai.maxSteps });

    try {
      this.loopAbort = new AbortController();
      let assistant: ChatMessage;
      try {
        // Holdback-фильтр: маркер [[SUGGEST]] и текст подсказки не мелькают
        // в стрим-пузыре. flush — только на успешном стриме (решение 5 плана).
        const tokenFilter = createSuggestionTokenFilter((t) => this.send({ type: 'token', content: t }));
        const result = await streamChatCompletion({
          messages: buildPlanRequestMessages(sanitizeMessages(this.messages)),
          tools: toolsForRequest(true),
          signal: this.loopAbort.signal,
          onToken: (token) => tokenFilter.push(token),
        });
        tokenFilter.flush();
        assistant = result.message;
        // Шаг планирования — тоже платный вызов: учитываем в журнале.
        if (result.usage) {
          this.recordChatUsage('plan', config.ai.model, result.usage);
        }
      } catch (err) {
        if (this.stopRequested) {
          this.send({ type: 'done', stopped: true, note: 'Агент остановлен пользователем.' });
        } else {
          this.send({ type: 'error', message: String((err as Error).message ?? err) });
        }
        return;
      }

      // Инструменты в запросе не передавались; если модель всё же вернула
      // tool_calls — игнорируем их и сохраняем только текст плана. Подсказка
      // в режиме планирования не нужна (точка решения — кнопка «Выполнить»),
      // но маркер на всякий случай вырезаем и здесь.
      const { content: planContent } = extractSuggestion(assistant.content ?? '');
      this.send({ type: 'message', role: 'assistant', content: planContent });
      this.messages.push({ role: 'assistant', content: planContent });
      this.save();
      this.planPending = true;
      this.send({ type: 'plan_ready' });
      this.send({ type: 'done' });
    } catch (err) {
      this.send({ type: 'error', message: String((err as Error).message ?? err) });
    } finally {
      this.save();
      this.running = false;
      this.loopAbort = null;
    }
  }

  private async runLoop(userContent: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.steps = 0;
    this.searchCalls = 0;
    // Не отправляем в API и не сохраняем оборванный обмен tool_calls (например,
    // после остановки агента или перезагрузки вкладки в середине вызова).
    this.messages = sanitizeMessages(this.messages);
    this.messages.push({ role: 'user', content: userContent });
    this.save();
    this.send({ type: 'running', steps: config.ai.maxSteps });

    try {
      while (this.steps < config.ai.maxSteps && !this.stopRequested) {
        this.steps += 1;
        this.loopAbort = new AbortController();

        let assistant: ChatMessage;
        try {
          // Holdback-фильтр: маркер [[SUGGEST]] и текст подсказки не мелькают
          // в стрим-пузыре. flush — только на успешном стриме: на пути
          // ошибки/останова удержанный хвост не важен (финального message
          // там всё равно нет, потеря косметическая).
          const tokenFilter = createSuggestionTokenFilter((t) => this.send({ type: 'token', content: t }));
          const result = await streamChatCompletion({
            messages: sanitizeMessages(this.messages),
            tools: getToolDefs(),
            signal: this.loopAbort.signal,
            onToken: (token) => tokenFilter.push(token),
          });
          tokenFilter.flush();
          assistant = result.message;
          // Каждый вызов чата — платная запись в журнале (решения 5, 6).
          if (result.usage) {
            this.recordChatUsage('chat', config.ai.model, result.usage);
          }
        } catch (err) {
          if (this.stopRequested) {
            this.send({ type: 'done', stopped: true, note: 'Агент остановлен пользователем.' });
          } else {
            this.send({ type: 'error', message: String((err as Error).message ?? err) });
          }
          return;
        }

        // Маркер [[SUGGEST]] вырезается до this.messages/save(): в персист и
        // контекст модели попадает только чистый контент. На финальном ходе
        // (без tool_calls — агент ждёт пользователя) подсказка уходит отдельным
        // WS-событием suggestion после message, до done.
        const { content, suggestion } = extractSuggestion(assistant.content ?? '');
        this.send({ type: 'message', role: 'assistant', content });
        this.messages.push(assistant.content === null ? assistant : { ...assistant, content });
        this.save();

        const calls = assistant.tool_calls ?? [];
        if (!calls.length) {
          if (suggestion) {
            this.send({ type: 'suggestion', text: suggestion });
          }
          this.send({ type: 'done' });
          return;
        }

        const toolMessages: ChatMessage[] = [];
        for (const call of calls) {
          if (this.stopRequested) break;
          const { name, args } = this.parseCall(call);
          const readOnly = READ_ONLY_TOOLS.has(name);
          const server = this.serverLabelFor(name, args);

          if (readOnly) {
            // Живая видимость read-only вызова: карточка «выполняется…» до
            // результата (без кнопок подтверждения — в отличие от tool_pending).
            this.send({ type: 'tool_start', callId: call.id, name, args, server });
            const result = await this.runTool(name, args);
            this.send({
              type: 'tool_result',
              callId: call.id,
              name,
              server,
              status: result.status,
              output: result.output,
              truncated: result.truncated,
            });
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              name,
              content: result.output,
            });
          } else {
            this.send({ type: 'tool_pending', callId: call.id, name, args, server });
            const decision = await this.waitDecision(call.id);
            if (decision === 'rejected' || decision === 'aborted') {
              const output = decision === 'aborted'
                ? 'Агент остановлен пользователем.'
                : 'Пользователь отклонил выполнение этого действия.';
              this.send({
                type: 'tool_result',
                callId: call.id,
                name,
                server,
                status: 'rejected',
                output,
              });
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                name,
                content: output,
              });
            } else {
              const result = await this.runTool(name, args);
              this.send({
                type: 'tool_result',
                callId: call.id,
                name,
                server,
                status: result.status,
                output: result.output,
                truncated: result.truncated,
              });
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                name,
                content: result.output,
              });
            }
          }
        }
        this.messages.push(...toolMessages);
        this.save();
      }

      if (this.stopRequested) {
        this.send({ type: 'done', stopped: true, note: 'Агент остановлен пользователем.' });
      } else {
        this.send({ type: 'done', note: `Достигнут лимит шагов (${config.ai.maxSteps}).` });
      }
    } catch (err) {
      this.send({ type: 'error', message: String((err as Error).message ?? err) });
    } finally {
      this.save();
      this.running = false;
      this.pending.clear();
      this.loopAbort = null;
    }
  }

  private parseCall(call: ToolCall): { name: string; args: Record<string, unknown> } {
    const name = call.function?.name ?? '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function?.arguments ?? '{}');
    } catch {
      args = { raw: call.function?.arguments ?? '' };
    }
    return { name, args };
  }

  private truncate(text: string): { output: string; truncated: boolean } {
    if (text.length <= MAX_TOOL_OUTPUT) return { output: text, truncated: false };
    return {
      output: `${text.slice(0, MAX_TOOL_OUTPUT)}\n\n… (вывод обрезан, показано ${MAX_TOOL_OUTPUT} символов)`,
      truncated: true,
    };
  }

  /**
   * Format a shell exec result for the model: the exit code is always
   * included, and a non-zero code is reported as an error so the model
   * sees the failure instead of a silent "ok".
   */
  private execToolResult(result: ExecResult): { status: 'ok' | 'error'; output: string; truncated: boolean } {
    const body = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(пустой вывод)';
    const output = `${body}\n(exit code: ${result.code ?? 'unknown'})`;
    if (result.code !== 0) {
      return { status: 'error', ...this.truncate(`Команда завершилась с ошибкой.\n${output}`) };
    }
    return { status: 'ok', ...this.truncate(output) };
  }

  /** Вывод list_servers: все профили без секретов + признак подключения к диалогу. */
  private listServersOutput(): string {
    const rows = listProfiles().map((p) => ({
      name: p.name,
      host: p.host,
      port: p.port,
      username: p.username,
      note: p.note,
      connected: this.attached.has(p.id),
    }));
    return JSON.stringify(rows, null, 2);
  }

  /**
   * Подключение сервера к диалогу по approve: запись в extraProfileIds диалога
   * и в attached сессии. tool_result включает блок памяти подключаемого
   * сервера — так память попадает в контекст лениво, не раздувая промпт.
   */
  private connectServer(name: string): { status: 'ok' | 'error'; output: string; truncated: boolean } {
    const trimmed = name.trim();
    if (!trimmed) {
      return { status: 'error', output: 'Не указано имя сервера (параметр server).', truncated: false };
    }
    const target = this.findProfileByName(trimmed);
    if (!target) {
      const available = listProfiles().map((p) => p.name).join(', ');
      return {
        status: 'error',
        output: `Неизвестный сервер «${trimmed}». Доступные профили: ${available || '(профилей нет)'}.`,
        truncated: false,
      };
    }
    if (this.attached.has(target.id)) {
      return { status: 'ok', output: `Сервер «${target.name}» уже подключён к диалогу.`, truncated: false };
    }
    attachProfileToDialogue(this.dialogueId, target.id);
    this.attached.set(target.id, target);
    this.notifyServers();
    let output = `Сервер «${target.name}» (${target.username}@${target.host}) подключён к диалогу.`;
    const memoryBlock = memoryPromptBlock(target.id, config.ai.lang);
    if (memoryBlock) {
      output += `\n\n${memoryBlock}`;
    }
    return { status: 'ok', ...this.truncate(output) };
  }

  private async runTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ status: 'ok' | 'error'; output: string; truncated: boolean }> {
    try {
      // Инструменты без привязки к подключённому серверу: список профилей,
      // подключение сервера к диалогу и сетевой веб-поиск.
      if (name === 'list_servers') {
        return { status: 'ok', ...this.truncate(this.listServersOutput()) };
      }
      if (name === 'connect_server') {
        return this.connectServer(String(args.server ?? ''));
      }
      if (name === 'web_search') {
        // Двойной гейтинг: без конфигурации инструмент модели не объявляется,
        // но вызов может прийти из старого диалога — отвечаем понятной ошибкой.
        if (!isSearchConfigured()) {
          return {
            status: 'error',
            output: 'Веб-поиск не настроен на сервере приложения (AI_SEARCH_API_BASE пуст).',
            truncated: false,
          };
        }
        this.searchCalls += 1;
        if (this.searchCalls > MAX_SEARCH_CALLS_PER_RUN) {
          return {
            status: 'error',
            output: `Достигнут лимит поисковых запросов (${MAX_SEARCH_CALLS_PER_RUN} за запуск).`,
            truncated: false,
          };
        }
        const result = await searchWeb(String(args.query ?? ''));
        if (result.usage) {
          this.recordSearchUsage(config.ai.searchModel, result.usage);
        }
        return { status: result.ok ? 'ok' : 'error', ...this.truncate(result.output) };
      }
      // Остальные инструменты адресуются серверу: параметр `server` (имя
      // профиля), по умолчанию — домашний сервер диалога. Ошибка резолва —
      // обычный tool_result с текстом, цикл не падает.
      const resolved = this.resolveServer(typeof args.server === 'string' ? args.server : undefined);
      if ('error' in resolved) {
        return { status: 'error', output: resolved.error, truncated: false };
      }
      const profile = resolved.profile;
      switch (name) {
        case 'exec_readonly': {
          const command = String(args.command ?? '');
          const guard = checkReadOnlyCommand(command);
          if (!guard.ok) {
            return { status: 'error', output: `Отклонено: ${guard.reason}`, truncated: false };
          }
          const result = await exec(profile, command, { timeoutMs: 60000 });
          return this.execToolResult(result);
        }
        case 'exec': {
          const command = String(args.command ?? '');
          const result = await exec(profile, command, { timeoutMs: 120000 });
          return this.execToolResult(result);
        }
        case 'read_file': {
          const path = String(args.path ?? '');
          const stat = await withSftp(profile, (sftp) => sftpStat(sftp, path));
          if ((stat.size ?? 0) > 256 * 1024) {
            return { status: 'error', output: 'Файл больше 256 КБ — используйте exec_readonly (head/tail).', truncated: false };
          }
          const content = await withSftp(profile, (sftp) => sftpReadFile(sftp, path, 'utf8'));
          return { status: 'ok', ...this.truncate(content) };
        }
        case 'read_memory': {
          const content = readMemory(profile.id);
          return {
            status: 'ok',
            ...this.truncate(content ?? '(MEMORY.md пока нет — записей из прошлых сессий нет)'),
          };
        }
        case 'write_memory': {
          const content = String(args.content ?? '');
          if (!content.trim()) {
            return { status: 'error', output: 'Пустое содержимое MEMORY.md — запись отменена.', truncated: false };
          }
          const { bytes } = writeMemory(profile.id, content);
          return { status: 'ok', output: `MEMORY.md обновлён (${bytes} байт).`, truncated: false };
        }
        case 'list_dir': {
          const path = String(args.path ?? '/');
          const entries = await withSftp(profile, (sftp) => sftpReaddir(sftp, path));
          const lines = entries.map((e) => {
            const a = e.attrs;
            const isDir = (a.mode & 0o170000) === 0o040000;
            return `${isDir ? 'd' : '-'} ${a.size ?? 0}\t${e.filename}`;
          });
          const output = lines.length ? lines.join('\n') : '(директория пуста)';
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'write_file': {
          const path = String(args.path ?? '');
          const content = String(args.content ?? '');
          await withSftp(profile, (sftp) => sftpWriteFile(sftp, path, content));
          return { status: 'ok', output: `Файл ${path} записан (${content.length} символов).`, truncated: false };
        }
        case 'docker_ps': {
          const containers = await listContainers(profile);
          const lines = containers.map((c) =>
            `${String(c.ID ?? c.ContainerID ?? '').slice(0, 12)} ${String(c.Image ?? '')} ${String(c.Status ?? '')} ${String(c.Names ?? '')}`,
          );
          return { status: 'ok', ...this.truncate(lines.join('\n') || '(контейнеров нет)') };
        }
        case 'docker_logs': {
          const id = String(args.containerId ?? '');
          const tail = String(args.tail ?? '100');
          const result = await dockerExec(profile, ['logs', '--tail', tail, id], { timeoutMs: 60000 });
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(логов нет)';
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'docker_inspect': {
          const target = String(args.target ?? '');
          const data = await inspect(profile, target);
          return { status: 'ok', ...this.truncate(JSON.stringify(data, null, 2)) };
        }
        case 'security_audit': {
          const sections = Array.isArray(args.sections)
            ? args.sections.map(String)
            : undefined;
          // privileged подставляется сервером, а не доверяется модели: root-проверки
          // выполняются, только когда пользователь ввёл sudo-пароль в UI (он хранится
          // в сессии и модели недоступен). Пароль берётся для целевого сервера.
          const sudoPassword = this.sudoPasswords.get(profile.id);
          const output = await runSecurityAudit(profile, {
            sections,
            privileged: sudoPassword != null,
            sudoPassword,
          });
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'disk_usage': {
          // Команды du/find собирает сервис из провалидированного пути (shq) —
          // произвольный shell в инструмент не попадает, deny-лист exec_readonly
          // не участвует (как у security_audit). Путь вне навигационных правил —
          // обычный tool_result с текстом, цикл не падает.
          let path: string;
          try {
            path = assertNavigablePath(normalizeDiskPath(String(args.path ?? '/')));
          } catch (err) {
            return { status: 'error', output: String((err as Error).message), truncated: false };
          }
          const limit = clampAgentLimit(args.limit);
          // Одна предпроверка на оба вызова (иначе две независимые SFTP-stat
          // на каждый вызов инструмента); транспорт/права — обычный tool_result,
          // цикл не падает.
          try {
            await precheckNavigableDir(profile, path);
          } catch (err) {
            return { status: 'error', output: String((err as Error).message), truncated: false };
          }
          const skipPrecheck = { skipPrecheck: true };
          // Каталоги — основной результат; файлы при отказе (нет find/stat)
          // деградируют в строку-пояснение, не роняя инструмент целиком.
          const [snap, files] = await Promise.allSettled([
            diskUsageSnapshot(profile, path, skipPrecheck),
            topFiles(profile, path, limit, skipPrecheck),
          ]);
          if (snap.status === 'rejected') {
            return { status: 'error', output: String((snap.reason as Error).message), truncated: false };
          }
          if (files.status === 'rejected') {
            return {
              status: 'ok',
              ...this.truncate(
                formatAgentDiskUsage(
                  path,
                  snap.value,
                  [],
                  limit,
                  `крупнейшие файлы недоступны: ${(files.reason as Error).message}`,
                ),
              ),
            };
          }
          return {
            status: 'ok',
            ...this.truncate(formatAgentDiskUsage(path, snap.value, files.value.files, limit)),
          };
        }
        case 'docker_action': {
          const action = String(args.action ?? '');
          const target = String(args.target ?? '');
          let output = '';
          switch (action) {
            case 'start':
            case 'stop':
            case 'restart':
              output = await containerAction(profile, action, target);
              break;
            case 'rm':
              output = await containerAction(profile, 'rm', target);
              break;
            case 'pull':
              output = await pullImage(profile, String(args.image ?? ''));
              break;
            case 'rmi':
              output = await removeImage(profile, target);
              break;
            case 'run':
              output = await runContainer(profile, {
                image: String(args.image ?? ''),
                name: args.name ? String(args.name) : undefined,
                ports: Array.isArray(args.ports) ? args.ports.map(String) : [],
                env: Array.isArray(args.env) ? args.env.map(String) : [],
                command: args.command ? String(args.command) : undefined,
              });
              break;
            default:
              return { status: 'error', output: `Неизвестное действие docker_action: ${action}`, truncated: false };
          }
          return { status: 'ok', output: output || 'Готово.', truncated: false };
        }
        default:
          return { status: 'error', output: `Неизвестный инструмент: ${name}`, truncated: false };
      }
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      return { status: 'error', output: `Ошибка: ${msg}`, truncated: false };
    }
  }
}

// Реестр активных сессий: ключ — домашний профиль диалога (модель
// «одна сессия на профиль» сохраняется и в мульти-серверном режиме).
const sessions = new Map<string, AgentSession>();

export function attachAgent(ws: WebSocket, profile: Profile, dialogueId?: string): AgentSession {
  const existing = sessions.get(profile.id);
  if (existing) {
    existing.stop();
    try {
      existing.onWsClose();
    } catch {
      /* noop */
    }
  }
  let dialogue: Dialogue | undefined;
  if (dialogueId) {
    const found = getDialogue(dialogueId);
    // Домашний профиль диалога обязан совпасть; extraProfileIds подгружаются
    // в конструкторе сессии (несуществующие пропускаются с warning).
    if (found?.profileId === profile.id) {
      dialogue = found;
    }
  }
  const session = new AgentSession(profile, ws, dialogue);
  sessions.set(profile.id, session);
  session.notifyDialogue();
  session.notifyServers();
  ws.on('close', () => {
    session.onWsClose();
    if (sessions.get(profile.id) === session) {
      sessions.delete(profile.id);
    }
  });
  return session;
}
