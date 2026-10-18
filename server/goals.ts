import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { bindAgent } from "./archive-hooks";
import type { DesktopBridge } from "./bridge";
import { goalFromState, readGoal, pauseGoal, openGoal, type GoalState } from "../shared/goals";

// A single stable, hidden timeline row carries goal updates over Paseo's authenticated
// event stream. No loopback URLs, timers, or client-side status polling.
export function registerGoalHooks(server: PluginServerContext, bridge: DesktopBridge) {
  const bindings = new Map<string, { threadId: string; paseo: PaseoApi; fingerprint?: string; last?: GoalState; queue: Promise<void> }>();
  const pending = new Map<string, PaseoApi>();
  let disposed = false;
  const current = (id: string) => goalFromState(bridge.snapshot(id), bridge.state.revision, bridge.state.connected, bridge.state.error);
  const publish = (agentId: string, value: GoalState) => {
    const binding = bindings.get(agentId);
    if (!binding || disposed) return;
    const fingerprint = JSON.stringify({ ...value, revision: 0 });
    if (binding.fingerprint === fingerprint) return;
    binding.fingerprint = fingerprint;
    binding.last = value;
    binding.queue = binding.queue.then(async () => {
      if (disposed || bindings.get(agentId) !== binding) return;
      await binding.paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: "desktop-goal-state", kind: "desktop-goal-state", version: 1, data: value });
    }).catch(error => {
      binding.fingerprint = undefined;
      bridge.evidence("goal_publish_failed", { agentId, error: String(error) });
    });
  };
  const bind = async (agentId: string, paseo: PaseoApi) => {
    const id = await bindAgent(bridge, paseo, agentId);
    if (!id) throw new Error("请在已有 Desktop 聊天中查看目标。");
    if (bridge.isThreadArchived(id)) throw new Error("该 Desktop 会话已归档。");
    if (bindings.get(agentId)?.threadId !== id) bindings.set(agentId, { threadId: id, paseo, queue: Promise.resolve() });
    try { await bridge.follow(id); }
    catch (error) {
      const value = goalFromState(bridge.snapshot(id), bridge.state.revision, false, String(error));
      publish(agentId, value);
      return { id, value };
    }
    const value = current(id); publish(agentId, value); return { id, value };
  };
  const remove = bridge.subscribe((id) => {
    for (const [agentId, paseo] of pending) if (bridge.archives.agent(agentId)?.threadId === id) {
      if (bindings.get(agentId)?.threadId !== id) bindings.set(agentId, { threadId: id, paseo, queue: Promise.resolve() });
      pending.delete(agentId);
    }
    for (const [agentId, binding] of bindings) if (binding.threadId === id) publish(agentId, current(id));
  }, error => {
    for (const [agentId, binding] of bindings) publish(agentId, { ...(binding.last ?? current(binding.threadId)), connected: false, canPause: false, error: error.message, revision: bridge.state.revision });
  });
  const removeArchived = bridge.subscribeArchived(id => {
    for (const [agentId, binding] of bindings) if (binding.threadId === id) bindings.delete(agentId);
    for (const agentId of pending.keys()) if (bridge.archives.agent(agentId)?.threadId === id) pending.delete(agentId);
  });
  server.before("agent.session_open", ({ request }, { paseo }) => {
    if (request.provider === "chatgpt-desktop") pending.set(request.agentId, paseo);
  });
  server.handle(readGoal, async ({ agentId }, { paseo }) => (await bind(agentId, paseo)).value);
  server.handle(pauseGoal, async ({ agentId }, { paseo }) => {
    const { id, value } = await bind(agentId, paseo);
    if (!value.canPause) throw new Error(value.error ?? "当前没有可暂停的活动目标。");
    await bridge.pauseGoal(id);
    const result = current(id); publish(agentId, result); return result;
  });
  server.handle(openGoal, async ({ agentId }, { paseo }) => {
    const id = await bindAgent(bridge, paseo, agentId);
    if (!id) throw new Error("当前 agent 不是 Desktop 会话。");
    return bridge.open(id);
  });
  return () => { disposed = true; remove(); removeArchived(); bindings.clear(); pending.clear(); };
}
