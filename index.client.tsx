import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ArchivePanel } from "./client/archive";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: "desktop-archive", title: "Desktop 子会话归档", icon: "Archive", context: "agent", Component: ArchivePanel });
  client.addCommandCenterItem({ id: "desktop-archive", title: "归档 Desktop 子 agent 会话", icon: "Archive", context: "agent", onSelect: ({ openPanel }) => openPanel("desktop-archive") });
  client.addSlashCommand({ name: "desktop-archive", description: "查看并归档当前 Desktop agent 的子会话", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("desktop-archive") });
  return () => {};
}
