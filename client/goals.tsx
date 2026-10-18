import { useSyncExternalStore, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginAgentPanelProps, PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { useAgent } from "@getpaseo/plugin/client";
import { goalLabel, goalSummary, goalDuration, goalStateSchema, readGoal, pauseGoal, openGoal, type GoalState } from "../shared/goals";
import { readNativeGoal, nativeGoalAction } from "../shared/native-goals";

export function contributeGoals(client: PluginClientContext) {
  const lifetime = new AbortController();
  const values = new Map<string, GoalState>();
  const listeners = new Set<() => void>();
  const registrations = new Map<string, { workspaceId: string; provider: string; persistence: string; pill: PluginButtonRegistration; duration: PluginButtonRegistration; toggle: PluginButtonRegistration; clear: PluginButtonRegistration; unsubscribe: () => void; disposed: boolean }>();
  const changed = () => { for (const listener of listeners) listener(); };
  const put = (id: string, value: GoalState) => {
    if (lifetime.signal.aborted || !registrations.has(id)) return;
    if ((values.get(id)?.revision ?? -1) > value.revision) return;
    values.set(id, value);
    const registration = registrations.get(id)!;
    const goal = value.goal ?? value.completedGoal;
    registration.pill.update({ label: goalSummary(value), title: goal ? `${goalLabel(value)} · 点击查看完整目标` : "查看会话目标", visible: registration.provider !== "codex" || !!goal });
    registration.duration.update({ label: goalDuration(goal?.timeUsedSeconds ?? 0), visible: !!goal && goal.timeUsedSeconds !== undefined });
    registration.toggle.update({ title: goal?.status === "active" ? "暂停目标" : "继续目标", label: goal?.status === "active" ? "暂停" : "继续", icon: goal?.status === "active" ? "Pause" : "Play", visible: registration.provider === "codex" && !!value.goal && goal?.status !== "complete", disabled: !value.connected });
    registration.clear.update({ visible: registration.provider === "codex" && !!value.goal, disabled: !value.connected });
    changed();
  };
  const load = async (id: string) => {
    const registration = registrations.get(id);
    const before = values.get(id);
    try {
      const value = await client.rpc(registration?.provider === "codex" ? readNativeGoal : readGoal, { agentId: id });
      if (registrations.get(id) === registration) put(id, value);
    } catch (error) {
      if (registrations.get(id) !== registration) return;
      const previous = values.get(id);
      if (previous !== before && previous?.connected) return;
      put(id, { goal: previous?.goal ?? null, completedGoal: previous?.completedGoal ?? null,
        connected: false, canPause: false, error: String(error), revision: previous?.revision ?? 0 });
    }
  };
  const control = async (agentId: string, action: "pause" | "resume" | "clear") => {
    const value = await client.rpc(nativeGoalAction, { agentId, action }); put(agentId, value);
  };
  function GoalPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
    const provider = useAgent(agentId, agent => agent.provider);
    const value = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => values.get(agentId) ?? null);
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
    const goal = value?.goal ?? value?.completedGoal;
    const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
    const action = async (fn: () => Promise<unknown>) => {
      setBusy(true); setError(null);
      try { await fn(); } catch (error) { setError(String(error)); } finally { setBusy(false); }
    };
    const button = (label: string, fn: () => Promise<unknown>, disabled = false) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={busy || disabled} onPress={() => void action(fn)} style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.colors.surface1, opacity: busy || disabled ? 0.5 : 1 }}><Text style={text}>{label}</Text></Pressable>;
    const native = provider === "codex";
    if (provider && provider !== "chatgpt-desktop" && !native) return <View style={{ padding: 24 }}><Text style={text}>请选择 Codex 或 ChatGPT Desktop 会话查看目标。</Text></View>;
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
      <Text style={{ ...text, fontSize: 20 }}>会话目标</Text>
      <View style={{ padding: 16, gap: 12, borderRadius: 14, backgroundColor: theme.colors.surface1 }}>
        <Text style={{ ...text, fontWeight: "600" }}>{goalLabel(value)}</Text>
        <Text selectable style={{ ...text, lineHeight: 24 }}>{goal?.objective ?? (!value ? "正在读取目标…" : value.connected ? "这个会话尚未设置目标。" : "暂时无法确认目标，请重新同步。")}</Text>
        {!value?.goal && value?.completedGoal && <Text style={muted}>上次完成的目标</Text>}
        {goal?.updatedAt != null && <Text style={muted}>最近更新：{new Date(goal.updatedAt * 1000).toLocaleString()}</Text>}
        {goal?.timeUsedSeconds !== undefined && <Text style={muted}>累计执行：{goalDuration(goal.timeUsedSeconds)}</Text>}
        {goal?.tokensUsed !== undefined && <Text style={muted}>Token 用量：{goal.tokensUsed.toLocaleString()}{goal.tokenBudget != null ? ` / ${goal.tokenBudget.toLocaleString()}` : ""}</Text>}
      </View>
      <Text style={muted}>{value?.connected ? `已连接 · ${native ? "Codex" : "Desktop"} 目标通过事件实时同步` : "当前状态尚未同步；保留的目标信息可能已过时。"}</Text>
      {(error || value?.error) && <Text selectable style={text}>{error ?? value?.error}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {native ? <>
          {button(goal?.status === "active" ? "暂停目标" : "继续目标", () => control(agentId, goal?.status === "active" ? "pause" : "resume"), !value?.connected || !value.goal)}
          {button("清除目标", () => control(agentId, "clear"), !value?.connected || !value.goal)}
        </> : <>
          {button("暂停目标并停止执行", async () => put(agentId, await client.rpc(pauseGoal, { agentId })), !value?.canPause)}
          {button("在 Desktop 中管理", () => client.rpc(openGoal, { agentId }))}
        </>}
        {button("重新同步", () => load(agentId))}
      </View>
      <Text style={muted}>{native ? "目标栏随原生 /goal 更新；暂停、继续、清除调用 Paseo 已有命令。时长为 Codex 记录的累计执行时间。" : "暂停使用 Desktop 的停止操作，会停止当前执行并清理后台终端。设置、恢复和清除请在 Desktop 中操作，变更会自动同步到这里。"}</Text>
    </ScrollView>;
  }
  client.addWorkspacePanel({ id: "desktop-goal", title: "会话目标", icon: "Goal", context: "agent", Component: GoalPanel });
  client.addTimelineRenderer({ kind: "desktop-goal-state", version: 1, schema: goalStateSchema, Component: () => null });
  client.addTimelineRenderer({ kind: "codex-goal-state", version: 1, schema: goalStateSchema, Component: () => null });
  client.addCommandCenterItem({ id: "desktop-goal", title: "查看会话目标", icon: "Goal", context: "agent", onSelect: ({ openPanel }) => openPanel("desktop-goal") });
  client.addSlashCommand({ name: "codex-goal", description: "查看原生 Codex 目标", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("desktop-goal") });
  client.addSlashCommand({ name: "desktop-goal", description: "查看 Desktop 目标状态", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("desktop-goal") });
  const remove = (id: string) => {
    const registration = registrations.get(id);
    if (!registration) return;
    registration.disposed = true; registration.unsubscribe(); registration.pill.remove(); registration.duration.remove(); registration.toggle.remove(); registration.clear.remove(); registrations.delete(id); values.delete(id); changed();
  };
  const register = (agent: { id: string; workspaceId?: string | null; provider: string; archivedAt?: string | null; persistence?: unknown }) => {
    if (lifetime.signal.aborted) return;
    if (!["chatgpt-desktop", "codex"].includes(agent.provider) || !agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    const persistence = JSON.stringify(agent.persistence ?? null);
    if (registrations.get(agent.id)?.workspaceId === agent.workspaceId && registrations.get(agent.id)?.provider === agent.provider && registrations.get(agent.id)?.persistence === persistence) return;
    remove(agent.id);
    const agentId = agent.id, workspaceId = agent.workspaceId;
    const open = () => client.openPanel("desktop-goal", { workspaceId, agentId });
    const pill = client.addComposerPill({ id: "desktop-goal", workspaceId, agentId, button: { title: "查看会话目标", icon: "Goal", label: "目标 · 读取中", visible: agent.provider !== "codex", behavior: { kind: "action", onPress: open } } });
    const duration = client.addComposerPill({ id: "goal-duration", workspaceId, agentId, button: { title: "累计执行时间", icon: "Clock", label: "0s", visible: false, behavior: { kind: "action", onPress: open } } });
    const toggle = client.addComposerPill({ id: "goal-toggle", workspaceId, agentId, button: { title: "暂停或继续目标", icon: "Pause", label: "暂停", visible: false, behavior: { kind: "action", onPress: () => control(agentId, values.get(agentId)?.goal?.status === "active" ? "pause" : "resume") } } });
    const clear = client.addComposerPill({ id: "goal-clear", workspaceId, agentId, button: { title: "清除目标", icon: "Trash2", label: "清除", visible: false, behavior: { kind: "action", onPress: () => control(agentId, "clear") } } });
    const registration = { workspaceId, provider: agent.provider, persistence, pill, duration, toggle, clear, unsubscribe: () => {}, disposed: false };
    registrations.set(agentId, registration);
    const unsubscribe = client.paseo.agents.ref(agentId).timeline.subscribe(({ event }) => {
      if (registration.disposed) return;
      if (event.type === "timeline" && event.item.type === "plugin" && event.item.pluginId === "paseo-codex-desktop" && event.item.kind === (agent.provider === "codex" ? "codex-goal-state" : "desktop-goal-state")) {
        const value = goalStateSchema.safeParse(event.item.data);
        if (value.success) put(agentId, value.data);
      } else if (event.type === "replacement" || event.type === "subscription_restored") {
        // Revision belongs to this bridge process, so discard it on reconnection.
        values.delete(agentId); changed(); void load(agentId);
      } else if (event.type === "error") {
        const value = values.get(agentId);
        if (value) put(agentId, { ...value, connected: false, canPause: false, error: event.error });
      }
    });
    registration.unsubscribe = unsubscribe;
    void unsubscribe.ready.then(() => { if (!registration.disposed) return load(agentId); }).catch(error => {
      if (!registration.disposed) put(agentId, { goal: null, completedGoal: null, connected: false, canPause: false, error: String(error), revision: 0 });
    });
  };
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    subscription.subscribe({ snapshot: ({ entries }) => {
      const ids = new Set(entries.map(({ agent }) => agent.id));
      for (const id of registrations.keys()) if (!ids.has(id)) remove(id);
      for (const { agent } of entries) register(agent);
    }, update: message => {
      if (message.type !== "agent_update") return;
      if (message.payload.kind === "upsert") register(message.payload.agent); else remove(message.payload.agentId);
    } });
  }).catch(error => { if (!lifetime.signal.aborted) console.error("Desktop goal directory failed", error); });
  return () => { lifetime.abort(); for (const id of [...registrations.keys()]) remove(id); listeners.clear(); };
}
