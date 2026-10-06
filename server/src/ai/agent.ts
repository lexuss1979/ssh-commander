import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { streamChatCompletion, type ChatMessage, type TokenUsage, type ToolCall } from './client.js';
import { sanitizeMessages } from './messages.js';
import { buildPlanRequestMessages, toolsForRequest } from './plan.js';
import { getToolDefs, isAutoRunnable } from './tools.js';
import { checkReadOnlyCommand } from './guard.js';
import { redactDockerEnv, redactSecrets } from './redact.js';
import { readMemory, writeMemory, memoryPromptBlock } from './memory.js';
import { isSearchConfigured, searchWeb, type WebSearchUsage } from './web-search.js';
import { getAiSettings } from '../services/settings.js';
import { computeCostUsd } from './pricing.js';
import { recordUsage, usageTotalsByDialogue } from './usage.js';
import {
  attachedServersNote,
  multiServerNote,
  planApprovedMessage,
  suggestInstruction,
  systemPromptBase,
  webSearchNote,
  type PromptLang,
} from './prompts.js';
import {
  createSuggestionTokenFilter,
  extractSuggestion,
} from './suggest.js';
import { aiStr } from './strings.js';
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

// Cap on web_search calls per loop run (each call is up to
// MAX_USES_PER_CALL actual searches on the API side). The overall agent
// step limit (AI_MAX_STEPS) also bounds this, but search is a paid
// network call — keep a separate ceiling.
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
  // A plan has been drafted and awaits approve_plan (or edits via a regular message with planMode=true).
  private planPending = false;
  // sudo passwords for privileged security_audit on the dialogue servers
  // (profileId → password). Session memory only: never logged, never
  // stored in dialogue messages/on disk, never passed to the model.
  // Cleared in stop()/onWsClose() and on server detach.
  private sudoPasswords = new Map<string, string>();
  // Servers attached to the dialogue: the home one always, the rest via
  // connect_server (approve) or attach_server (a user action).
  private attached = new Map<string, Profile>();

  constructor(
    private homeProfile: Profile,
    private ws: WebSocket,
    dialogue?: Dialogue,
    // The session lang — the language of the system prompt and responses —
    // comes from the client over the WS connection (query `lang`):
    // agent lang = UI lang.
    private readonly lang: PromptLang = 'ru',
  ) {
    this.dialogueId = dialogue?.id ?? createDialogue(homeProfile.id).id;
    this.attached.set(homeProfile.id, homeProfile);
    // Load servers saved into the dialogue by the previous session;
    // missing profiles are skipped — the dialogue keeps working.
    for (const extraId of dialogue?.extraProfileIds ?? []) {
      const extra = getProfile(extraId);
      if (extra) {
        this.attached.set(extra.id, extra);
      } else {
        console.warn(`dialogue ${this.dialogueId}: attached profile ${extraId} not found, skipped`);
      }
    }
    // Static prompt texts live in ai/prompts.ts (ru/en, chosen by the
    // session lang this.lang); only the dynamic parts are assembled here.
    const promptLang = this.lang;
    let systemPrompt = systemPromptBase(promptLang, `${homeProfile.username}@${homeProfile.host}`);
    // Multi-server: the dialogue home server + servers attached to it.
    systemPrompt += multiServerNote(promptLang);
    const attachedNames = [...this.attached.values()].map((p) => p.name);
    if (attachedNames.length > 1) {
      systemPrompt += attachedServersNote(promptLang, attachedNames);
    }
    if (isSearchConfigured()) {
      systemPrompt += webSearchNote(promptLang);
    }
    // Likely-answer suggestion (agent-suggest): the marker is cut from the
    // reply before persist and context (ai/suggest.ts), the suggestion text
    // goes to the frontend as a separate WS suggestion event. The
    // instruction is conservative (asymmetric in favor of silence): suggest
    // only when one answer is clearly likely; on open questions, equivalent
    // options and irreversible/risky actions the model stays silent.
    systemPrompt += suggestInstruction(promptLang);
    const memoryBlock = memoryPromptBlock(homeProfile.id, promptLang);
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

  /** The `servers` event — the agent panel header is synced from it. */
  notifyServers(): void {
    this.send(this.serversEvent());
  }

  /**
   * Resolves the tool's `server` parameter to an attached profile.
   * No name — the home server; the name is matched exactly, then
   * case-insensitively. An error is not an exception: the text comes back
   * as a regular tool_result, so the agent loop survives a model typo.
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
      return { error: aiStr(this.lang, 'serverNotAttached', { name: known.name }) };
    }
    const available = attached.map((p) => p.name).join(', ');
    return {
      error: aiStr(this.lang, 'unknownServer', { name: trimmed, available }),
    };
  }

  /** Manual attach of a server to the dialogue (WS attach_server) — no approve. */
  attachServerById(profileId: string): { ok: true } | { ok: false; error: string } {
    const profile = getProfile(profileId);
    if (!profile) {
      return { ok: false, error: aiStr(this.lang, 'profileNotFound', { id: profileId }) };
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

  /** Detach a server from the dialogue (WS detach_server). The home one cannot be detached. */
  detachServerById(profileId: string): { ok: true } | { ok: false; error: string } {
    if (profileId === this.homeProfile.id) {
      return { ok: false, error: aiStr(this.lang, 'homeServerDetach') };
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

  /** Profile by name among all app profiles (exact, then case-insensitive). */
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
   * Server name for the tool_start/tool_pending/tool_result events (a badge
   * in the UI). For connect_server — the target server name (not attached
   * yet); for list_servers/web_search a server makes no sense — the field
   * is omitted.
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
            // Plan mode (or edits to a pending plan): draft the plan again.
            void this.runPlan(content);
          } else {
            // planMode=false/absent — leaving plan mode.
            this.planPending = false;
            void this.runLoop(content);
          }
        }
        break;
      }
      case 'approve_plan': {
        // Plan approved: continue the same dialogue with the regular tool loop
        // (per-tool approve for mutating tools still applies).
        if (this.planPending && !this.running) {
          this.planPending = false;
          void this.runLoop(planApprovedMessage(this.lang));
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
        // sudo password for privileged security_audit: an in-memory session
        // field only. Do NOT log, do NOT store in the dialogue, do NOT pass
        // to the model. profileId selects the dialogue server (home by default).
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
        // Manual attach via the "+" chip — the user's own action,
        // no approve required.
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
    // sudo passwords must not outlive the current run.
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
   * Usage record for a chat/plan call (decisions 3, 5, 6, 8): the cost is
   * computed and fixed at call time; after the record the session sends a
   * `{type:'usage', totals}` WS event with the dialogue's cumulative totals —
   * the toolbar badge moves during long runs. Journal errors never break
   * the agent loop (try/catch + warn, same as save()).
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

  /** Usage record for a web_search call (decision 5) — a separate kind. */
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

  /** The `usage` WS event: the dialogue's cumulative totals for the live badge. */
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
   * Planning step: a single API request WITHOUT tools (the `tools` key is
   * absent from the request body) with an extended system prompt. The model's
   * reply — the plan — streams as a regular assistant message (token/message),
   * then `plan_ready` is sent and the session waits for `approve_plan` or
   * edits. The planning step does NOT consume the AI_MAX_STEPS budget: the
   * step counter is kept only in runLoop (execution with tools).
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
        // Holdback filter: the [[SUGGEST]] marker and the suggestion text
        // never flash in the stream bubble. flush — on a successful stream
        // only (decision 5 of the plan).
        const tokenFilter = createSuggestionTokenFilter((t) => this.send({ type: 'token', content: t }));
        const result = await streamChatCompletion({
          messages: buildPlanRequestMessages(sanitizeMessages(this.messages), this.lang),
          tools: toolsForRequest(true, this.lang),
          signal: this.loopAbort.signal,
          onToken: (token) => tokenFilter.push(token),
          lang: this.lang,
          sessionId: this.dialogueId,
        });
        tokenFilter.flush();
        assistant = result.message;
        // The planning step is a paid call too: record it in the journal.
        // The model comes from settings (getAiSettings), not env: env is
        // seeded into settings at first start and never read afterwards.
        if (result.usage) {
          this.recordChatUsage('plan', getAiSettings().model, result.usage);
        }
      } catch (err) {
        if (this.stopRequested) {
          this.send({ type: 'done', stopped: true, note: aiStr(this.lang, 'stoppedByUser') });
        } else {
          this.send({ type: 'error', message: String((err as Error).message ?? err) });
        }
        return;
      }

      // No tools were passed in the request; if the model still returned
      // tool_calls — ignore them and keep only the plan text. A suggestion
      // is not needed in plan mode (the decision point is the Run button),
      // but the marker is cut here as well, just in case.
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
    // Do not send to the API or persist a truncated tool_calls exchange (e.g.
    // after stopping the agent or reloading the tab mid-call).
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
          // Holdback filter: the [[SUGGEST]] marker and the suggestion text
          // never flash in the stream bubble. flush — on a successful stream
          // only: on the error/stop path the held-back tail does not matter
          // (there is no final message there anyway, the loss is cosmetic).
          const tokenFilter = createSuggestionTokenFilter((t) => this.send({ type: 'token', content: t }));
          const result = await streamChatCompletion({
            messages: sanitizeMessages(this.messages),
            tools: getToolDefs(this.lang),
            signal: this.loopAbort.signal,
            onToken: (token) => tokenFilter.push(token),
            lang: this.lang,
            sessionId: this.dialogueId,
          });
          tokenFilter.flush();
          assistant = result.message;
          // Every chat call is a paid journal record (decisions 5, 6).
          if (result.usage) {
            this.recordChatUsage('chat', getAiSettings().model, result.usage);
          }
        } catch (err) {
          if (this.stopRequested) {
            this.send({ type: 'done', stopped: true, note: aiStr(this.lang, 'stoppedByUser') });
          } else {
            this.send({ type: 'error', message: String((err as Error).message ?? err) });
          }
          return;
        }

        // The [[SUGGEST]] marker is cut before this.messages/save(): only the
        // clean content reaches the persist and the model context. On the
        // final turn (no tool_calls — the agent waits for the user) the
        // suggestion goes as a separate WS suggestion event after message,
        // before done.
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
          // Auto-run — only a read-only call with no signs of reading
          // secrets (ai/tools.ts): `read_file .env` goes to approve.
          const readOnly = isAutoRunnable(name, args);
          const server = this.serverLabelFor(name, args);

          if (readOnly) {
            // Live visibility of a read-only call: a "running…" card until
            // the result (no approval buttons — unlike tool_pending).
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
              const output = aiStr(
                this.lang,
                decision === 'aborted' ? 'stoppedByUser' : 'rejectedByUser',
              );
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
        this.send({ type: 'done', stopped: true, note: aiStr(this.lang, 'stoppedByUser') });
      } else {
        this.send({ type: 'done', note: aiStr(this.lang, 'stepLimitReached', { n: config.ai.maxSteps }) });
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

  /**
   * The single egress point for server data: tool output goes from here
   * straight into the model context (i.e. to the external provider), the UI
   * and the dialogue persist. That is why secret redaction (ai/redact.ts)
   * happens here too, and strictly BEFORE truncation: a truncated PEM block
   * loses its trailing `-----END`, the marker it is recognized by.
   */
  private truncate(text: string): { output: string; truncated: boolean } {
    const safe = redactSecrets(text, this.lang);
    if (safe.length <= MAX_TOOL_OUTPUT) return { output: safe, truncated: false };
    return {
      output: `${safe.slice(0, MAX_TOOL_OUTPUT)}\n\n${aiStr(this.lang, 'outputTruncated', { n: MAX_TOOL_OUTPUT })}`,
      truncated: true,
    };
  }

  /**
   * Format a shell exec result for the model: the exit code is always
   * included, and a non-zero code is reported as an error so the model
   * sees the failure instead of a silent "ok".
   */
  private execToolResult(result: ExecResult): { status: 'ok' | 'error'; output: string; truncated: boolean } {
    const body = [result.stdout, result.stderr].filter(Boolean).join('\n') || aiStr(this.lang, 'emptyOutput');
    const output = `${body}\n(exit code: ${result.code ?? 'unknown'})`;
    if (result.code !== 0) {
      return { status: 'error', ...this.truncate(`${aiStr(this.lang, 'commandFailed')}\n${output}`) };
    }
    return { status: 'ok', ...this.truncate(output) };
  }

  /** list_servers output: all profiles without secrets + whether attached to the dialogue. */
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
   * Attaching a server to the dialogue via approve: writes to the dialogue's
   * extraProfileIds and to the session's attached. The tool_result includes
   * the attached server's memory block — memory reaches the context lazily,
   * without bloating the prompt.
   */
  private connectServer(name: string): { status: 'ok' | 'error'; output: string; truncated: boolean } {
    const trimmed = name.trim();
    if (!trimmed) {
      return { status: 'error', output: aiStr(this.lang, 'serverNameMissing'), truncated: false };
    }
    const target = this.findProfileByName(trimmed);
    if (!target) {
      const available = listProfiles().map((p) => p.name).join(', ');
      return {
        status: 'error',
        output: aiStr(this.lang, 'unknownServerProfile', {
          name: trimmed,
          available: available || aiStr(this.lang, 'noProfiles'),
        }),
        truncated: false,
      };
    }
    if (this.attached.has(target.id)) {
      return { status: 'ok', output: aiStr(this.lang, 'serverAlreadyConnected', { name: target.name }), truncated: false };
    }
    attachProfileToDialogue(this.dialogueId, target.id);
    this.attached.set(target.id, target);
    this.notifyServers();
    let output = aiStr(this.lang, 'serverConnected', {
      name: target.name,
      target: `${target.username}@${target.host}`,
    });
    const memoryBlock = memoryPromptBlock(target.id, this.lang);
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
      // Tools not bound to an attached server: the profile list, attaching a
      // server to the dialogue, and the networked web search.
      if (name === 'list_servers') {
        return { status: 'ok', ...this.truncate(this.listServersOutput()) };
      }
      if (name === 'connect_server') {
        return this.connectServer(String(args.server ?? ''));
      }
      if (name === 'web_search') {
        // Double gating: without configuration the tool is not declared to
        // the model, but a call may still arrive from an old dialogue —
        // reply with a clear error.
        if (!isSearchConfigured()) {
          return {
            status: 'error',
            output: aiStr(this.lang, 'searchNotConfigured'),
            truncated: false,
          };
        }
        this.searchCalls += 1;
        if (this.searchCalls > MAX_SEARCH_CALLS_PER_RUN) {
          return {
            status: 'error',
            output: aiStr(this.lang, 'searchCallsLimit', { n: MAX_SEARCH_CALLS_PER_RUN }),
            truncated: false,
          };
        }
        const result = await searchWeb(String(args.query ?? ''), this.lang);
        if (result.usage) {
          this.recordSearchUsage(config.ai.searchModel, result.usage);
        }
        return { status: result.ok ? 'ok' : 'error', ...this.truncate(result.output) };
      }
      // The remaining tools are addressed to a server: the `server` parameter
      // (a profile name), the dialogue home server by default. A resolve
      // error is a regular tool_result with text — the loop keeps going.
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
            return { status: 'error', output: `${aiStr(this.lang, 'rejectedPrefix')}: ${guard.reason}`, truncated: false };
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
            return { status: 'error', output: aiStr(this.lang, 'fileTooLarge'), truncated: false };
          }
          const content = await withSftp(profile, (sftp) => sftpReadFile(sftp, path, 'utf8'));
          return { status: 'ok', ...this.truncate(content) };
        }
        case 'read_memory': {
          const content = readMemory(profile.id, this.lang);
          return {
            status: 'ok',
            ...this.truncate(content ?? aiStr(this.lang, 'memoryAbsent')),
          };
        }
        case 'write_memory': {
          // The prompt forbids writing secrets to memory, but that is only an
          // instruction: MEMORY.md outlives the session and is loaded into the
          // context on every start, so the content goes through the same
          // redaction.
          const content = redactSecrets(String(args.content ?? ''), this.lang);
          if (!content.trim()) {
            return { status: 'error', output: aiStr(this.lang, 'memoryEmptyContent'), truncated: false };
          }
          const { bytes } = writeMemory(profile.id, content, this.lang);
          return { status: 'ok', output: aiStr(this.lang, 'memoryUpdated', { n: bytes }), truncated: false };
        }
        case 'list_dir': {
          const path = String(args.path ?? '/');
          const entries = await withSftp(profile, (sftp) => sftpReaddir(sftp, path));
          const lines = entries.map((e) => {
            const a = e.attrs;
            const isDir = (a.mode & 0o170000) === 0o040000;
            return `${isDir ? 'd' : '-'} ${a.size ?? 0}\t${e.filename}`;
          });
          const output = lines.length ? lines.join('\n') : aiStr(this.lang, 'dirEmpty');
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'write_file': {
          const path = String(args.path ?? '');
          const content = String(args.content ?? '');
          await withSftp(profile, (sftp) => sftpWriteFile(sftp, path, content));
          return { status: 'ok', output: aiStr(this.lang, 'fileWritten', { path, n: content.length }), truncated: false };
        }
        case 'docker_ps': {
          const containers = await listContainers(profile);
          const lines = containers.map((c) =>
            `${String(c.ID ?? c.ContainerID ?? '').slice(0, 12)} ${String(c.Image ?? '')} ${String(c.Status ?? '')} ${String(c.Names ?? '')}`,
          );
          return { status: 'ok', ...this.truncate(lines.join('\n') || aiStr(this.lang, 'noContainers')) };
        }
        case 'docker_logs': {
          const id = String(args.containerId ?? '');
          const tail = String(args.tail ?? '100');
          const result = await dockerExec(profile, ['logs', '--tail', tail, id], { timeoutMs: 60000 });
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || aiStr(this.lang, 'noLogs');
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'docker_inspect': {
          const target = String(args.target ?? '');
          const data = await inspect(profile, target);
          // Env values are redacted structurally, before any text matching:
          // `docker inspect` is the densest source of foreign secrets (the
          // app's entire .env in one piece), and variable names are more
          // reliable than regex.
          const safe = redactDockerEnv(data, this.lang);
          return { status: 'ok', ...this.truncate(JSON.stringify(safe, null, 2)) };
        }
        case 'security_audit': {
          const sections = Array.isArray(args.sections)
            ? args.sections.map(String)
            : undefined;
          // privileged is set by the server, not trusted from the model: root
          // checks run only when the user entered a sudo password in the UI
          // (it lives in the session and is unavailable to the model). The
          // password is taken for the target server.
          const sudoPassword = this.sudoPasswords.get(profile.id);
          const output = await runSecurityAudit(profile, {
            sections,
            privileged: sudoPassword != null,
            sudoPassword,
            lang: this.lang,
          });
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'disk_usage': {
          // The du/find commands are assembled by the service from a
          // validated path (shq) — no arbitrary shell reaches the tool, the
          // exec_readonly allow-list is not involved (same as security_audit).
          // A path outside the navigation rules is a regular tool_result with
          // text — the loop keeps going.
          let path: string;
          try {
            path = assertNavigablePath(normalizeDiskPath(String(args.path ?? '/')));
          } catch (err) {
            return { status: 'error', output: String((err as Error).message), truncated: false };
          }
          const limit = clampAgentLimit(args.limit);
          // One precheck for both calls (otherwise two independent SFTP-stats
          // per tool call); transport/permissions are a regular tool_result,
          // the loop keeps going.
          try {
            await precheckNavigableDir(profile, path);
          } catch (err) {
            return { status: 'error', output: String((err as Error).message), truncated: false };
          }
          const skipPrecheck = { skipPrecheck: true };
          // Directories are the main result; files on failure (no find/stat)
          // degrade to an explanatory line, without failing the whole tool.
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
                  aiStr(this.lang, 'diskFilesUnavailable', { message: (files.reason as Error).message }),
                  this.lang,
                ),
              ),
            };
          }
          return {
            status: 'ok',
            ...this.truncate(formatAgentDiskUsage(path, snap.value, files.value.files, limit, undefined, this.lang)),
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
              return { status: 'error', output: aiStr(this.lang, 'unknownDockerAction', { action }), truncated: false };
          }
          return { status: 'ok', output: output || aiStr(this.lang, 'done'), truncated: false };
        }
        default:
          return { status: 'error', output: aiStr(this.lang, 'unknownTool', { name }), truncated: false };
      }
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      return { status: 'error', output: `${aiStr(this.lang, 'errorPrefix')}: ${msg}`, truncated: false };
    }
  }
}

// Registry of active sessions: the key is the dialogue's home profile (the
// "one session per profile" model holds in the multi-server mode too).
const sessions = new Map<string, AgentSession>();

export function attachAgent(
  ws: WebSocket,
  profile: Profile,
  dialogueId?: string,
  lang?: PromptLang,
): AgentSession {
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
    // The dialogue's home profile must match; extraProfileIds are loaded in
    // the session constructor (missing ones are skipped with a warning).
    if (found?.profileId === profile.id) {
      dialogue = found;
    }
  }
  const session = new AgentSession(profile, ws, dialogue, lang);
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
