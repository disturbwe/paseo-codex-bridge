import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readNativeGoal, nativeGoalAction } from "../shared/native-goals";
import type { GoalState } from "../shared/goals";
import { NativeGoalStore } from "./native-goal-store";

type Binding = { agentId: string; threadId: string; paseo: PaseoApi; value?: GoalState; fingerprint?: string; queue: Promise<void> };
export function registerNativeGoals(server: PluginServerContext, store = new NativeGoalStore(process.env.PASEO_CODEX_BRIDGE_NATIVE_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"))) {
  const bindings = new Map<string, Binding>();
  const listeners = new Set<(agentId: string, value: GoalState) => void>();
  let revision = 0, disposed = false, unsubscribe: (() => void) | undefined;
  const publish = (binding: Binding, value: GoalState) => {
    if (disposed || bindings.get(binding.agentId) !== binding) return;
    binding.value = value;
    for (const listener of listeners) listener(binding.agentId, value);
    const fingerprint = JSON.stringify({ ...value, revision: 0 });
    if (binding.fingerprint === fingerprint) return;
    binding.fingerprint = fingerprint;
    binding.queue = binding.queue.then(async () => {
      if (disposed || bindings.get(binding.agentId) !== binding) return;
      await binding.paseo.agents.ref(binding.agentId).timeline.append({ type: "plugin", id: "codex-goal-state", kind: "codex-goal-state", version: 1, data: value });
    }).catch(error => { binding.fingerprint = undefined; console.error("Native goal publication failed", binding.agentId, String(error)); });
  };
  const refresh = async (binding: Binding) => {
    try {
      const goal = await store.read(binding.threadId);
      const value: GoalState = { goal, completedGoal: null, connected: true, canPause: goal?.status === "active", error: null, revision: ++revision };
      publish(binding, value); return value;
    } catch (error) {
      const value: GoalState = { goal: binding.value?.goal ?? null, completedGoal: binding.value?.completedGoal ?? null, connected: false, canPause: false, error: String(error), revision: ++revision };
      publish(binding, value); return value;
    }
  };
  const bind = async (agentId: string, paseo: PaseoApi) => {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    const agent = snapshot?.agent;
    if (!agent || agent.provider !== "codex" || agent.archivedAt) throw new Error("请选择未归档的原生 Codex 会话。");
    const persistence = agent.persistence;
    const threadId = persistence?.metadata?.threadId ?? persistence?.nativeHandle ?? persistence?.sessionId;
    if (typeof threadId !== "string" || !/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("此 Codex 会话尚未提供 threadId，请先发送一条消息或 /goal。");
    let binding = bindings.get(agentId);
    if (binding?.threadId !== threadId) { binding = { agentId, threadId, paseo, queue: Promise.resolve() }; bindings.set(agentId, binding); }
    if (!unsubscribe) unsubscribe = store.subscribe(() => { for (const binding of bindings.values()) void refresh(binding); }, error => {
      unsubscribe?.(); unsubscribe = undefined;
      for (const binding of bindings.values()) publish(binding, { goal: binding.value?.goal ?? null, completedGoal: null, connected: false, canPause: false, error: error.message, revision: ++revision });
    });
    return binding!;
  };
  server.handle(readNativeGoal, async ({ agentId }, { paseo }) => refresh(await bind(agentId, paseo)));
  server.handle(nativeGoalAction, async ({ agentId, action }, { paseo }) => {
    const binding = await bind(agentId, paseo), before = await refresh(binding);
    if (!before.connected) throw new Error(before.error ?? "目标状态未同步。");
    if (!before.goal) throw new Error("当前会话没有目标。");
    if (action === "pause" && before.goal.status === "paused" || action === "resume" && before.goal.status === "active") return before;
    // The native /goal command is out-of-band: it neither interrupts the active
    // foreground task nor enters the ordinary prompt queue.
    const expected = action === "pause" ? "paused" : "active";
    let done = () => {}, fail = (_error: Error) => {}, timer: ReturnType<typeof setTimeout>;
    const confirmed = new Promise<GoalState>((resolve, reject) => { done = () => {}; fail = reject;
      timer = setTimeout(() => reject(new Error("Codex 尚未确认目标操作，请检查目标状态。")), 15000);
      const listener = (id: string, value: GoalState) => {
        if (id === agentId && value.connected && (action === "clear" ? value.goal === null : value.goal?.status === expected)) resolve(value);
      };
      listeners.add(listener); done = () => { listeners.delete(listener); clearTimeout(timer); };
    }); void confirmed.catch(() => {});
    const subscription = paseo.agents.ref(agentId).timeline.subscribe(({ event }) => {
      if (event.type !== "timeline" || event.item.type !== "assistant_message") return;
      const text = event.item.text.trim();
      if (/^(?:Failed to update goal:|\[Error\])/.test(text)) fail(new Error(text));
      // The acknowledgement is also a completion event. Read once here because
      // mmap/WAL writes do not always notify fs.watch on every platform.
      if (text === ({ pause: "Goal paused.", resume: "Goal resumed.", clear: "Goal cleared." }[action])) void refresh(binding);
    });
    try { await subscription.ready; await paseo.agents.ref(agentId).send(`/goal ${action}`); return await confirmed; }
    finally { done(); subscription(); }
  });
  server.on("agent.archived", ({ agent }) => { if (agent.provider === "codex") bindings.delete(agent.id); });
  return () => { disposed = true; unsubscribe?.(); store.close(); bindings.clear(); listeners.clear(); };
}
