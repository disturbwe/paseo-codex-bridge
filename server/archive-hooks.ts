import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginServerContext } from "@getpaseo/plugin/server";
import type { DesktopBridge } from "./bridge";
import { cleanupEmptyDesktopWorkspace } from "./workspace-cleanup";
import { archiveChildren, archiveChild, archiveEmptyWorkspace } from "../shared/archive";

export async function bindAgent(bridge: DesktopBridge, paseo: PaseoApi, agentId: string) {
  const snapshot = await paseo.agents.ref(agentId).refresh();
  if (!snapshot || snapshot.agent.provider !== "chatgpt-desktop") return;
  const stored = snapshot.agent.persistence?.metadata?.pluginProviderPersistence as { version?: number; data?: { threadId?: string } } | undefined;
  const threadId = stored?.version === 1 ? stored.data?.threadId : undefined;
  if (threadId) bridge.archives.registerAgent(agentId, snapshot.agent.workspaceId ?? null, threadId);
  return threadId;
}

export function registerArchiveHooks(server: PluginServerContext, bridge: DesktopBridge) {
  server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "chatgpt-desktop") return;
    return { ...request, env: { ...request.env, PASEO_DESKBRIDGE_AGENT_ID: request.agentId, PASEO_DESKBRIDGE_WORKSPACE_ID: request.workspaceId ?? "" } };
  });
  const remember = async (agent: PluginHookAgent, paseo: PaseoApi) => {
    if (agent.provider !== "chatgpt-desktop") return;
    await bindAgent(bridge, paseo, agent.id);
  };
  server.on("agent.created", ({ agent }, { paseo }) => remember(agent, paseo));
  server.on("agent.turn_ended", ({ agent }, { paseo }) => remember(agent, paseo));
  server.on("agent.archived", async ({ agent }, { paseo }) => {
    if (agent.provider !== "chatgpt-desktop") return;
    const id = await bindAgent(bridge, paseo, agent.id) ?? bridge.archives.agent(agent.id)?.threadId;
    if (id) await bridge.archives.archiveTree(id);
    if (agent.workspaceId) await cleanupEmptyDesktopWorkspace(paseo,bridge,agent.workspaceId);
  });
  server.on("workspace.archived", ({ workspace }) => bridge.archives.archiveWorkspace(workspace.id).then(() => {}));
  server.handle(archiveChildren, async ({ agentId }, { paseo }) => {
    const id = await bindAgent(bridge, paseo, agentId);
    if (!id) throw new Error("请在已有 Desktop 聊天的 agent 中使用此操作。");
    const children = await bridge.archives.listChildren(agentId);
    return { children: children.map(node => ({ threadId: node.threadId, title: node.title ?? node.threadId, archived: node.archived ?? false, pending: !!node.pending, error: node.error ?? null })) };
  });
  server.handle(archiveChild, async ({ agentId, threadId }, { paseo }) => {
    const id = await bindAgent(bridge, paseo, agentId);
    if (!id) throw new Error("当前 agent 不是 Desktop 会话。");
    return { archivedThreadIds: await bridge.archives.archiveChild(agentId, threadId) };
  });
  server.handle(archiveEmptyWorkspace, async ({ workspaceId }, { paseo }) => ({ archived: await cleanupEmptyDesktopWorkspace(paseo,bridge,workspaceId) }));
  void bridge.archives.resumePending().catch(error => bridge.evidence("archive_recovery_pending", { error: String(error) }));
}
