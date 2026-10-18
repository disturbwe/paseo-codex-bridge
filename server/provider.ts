import { imagePath } from "./images";
import { toolsEndpoint } from "./endpoints";
import { randomUUID } from "node:crypto";
import {
  negotiateProviderCapabilities,
  type ProviderRegistration, type ProviderConnection, type ProviderInput,
  type ProviderEvent, type ProviderPersistence, type ProviderTimelineItem,
  type ProviderSessionConfig,
  type ProviderModel,
} from "@getpaseo/plugin/server/provider";
import { DesktopBridge } from "./bridge";
import { desktopDefault } from "./models";
import { childSessionId, childrenFromItem, type DesktopChild } from "./subagents";

type Json = any;
const supported = ["prompt.message", "session.list", "session.persistence", "session.configure", "session.subsession", "session.archive", "session.unarchive", "timeline.plugin"] as const;
const modes = [{ id: "desktop", label: "沿用 Desktop 权限设置" }];
const persistence = (threadId: string): ProviderPersistence => ({ version: 1, data: { threadId } });

export function turnsFromState(state: Json): Json[] {
  const history = state.turnHistory?.kind === "canonical" ? state.turnHistory.history : null;
  return history ? history.islands.flatMap((island: Json) => island.entries.map((entry: Json) => history.entitiesByKey[entry.value])).filter(Boolean) : state.turns ?? [];
}

export function timelineFromItem(item: Json): ProviderTimelineItem | null {
  const id = `desktop:${item.id}`;
  if (item.type === "agentMessage" && typeof item.text === "string") return { type: "assistant_message", id, text: item.text, messageId: item.id };
  if (item.type === "userMessage") {
    const text = (item.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n");
    return text ? { type: "user_message", id, text, messageId: item.id } : null;
  }
  if (item.type === "functionCallOutput" && item.namespace === "codex_app" && ["create_thread", "send_message_to_thread"].includes(item.name) && typeof item.output === "string") {
    const delegated = item.output.match(/<codex_delegation>[\s\S]*?<input>([\s\S]*)<\/input>\s*<\/codex_delegation>/);
    if (delegated) return { type: "user_message", id, text: delegated[1], messageId: item.id };
  }
  if (item.type === "imageView") {
    const filePath=imagePath(item.path)??"";
    const status=item.status==="inProgress"?"running":item.status==="failed"?"failed":item.status==="interrupted"?"canceled":"completed";
    return {type:"plugin",id,pluginId:"paseo-codex-desktop",kind:"desktop-image-view",version:1,data:{callId:item.id,filePath,status}};
  }
  if (item.type === "commandExecution") {
    const status = item.status === "inProgress" ? "running" : item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0) ? "failed" : item.status === "interrupted" ? "canceled" : "completed";
    const detail = { type: "shell" as const, command: item.command ?? "", cwd: item.cwd, output: item.aggregatedOutput ?? item.output?.text ?? "", exitCode: item.exitCode ?? null };
    return status === "failed" ? { type: "tool_call", id, callId: item.id, name: "Desktop command", detail, status, error: { message: "Command failed", exitCode: item.exitCode ?? null } } : { type: "tool_call", id, callId: item.id, name: "Desktop command", detail, status, error: null };
  }
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    const receivers = item.receiverThreadIds ?? (item.agentThreadId ? [item.agentThreadId] : []);
    const status = item.status === "failed" ? "failed" : item.kind === "interrupted" || item.status === "interrupted" ? "canceled" : item.status === "completed" ? "completed" : "running";
    const detail = { type: "sub_agent" as const, subAgentType: "Desktop 子任务", description: item.prompt ?? item.agentPath ?? item.tool, ...(receivers.length === 1 ? { childSessionId: childSessionId(receivers[0]) } : {}), log: "" };
    return status === "failed" ? { type: "tool_call", id, callId: item.id, name: item.tool ?? "Desktop subagent", detail, status, error: { message: "Desktop subagent operation failed" } } : { type: "tool_call", id, callId: item.id, name: item.tool ?? "Desktop subagent", detail, status, error: null };
  }
  // Private reasoning and raw tool arguments are never copied into the UI.
  return null;
}

interface Session {
  id: string; config: ProviderSessionConfig; threadId?: string;
  seen: Map<string, string>; ignoredTurns: Set<string>; externalTurns: Set<string>;
  pending?: { clientMessageId: string; turnId: string; nativeTurnId?: string };
  replaying: boolean; sending: boolean; closed: boolean; cancelRequested: boolean;
  configFingerprint?: string;
  parentId?: string;
}

export class DesktopProviderConnection implements ProviderConnection {
  readonly version = 1;
  private listeners = new Set<(event: ProviderEvent) => void>();
  private sessions = new Map<string, Session>();
  private dispose: () => void;
  private disposeArchives: () => void;
  private closed = false;
  private models: ProviderModel[] = [desktopDefault];
  constructor(private bridge: DesktopBridge, readonly capabilities: readonly string[]) {
    this.disposeArchives=bridge.subscribeArchived(id=>{
      for(const session of this.sessions.values())if(session.threadId===id){session.closed=true;this.emit({type:"session.closed",sessionId:session.id});this.sessions.delete(session.id);}
    });
    this.dispose = bridge.subscribe((id, state) => {
      for (const session of this.sessions.values()) if (session.threadId === id && !session.closed && !session.sending) this.update(session, state);
    }, error => {
      for (const session of this.sessions.values()) this.emit({ type: "session.runtime_failed", sessionId: session.id, error: { message: error.message } });
    });
  }
  onEvent(listener: (event: ProviderEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: ProviderEvent) {
    if (this.closed) return;
    for (const listener of this.listeners) listener(event);
  }
  async send(input: ProviderInput) {
    if (this.closed) throw new Error("Desktop provider connection is closed");
    // Acceptance is immediate. Outcomes are correlated protocol events.
    void this.handle(input).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (input.type === "session.prompt") {
        const session = this.sessions.get(input.sessionId);
        if (session?.pending?.clientMessageId === input.prompt.clientMessageId) {
          this.emit({ type: "session.turn", sessionId: session.id, turnId: session.pending.turnId, state: "failed", error: { message } });
          session.pending = undefined; session.sending = false;
        } else this.emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message } } });
      } else if ("requestId" in input) this.emit({ type: "request.failed", requestId: input.requestId, error: { message } });
    });
  }
  private async handle(input: ProviderInput): Promise<void> {
    if (input.type === "catalog") {
      this.models = await this.bridge.models();
      this.emit({ type: "catalog", requestId: input.requestId, catalog: { models: this.models, modes, defaultModel: "desktop", defaultMode: "desktop" } }); return;
    }
    if (input.type === "sessions") {
      const state = await this.bridge.listSessions();
      this.emit({ type: "sessions", requestId: input.requestId, sessions: state.sessions.filter(s => (!input.query || s.title.toLowerCase().includes(input.query.toLowerCase()) || s.id === input.query) && (!input.cwd || !s.cwd || (process.platform === "win32" ? s.cwd.toLowerCase() === input.cwd.toLowerCase() : s.cwd === input.cwd))).slice(0, input.limit ?? 50).map(s => ({ persistence: persistence(s.id), cwd: s.cwd ?? input.cwd ?? "", title: s.title, description: `Desktop thread: ${s.id}` })) }); return;
    }
    if (input.type === "session.open") {
      if (this.sessions.has(input.sessionId)) throw new Error("Duplicate Desktop provider session");
      this.models = await this.bridge.models();
      this.validateSelection(input.config.model, input.config.thinkingOption);
      const stored = input.persistence?.data as Json;
      if (input.persistence && (input.persistence.version !== 1 || typeof stored?.threadId !== "string")) throw new Error("Invalid Desktop session persistence");
      const threadId = stored?.threadId ?? input.config.providerOptions?.threadId;
      const session: Session = { id: input.sessionId, config: input.config, threadId: typeof threadId === "string" ? threadId : undefined, seen: new Map(), ignoredTurns: new Set(), externalTurns: new Set(), replaying: input.history === "replay", sending: true, closed: false, cancelRequested: false };
      this.sessions.set(session.id, session);
      try {
        if (session.threadId) {
          this.bridge.bindRoot(session.threadId, session.config.env);
          try { await this.bridge.follow(session.threadId); }
          catch { await this.bridge.open(session.threadId); await this.bridge.follow(session.threadId); }
        }
        const state = session.threadId ? this.bridge.snapshot(session.threadId) : null;
        if (session.threadId && input.config.model && input.config.model !== "desktop") {
          const current = state?.latestModel;
          if (current !== input.config.model || (input.config.thinkingOption && input.config.thinkingOption !== state?.latestReasoningEffort)) {
            const thinking = this.selectThinking(input.config.model, input.config.thinkingOption, state?.latestReasoningEffort);
            const committed = await this.bridge.configureSession(session.threadId, input.config.model, thinking);
            session.config = { ...session.config, model: committed.model, thinkingOption: committed.reasoningEffort ?? undefined };
          }
        }
        this.emit({ type: "session.opened", requestId: input.requestId, sessionId: session.id, capabilities: this.capabilities, restoration: "core", cwd: state?.cwd ?? input.config.cwd, title: input.config.title ?? state?.title, ...(session.threadId ? { persistence: persistence(session.threadId) } : {}) });
        this.emitConfig(session, state);
        if (state) {
          if (session.replaying) this.update(session, state);
          else for (const turn of turnsFromState(state)) if (turn.status !== "inProgress") session.ignoredTurns.add(turn.turnId);
        }
        session.sending = false; session.replaying = false;
        this.emit({ type: "session.ready", requestId: input.requestId, sessionId: session.id });
        if (state) this.update(session, state);
      } catch (error) { this.sessions.delete(session.id); throw error; }
      return;
    }
    if (input.type === "session.prompt") {
      const session = this.requireSession(input.sessionId);
      if (session.pending || session.sending) throw new Error("Desktop 会话正在执行，请先停止当前轮次。");
      if (input.prompt.input.type !== "message" || input.prompt.delivery === "steer") throw new Error("此 Provider 当前支持文本消息与停止，不支持命令或插话。");
      if (input.prompt.input.content.some(part => part.type !== "text")) throw new Error("此 Provider 当前只支持文本消息。请在 Desktop 中添加附件。");
      const text = input.prompt.input.content.map(part => part.type === "text" ? part.text : "").join("\n").trim();
      if (!text) throw new Error("消息不能为空");
      if (session.threadId) {
        const state = this.bridge.snapshot(session.threadId);
        if (state?.threadRuntimeStatus?.type === "active") throw new Error("Desktop 中已有活动轮次，请先停止后再发送。");
        for (const turn of turnsFromState(state ?? {})) session.ignoredTurns.add(turn.turnId);
      }
      const turnId = randomUUID();
      session.pending = { clientMessageId: input.prompt.clientMessageId, turnId }; session.sending = true; session.cancelRequested = false;
      this.emit({ type: "timeline.item", sessionId: session.id, item: { type: "user_message", id: `paseo:${input.prompt.clientMessageId}`, text, clientMessageId: input.prompt.clientMessageId } });
      this.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
      this.emit({ type: "session.turn", sessionId: session.id, turnId, state: "started" });
      if (!session.threadId) {
        const initial = session.config.systemPrompt ? `${session.config.systemPrompt}\n\n${text}` : text;
        session.threadId = await this.bridge.createSession(initial, session.config.title ?? "Paseo · ChatGPT Desktop", session.config.cwd, session.config.model === "desktop" ? undefined : session.config.model, session.config.thinkingOption);
        this.bridge.bindRoot(session.threadId, session.config.env);
        if (session.closed) { await this.bridge.follow(session.threadId); await this.bridge.interrupt(session.threadId).catch(() => {}); return; }
        this.emit({ type: "session.persistence", sessionId: session.id, persistence: persistence(session.threadId) });
        await this.bridge.follow(session.threadId);
        this.emitConfig(session, this.bridge.snapshot(session.threadId));
      } else await this.bridge.send(session.threadId, text);
      session.sending = false;
      const state = this.bridge.snapshot(session.threadId);
      this.bridge.evidence("provider_prompt_dispatched", { sessionId: session.id, threadId: session.threadId, turnId, clientMessageId: input.prompt.clientMessageId, pollingRequests: 0 });
      if (state) this.update(session, state);
      if (session.cancelRequested && session.pending) await this.bridge.interrupt(session.threadId);
      return;
    }
    if (input.type === "session.interrupt") {
      const session = this.requireSession(input.sessionId);
      session.cancelRequested = true;
      if (session.threadId && (session.pending || session.externalTurns.size) && !session.sending) await this.bridge.interrupt(session.threadId);
      this.emit({ type: "request.completed", requestId: input.requestId }); return;
    }
    if (input.type === "session.archive" || input.type === "session.unarchive") {
      const data = input.persistence.data as Json;
      if (input.persistence.version !== 1 || typeof data?.threadId !== "string") throw new Error("Invalid Desktop session persistence");
      if (input.type === "session.archive") await this.bridge.archives.archiveTree(data.threadId);
      else await this.bridge.archives.restoreTree(data.threadId);
      this.emit({ type: "request.completed", requestId: input.requestId }); return;
    }
    if (input.type === "session.configure") {
      const session = this.requireSession(input.sessionId);
      if (session.sending || session.pending || session.externalTurns.size) throw new Error("请等待当前轮次结束或停止后再切换模型。");
      if (input.changes.mode && input.changes.mode !== "desktop") throw new Error("权限模式由 Desktop 管理。");
      if (input.changes.settings && Object.keys(input.changes.settings).length) throw new Error("Unsupported Desktop setting");
      const state = session.threadId ? this.bridge.snapshot(session.threadId) : null;
      const model = input.changes.model ?? state?.latestModel ?? session.config.model ?? "desktop";
      const thinking = this.selectThinking(model, input.changes.thinkingOption ?? undefined, state?.latestReasoningEffort ?? session.config.thinkingOption);
      this.validateSelection(model, thinking);
      if (session.threadId) {
        if (model === "desktop") throw new Error("已有聊天请选择具体模型；沿用默认选项用于新建聊天。");
        const committed = await this.bridge.configureSession(session.threadId, model, thinking);
        session.config = { ...session.config, model: committed.model, thinkingOption: committed.reasoningEffort ?? undefined };
        this.emitConfig(session, { ...state, latestModel: committed.model, latestReasoningEffort: committed.reasoningEffort });
      } else {
        session.config = { ...session.config, model, thinkingOption: thinking };
        this.emitConfig(session, null);
      }
      this.emit({ type: "request.completed", requestId: input.requestId }); return;
    }
    if (input.type === "session.close") {
      const session = this.requireSession(input.sessionId); session.closed = true;
      const descendants = [...this.sessions.values()].filter(candidate => this.isDescendant(candidate, session.id));
      for (const child of descendants) {
        child.closed = true;
        if (child.threadId && (child.pending || child.externalTurns.size)) await this.bridge.interrupt(child.threadId).catch(() => {});
        this.emit({ type: "session.closed", sessionId: child.id }); this.sessions.delete(child.id);
      }
      if (session.threadId && (session.pending || session.externalTurns.size)) await this.bridge.interrupt(session.threadId).catch(() => {});
      if (session.pending) this.emit({ type: "session.turn", sessionId: session.id, turnId: session.pending.turnId, state: "canceled" });
      this.sessions.delete(session.id);
      this.emit({ type: "session.closed", sessionId: session.id });
      this.emit({ type: "request.completed", requestId: input.requestId }); return;
    }
    throw new Error(`Unsupported Desktop operation: ${input.type}`);
  }
  private requireSession(id: string) { const session = this.sessions.get(id); if (!session || session.closed) throw new Error("Desktop provider session not found"); return session; }
  private isDescendant(session: Session, ancestor: string) {
    const seen = new Set<string>();
    for (let parent = session.parentId; parent && !seen.has(parent); parent = this.sessions.get(parent)?.parentId) {
      if (parent === ancestor) return true;
      seen.add(parent);
    }
    return false;
  }
  private discoverChild(parent: Session, child: DesktopChild) {
    const id = childSessionId(child.threadId);
    if (this.sessions.has(id) || parent.closed || child.threadId === parent.threadId || !child.rolloutPath || this.bridge.isThreadArchived(child.threadId)) return;
    const session: Session = { id, parentId: parent.id, threadId: child.threadId, config: { ...parent.config, model: undefined, thinkingOption: undefined }, seen: new Map(), ignoredTurns: new Set(), externalTurns: new Set(), replaying: false, sending: true, closed: false, cancelRequested: false };
    this.sessions.set(id, session);
    this.bridge.bindChild(parent.threadId!, child.threadId, child.title);
    this.emit({ type: "session.opened", sessionId: id, parentSessionId: parent.id, toolCallId: child.toolCallId, restoration: "parent", capabilities: this.capabilities, title: child.title, description: child.description, cwd: parent.config.cwd });
    this.bridge.evidence("provider_child_discovered", { sessionId: id, parentSessionId: parent.id, parentThreadId: parent.threadId, threadId: child.threadId, toolCallId: child.toolCallId });
    void this.loadChild(session, child.rolloutPath).catch(error => {
      if (session.closed || this.closed) return;
      session.sending = false;
      this.emit({ type: "session.runtime_failed", sessionId: id, error: { message: `无法订阅 Desktop 子任务：${String(error)}` } });
      this.bridge.evidence("provider_child_subscription_failed", { threadId: child.threadId, error: String(error) });
    });
  }
  private async loadChild(session: Session, rolloutPath: string) {
    await this.bridge.followChild(session.threadId!, rolloutPath);
    if (session.closed || this.closed) return;
    const state = this.bridge.snapshot(session.threadId!);
    session.sending = false;
    this.emit({ type: "session.ready", sessionId: session.id });
    if (state) {
      const last = turnsFromState(state).at(-1);
      if (last?.turnId) {
        session.externalTurns.add(last.turnId);
        this.emit({ type: "session.turn", sessionId: session.id, turnId: `desktop:${last.turnId}`, state: "started" });
      }
      this.update(session, state);
    }
  }
  private validateSelection(model?: string, thinking?: string) {
    const selected = this.models.find(item => item.id === (model ?? "desktop"));
    if (!selected) throw new Error(`Desktop 不支持此模型：${model}`);
    if (thinking && selected.id !== "desktop" && !selected.thinkingOptions?.some(option => option.id === thinking)) throw new Error(`模型 ${model} 不支持推理强度 ${thinking}`);
  }
  private selectThinking(model: string, requested?: string, current?: string | null) {
    if (requested) return requested;
    const options = this.models.find(item => item.id === model)?.thinkingOptions ?? [];
    if (!options.length) return undefined;
    return options.find(option => option.id === current)?.id ?? options.find(option => option.id === "high")?.id ?? options[0].id;
  }
  private emitConfig(session: Session, state: Json) {
    const model = state?.latestModel ?? session.config.model ?? "desktop";
    const thinkingOption = state?.latestReasoningEffort ?? session.config.thinkingOption;
    const available = session.threadId ? this.models.filter(item => item.id !== "desktop") : this.models;
    const models: ProviderModel[] = available.some(item => item.id === model) ? available : [...available, { id: model, label: model }];
    const thinkingOptions = models.find(item => item.id === model)?.thinkingOptions ?? [];
    const fingerprint = JSON.stringify([model, thinkingOption, session.threadId]);
    if (session.configFingerprint === fingerprint) return;
    session.configFingerprint = fingerprint;
    this.emit({ type: "session.config", sessionId: session.id, config: { model, thinkingOption, mode: "desktop", models, modes, thinkingOptions, settings: [] } });
    this.emit({ type: "session.notice", sessionId: session.id, notice: { id: "desktop-session", severity: "info", title: state ? `Desktop · ${state.latestModel ?? "默认模型"}` : "首条消息将创建 Desktop 会话", description: state ? `会话 ${session.threadId}\n工作目录：${state.cwd ?? "Desktop 管理"}\n权限与 MCP 沿用 Desktop，可在 Desktop 中处理审批。` : "已保存的 Desktop 项目会使用其目录；其他目录会创建 Desktop 独立聊天。权限、环境变量与 MCP 由 Desktop 管理。" } });
  }
  private update(session: Session, state: Json) {
    this.emitConfig(session, state);
    const turns = turnsFromState(state);
    if(session.replaying)this.bridge.evidence("provider_image_history_replayed",{sessionId:session.id,threadId:session.threadId,imageCount:turns.reduce((count:number,turn:Json)=>count+(turn.items??[]).filter((item:Json)=>item.type==="imageView").length,0)});
    for (const turn of turns) {
      for (const native of turn.items ?? []) for (const child of childrenFromItem(native)) this.discoverChild(session, child);
      if (session.ignoredTurns.has(turn.turnId)) continue;
      const pending = session.pending;
      if (pending && !pending.nativeTurnId) pending.nativeTurnId = turn.turnId;
      if (!pending && !session.replaying && turn.status === "inProgress" && !session.externalTurns.has(turn.turnId)) {
        session.externalTurns.add(turn.turnId);
        this.emit({ type: "session.turn", sessionId: session.id, turnId: `desktop:${turn.turnId}`, state: "started" });
      }
      for (const native of turn.items ?? []) {
        const item = timelineFromItem(native); if (!item) continue;
        // The accepted Paseo prompt already owns the optimistic user row.
        if (item.type === "user_message" && pending?.nativeTurnId === turn.turnId) continue;
        const serialized = JSON.stringify(item);
        if (session.seen.get(item.id) === serialized) continue;
        session.seen.set(item.id, serialized);
        this.emit({ type: "timeline.item", sessionId: session.id, item });
      }
      if (pending && pending.nativeTurnId === turn.turnId && turn.status !== "inProgress" && turn.status != null) {
        const outcome = turn.status === "interrupted" || turn.status === "cancelled" || turn.status === "canceled" ? "canceled" : turn.error || turn.status === "failed" ? "failed" : "completed";
        this.emit({ type: "session.turn", sessionId: session.id, turnId: pending.turnId, state: outcome, ...(outcome === "failed" ? { error: { message: String(turn.error?.message ?? turn.error ?? "Desktop turn failed") } } : {}) });
        this.bridge.evidence("provider_turn_ended", { sessionId: session.id, threadId: session.threadId, turnId: pending.turnId, nativeTurnId: turn.turnId, outcome, pollingRequests: 0 });
        session.pending = undefined; session.ignoredTurns.add(turn.turnId);
      }
      if (session.externalTurns.has(turn.turnId) && turn.status !== "inProgress") {
        const outcome = ["interrupted", "canceled", "cancelled"].includes(turn.status) ? "canceled" : turn.error || turn.status === "failed" ? "failed" : "completed";
        this.emit({ type: "session.turn", sessionId: session.id, turnId: `desktop:${turn.turnId}`, state: outcome, ...(outcome === "failed" ? { error: { message: String(turn.error?.message ?? "Desktop turn failed") } } : {}) });
        session.externalTurns.delete(turn.turnId); session.ignoredTurns.add(turn.turnId);
      }
    }
  }
  async close() {
    if (this.closed) return;
    this.dispose();
    this.disposeArchives();
    await Promise.allSettled([...this.sessions.values()].map(async session => { session.closed = true; if (session.threadId && (session.pending || session.externalTurns.size)) await this.bridge.interrupt(session.threadId); }));
    this.closed = true; this.sessions.clear(); this.listeners.clear();
  }
}

export function createDesktopProvider(bridge: DesktopBridge) {
  const connections = new Set<DesktopProviderConnection>();
  const registration: ProviderRegistration = {
    id: "chatgpt-desktop", label: "ChatGPT Desktop", icon: "desktop.svg",
    description: "通过本机 Codex Desktop 的真实会话运行 agent；实时事件推送，无任务状态轮询。",
    async status() {
      try { toolsEndpoint(); return { available: true }; } catch (error) { return { available: false, diagnostic: String(error) }; }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Unsupported provider protocol version");
      const connection = new DesktopProviderConnection(bridge, negotiateProviderCapabilities(request.capabilities, supported));
      const close = connection.close.bind(connection);
      connection.close = async () => { await close(); connections.delete(connection); };
      connections.add(connection); return connection;
    },
  };
  return { registration, close: async () => { await Promise.allSettled([...connections].map(connection => connection.close())); connections.clear(); } };
}
