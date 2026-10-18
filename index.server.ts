import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DesktopBridge } from "./server/bridge";
import { createDesktopProvider } from "./server/provider";
import { bindAgent, registerArchiveHooks } from "./server/archive-hooks";
import { imagePreview } from "./shared/images";
import { bootstrap, listSessions, followSession, sendMessage, interruptSession, openSession, watchCompletion } from "./shared/desktop";

export default function contribute(server: PluginServerContext) {
  const bridge = new DesktopBridge();
  const provider = createDesktopProvider(bridge);
  server.registerProvider(provider.registration);
  registerArchiveHooks(server, bridge);
  server.handle(imagePreview,async({agentId,callId},{paseo})=>{
    const id=await bindAgent(bridge,paseo,agentId);
    if(!id)throw new Error("当前 agent 不是 Desktop 会话");
    return bridge.imagePreview(id,callId);
  });
  server.handle(bootstrap, () => bridge.bootstrap());
  server.handle(listSessions, () => bridge.listSessions());
  server.handle(followSession, ({ threadId }) => bridge.follow(threadId));
  server.handle(sendMessage, ({ threadId, prompt }) => bridge.send(threadId, prompt));
  server.handle(interruptSession, ({ threadId }) => bridge.interrupt(threadId));
  server.handle(openSession, ({ threadId }) => bridge.open(threadId));
  server.handle(watchCompletion, input => bridge.watchCompletion(input));
  server.on("agent.turn_ended", (event) => bridge.onAgentEnded(event));
  return async () => { await provider.close(); await bridge.close(); };
}
