import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ImageViewRow } from "./client/images";
import { imageViewData } from "./shared/images";
import { ArchivePanel } from "./client/archive";
import { contributeGoals } from "./client/goals";

export default function contribute(client: PluginClientContext) {
  const closeGoals = contributeGoals(client);
  client.addTimelineTransformer({id:"desktop-image-view",query:{itemType:"tool_call"},transform:({item})=>{
    if(item.metadata?.desktopImageView!==true)return;
    return {items:[{type:"plugin",kind:"desktop-image-view",version:1,data:{callId:item.callId,filePath:typeof item.metadata.filePath==="string"?item.metadata.filePath:"",status:item.status}}]};
  }});
  client.addTimelineRenderer({kind:"desktop-image-view",version:1,schema:imageViewData,Component:ImageViewRow});
  client.addWorkspacePanel({ id: "desktop-archive", title: "Desktop 子会话归档", icon: "Archive", context: "agent", Component: ArchivePanel });
  client.addCommandCenterItem({ id: "desktop-archive", title: "归档 Desktop 子 agent 会话", icon: "Archive", context: "agent", onSelect: ({ openPanel }) => openPanel("desktop-archive") });
  client.addSlashCommand({ name: "desktop-archive", description: "查看并归档当前 Desktop agent 的子会话", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("desktop-archive") });
  return closeGoals;
}
