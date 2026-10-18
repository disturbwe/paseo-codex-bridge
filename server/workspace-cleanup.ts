import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { DesktopBridge } from "./bridge";

async function workspaceAgents(paseo: PaseoApi, workspaceId: string): Promise<PaseoAgent[]> {
  const result: PaseoAgent[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page=0;page<200;page++) {
    const batch=await paseo.agents.list({filter:{includeArchived:true},page:{limit:200,...(cursor?{cursor}:{})}});
    result.push(...batch.entries.map(entry=>entry.agent).filter(agent=>agent.workspaceId===workspaceId));
    const next=batch.pageInfo.nextCursor;
    if(!next) {if(batch.pageInfo.hasMore)throw new Error("Incomplete agent page");return result;}
    if(seen.has(next))throw new Error("Repeated agent cursor");
    seen.add(next);cursor=next;
  }
  throw new Error("Agent history exceeds workspace cleanup limit");
}

// Archive only a local, unpinned workspace wholly owned by archived Desktop
// agents. A stopped/closed agent without archivedAt still counts as active.
export async function cleanupEmptyDesktopWorkspace(paseo: PaseoApi, bridge: DesktopBridge, workspaceId: string) {
  const handle=paseo.workspaces.ref(workspaceId), workspace=await handle.refresh();
  if(!workspace||workspace.archivingAt||workspace.pinnedAt||workspace.workspaceKind==="worktree"||workspace.project?.checkout?.isPaseoOwnedWorktree)return false;
  const agents=await workspaceAgents(paseo,workspaceId);
  if(!agents.length||agents.some(agent=>agent.provider!=="chatgpt-desktop"||!agent.archivedAt))return false;
  if((await handle.terminals.list()).entries.length)return false;
  for(const agent of agents){
    const stored=agent.persistence?.metadata?.pluginProviderPersistence as {version?:number;data?:{threadId?:string}}|undefined;
    const id=stored?.version===1?stored.data?.threadId:bridge.archives.agent(agent.id)?.threadId;
    if(id){bridge.archives.registerAgent(agent.id,workspaceId,id);await bridge.archives.archiveTree(id);}
  }
  // Recheck after native synchronization, which may have waited on Desktop.
  if((await workspaceAgents(paseo,workspaceId)).some(agent=>agent.provider!=="chatgpt-desktop"||!agent.archivedAt))return false;
  if((await handle.terminals.list()).entries.length)return false;
  const current=await handle.refresh();
  if(!current||current.archivingAt||current.pinnedAt)return false;
  const outcome=await handle.archive();
  if(outcome.error||!outcome.archivedAt)throw new Error(outcome.error??"Workspace was not archived");
  bridge.evidence("desktop_empty_workspace_archived",{workspaceId,agentIds:agents.map(agent=>agent.id)});
  return true;
}
