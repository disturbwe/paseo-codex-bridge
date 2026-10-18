import { useSyncExternalStore, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginAgentPanelProps, PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { useAgent } from "@getpaseo/plugin/client";
import { goalLabel, goalStateSchema, readGoal, pauseGoal, openGoal, type GoalState } from "../shared/goals";

export function contributeGoals(client: PluginClientContext) {
  const lifetime = new AbortController();
  const values = new Map<string, GoalState>();
  const listeners = new Set<() => void>();
  const registrations = new Map<string, { workspaceId: string; persistence: string; pill: PluginButtonRegistration; unsubscribe: () => void; disposed: boolean }>();
  const changed = () => { for (const listener of listeners) listener(); };
  const put = (id: string, value: GoalState) => {
    if (lifetime.signal.aborted || !registrations.has(id)) return;
    if ((values.get(id)?.revision ?? -1) > value.revision) return;
    values.set(id, value);
    registrations.get(id)?.pill.update({ label: goalLabel(value) });
    changed();
  };
  const load = async (id: string) => {
    const registration = registrations.get(id);
    const before = values.get(id);
    try {
      const value = await client.rpc(readGoal, { agentId: id });
      if (registrations.get(id) === registration) put(id, value);
    } catch (error) {
      if (registrations.get(id) !== registration) return;
      const previous = values.get(id);
      if (previous !== before && previous?.connected) return;
      put(id, { goal: previous?.goal ?? null, completedGoal: previous?.completedGoal ?? null,
        connected: false, canPause: false, error: String(error), revision: previous?.revision ?? 0 });
    }
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
    if (provider && provider !== "chatgpt-desktop") return <View style={{ padding: 24 }}><Text style={text}>请选择 ChatGPT Desktop 会话查看目标。</Text></View>;
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
      <Text style={{ ...text, fontSize: 20 }}>Desktop 目标</Text>
      <View style={{ padding: 16, gap: 12, borderRadius: 14, backgroundColor: theme.colors.surface1 }}>
        <Text style={{ ...text, fontWeight: "600" }}>{goalLabel(value)}</Text>
        <Text selectable style={{ ...text, lineHeight: 24 }}>{goal?.objective ?? (!value ? "正在读取 Desktop 目标…" : value.connected ? "这个会话尚未设置目标。" : "暂时无法确认目标，请重新同步。")}</Text>
        {!value?.goal && value?.completedGoal && <Text style={muted}>上次完成的目标</Text>}
        {goal?.updatedAt != null && <Text style={muted}>最近更新：{new Date(goal.updatedAt * 1000).toLocaleString()}</Text>}
      </View>
      <Text style={muted}>{value?.connected ? "已连接 · Desktop 状态通过事件实时同步" : "当前状态尚未同步；保留的目标信息可能已过时。"}</Text>
      {(error || value?.error) && <Text selectable style={text}>{error ?? value?.error}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("暂停目标并停止执行", async () => put(agentId, await client.rpc(pauseGoal, { agentId })), !value?.canPause)}
        {button("在 Desktop 中管理", () => client.rpc(openGoal, { agentId }))}
        {button("重新同步", () => load(agentId))}
      </View>
      <Text style={muted}>暂停使用 Desktop 的停止操作，会停止当前执行并清理后台终端。设置、恢复和清除请在 Desktop 中操作，变更会自动同步到这里。</Text>
    </ScrollView>;
  }
  client.addWorkspacePanel({ id: "desktop-goal", title: "Desktop 目标", icon: "Goal", context: "agent", Component: GoalPanel });
  client.addTimelineRenderer({ kind: "desktop-goal-state", version: 1, schema: goalStateSchema, Component: () => null });
  client.addCommandCenterItem({ id: "desktop-goal", title: "查看 Desktop 目标", icon: "Goal", context: "agent", onSelect: ({ openPanel }) => openPanel("desktop-goal") });
  client.addSlashCommand({ name: "desktop-goal", description: "查看 Desktop 目标状态", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("desktop-goal") });
  const remove = (id: string) => {
    const registration = registrations.get(id);
    if (!registration) return;
    registration.disposed = true; registration.unsubscribe(); registration.pill.remove(); registrations.delete(id); values.delete(id); changed();
  };
  const register = (agent: { id: string; workspaceId?: string | null; provider: string; archivedAt?: string | null; persistence?: unknown }) => {
    if (lifetime.signal.aborted) return;
    if (agent.provider !== "chatgpt-desktop" || !agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    const persistence = JSON.stringify(agent.persistence ?? null);
    if (registrations.get(agent.id)?.workspaceId === agent.workspaceId && registrations.get(agent.id)?.persistence === persistence) return;
    remove(agent.id);
    const agentId = agent.id, workspaceId = agent.workspaceId;
    const pill = client.addComposerPill({ id: "desktop-goal", workspaceId, agentId, button: { title: "查看 Desktop 目标", icon: "Goal", label: "目标 · 读取中", behavior: { kind: "action", onPress: () => client.openPanel("desktop-goal", { workspaceId, agentId }) } } });
    const registration = { workspaceId, persistence, pill, unsubscribe: () => {}, disposed: false };
    registrations.set(agentId, registration);
    const unsubscribe = client.paseo.agents.ref(agentId).timeline.subscribe(({ event }) => {
      if (registration.disposed) return;
      if (event.type === "timeline" && event.item.type === "plugin" && event.item.pluginId === "paseo-codex-desktop" && event.item.kind === "desktop-goal-state") {
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
