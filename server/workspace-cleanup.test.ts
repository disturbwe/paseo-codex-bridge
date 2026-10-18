import test from "node:test";
import assert from "node:assert/strict";
import type { PaseoApi } from "@getpaseo/client";
import type { DesktopBridge } from "./bridge";
import { cleanupEmptyDesktopWorkspace } from "./workspace-cleanup";

function fixture() {
  const agents:any[]=[{id:"archived-desktop",workspaceId:"wks_target",provider:"chatgpt-desktop",archivedAt:"2026-10-18",persistence:{metadata:{pluginProviderPersistence:{version:1,data:{threadId:"native-root"}}}}}];
  const workspace:any={id:"wks_target",workspaceKind:"directory",pinnedAt:null,archivingAt:null};
  const terminals:any[]=[], archives:string[]=[], native:string[]=[];
  let truncated=false;
  const api={agents:{list:async({page}:any)=>({entries:(truncated&&!page.cursor?[]:agents).map(agent=>({agent})),pageInfo:{nextCursor:truncated&&!page.cursor?"older":null,hasMore:truncated&&!page.cursor}})},workspaces:{ref:()=>({refresh:async()=>workspace,terminals:{list:async()=>({entries:terminals})},archive:async()=>{archives.push("wks_target");return {archivedAt:"now",error:null};}})}} as unknown as PaseoApi;
  const bridge={archives:{agent:()=>undefined,registerAgent:()=>{},archiveTree:async(id:string)=>native.push(id)},evidence:()=>{}} as unknown as DesktopBridge;
  return {agents,workspace,terminals,archives,native,api,bridge,paginate:()=>{truncated=true;}};
}

test("Archived Desktop-only workspace leaves the sidebar after native archival, including older pages",async()=>{
  const f=fixture();f.paginate();
  f.agents.push({id:"unrelated",workspaceId:"wks_other",provider:"codex",archivedAt:null});
  assert.equal(await cleanupEmptyDesktopWorkspace(f.api,f.bridge,"wks_target"),true);
  assert.deepEqual(f.native,["native-root"]);assert.deepEqual(f.archives,["wks_target"]);
});

test("Closed agents, other providers, terminals, pinned and managed workspaces prevent automatic cleanup",async()=>{
  const variants=[(f:ReturnType<typeof fixture>)=>{f.agents[0].archivedAt=null;},(f:ReturnType<typeof fixture>)=>{f.agents.push({workspaceId:"wks_target",provider:"codex",archivedAt:"now"});},(f:ReturnType<typeof fixture>)=>{f.terminals.push({id:"terminal"});},(f:ReturnType<typeof fixture>)=>{f.workspace.pinnedAt="now";},(f:ReturnType<typeof fixture>)=>{f.workspace.workspaceKind="worktree";},(f:ReturnType<typeof fixture>)=>{f.workspace.archivingAt="now";}];
  for(const mutate of variants){const f=fixture();mutate(f);assert.equal(await cleanupEmptyDesktopWorkspace(f.api,f.bridge,"wks_target"),false);assert.deepEqual(f.archives,[]);}
});

test("Native sync failure keeps the workspace visible for recovery",async()=>{
  const f=fixture();f.bridge.archives.archiveTree=async()=>{throw new Error("offline");};
  await assert.rejects(cleanupEmptyDesktopWorkspace(f.api,f.bridge,"wks_target"),/offline/);
  assert.deepEqual(f.archives,[]);
});
