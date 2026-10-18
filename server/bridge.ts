import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { BridgeState, SessionDetail } from "../shared/desktop";
import { AppTools, DesktopEvents, applyPatches } from "./native";
import { callerThreadId, DATA_DIRECTORY } from "./config";
import { imagePath, readImagePreview } from "./images";
import { modelsFromToolSchema } from "./models";
import { RolloutFollower } from "./rollout";
import { ArchiveSynchronizer } from "./archive";
import { childrenFromItem } from "./subagents";
type Json = any;
type Route={agentId:string;threadId:string;verificationId:string;status:"armed"|"pending"|"sending"|"sent"|"failed";turnId?:string|null;prompt?:string;error?:string};

export function detailFromState(state:Json,revision:number):SessionDetail{
  const history=state.turnHistory?.kind==="canonical"?state.turnHistory.history:null;
  const turns:Json[]=history?history.islands.flatMap((island:Json)=>island.entries.map((entry:Json)=>history.entitiesByKey[entry.value])).filter(Boolean):state.turns??[];
  const messages:SessionDetail["messages"]=[];
  const seen=new Set<string>();
  for(const turn of turns){
    for(const item of turn.items??[]){
      if(seen.has(item.id))continue;
      if(item.type==="agentMessage"&&typeof item.text==="string"){seen.add(item.id);messages.push({id:item.id,role:"assistant",text:item.text.slice(-24000),phase:item.phase??null});}
      if(item.type==="userMessage"){
        const text=(item.content??[]).filter((part:Json)=>part.type==="text").map((part:Json)=>part.text).join("\n");
        if(text){seen.add(item.id);messages.push({id:item.id,role:"user",text:text.slice(-24000),phase:null});}
      }
    }
  }
  const lastTurn=turns.at(-1);
  const active=lastTurn?.status==="inProgress"?lastTurn:null;
  return {threadId:state.id,title:state.title??state.fallbackSearchTitle??state.id,status:state.threadRuntimeStatus?.type??(active?"active":"idle"),model:state.latestModel??null,activeTurnId:active?.turnId??null,messages:messages.slice(-80),revision};
}

export class DesktopBridge {
  readonly state:BridgeState={connected:false,error:null,revision:0,sessions:[],details:{},metrics:{rpcRequests:0,ipcRequests:0,events:0,pollingRequests:0}};
  private tools=new AppTools(callerThreadId,()=>this.state.metrics.rpcRequests++);
  private events=new DesktopEvents(()=>this.state.metrics.ipcRequests++);
  private raw=new Map<string,{state:Json;revision:number}>();
  private routes=new Map<string,Route>();
  private streams=new Set<http.ServerResponse>();
  private httpServer:http.Server;
  private ready:Promise<number>;
  private token=randomBytes(32).toString("hex");
  private snapshotWaiters=new Map<string,Set<()=>void>>();
  private disposed=false;
  private listeners=new Set<(threadId:string,state:Json)=>void>();
  private disconnectListeners=new Set<(error:Error)=>void>();
  private startFlush=false;
  private childFollowers=new Map<string,RolloutFollower>();
  private archiveListeners=new Set<(threadId:string)=>void>();
  readonly archives:ArchiveSynchronizer;
  constructor(){
    fs.mkdirSync(DATA_DIRECTORY,{recursive:true});
    this.archives=new ArchiveSynchronizer(path.join(DATA_DIRECTORY,"archive-sync.json"),{
      children:id=>this.archiveChildren(id),
      setArchived:async(id,archived)=>{await this.tools.call("set_thread_archived",{threadId:id,hostId:"local",source:"codex",archived});},
      release:id=>this.releaseThread(id),
    },(event,data)=>this.record(event,data));
    try{for(const route of JSON.parse(fs.readFileSync(path.join(DATA_DIRECTORY,"routes.json"),"utf8"))){if(route.status==="sending"){route.status="failed";route.error="Delivery outcome is unknown after plugin restart; manual review required.";}this.routes.set(route.agentId,route);}}catch{}
    this.events.onChange=(id,change)=>{
      try{
        const previous=this.raw.get(id);
        if(change.type==="snapshot")this.raw.set(id,{state:change.conversationState,revision:change.revision});
        else if(change.type==="patches"&&previous&&previous.revision===change.baseRevision){previous.state=applyPatches(previous.state,change.patches);previous.revision=change.revision;}
        else {this.record("resnapshot_requested",{threadId:id});this.events.resnapshot(id);return;}
        const current=this.raw.get(id)!;this.state.details[id]=detailFromState(current.state,current.revision);
        const session=this.state.sessions.find(session=>session.id===id);
        if(session){session.status=this.state.details[id].status;session.title=this.state.details[id].title;}
        this.state.connected=true;this.state.error=null;this.state.metrics.events++;
        for(const resolve of this.snapshotWaiters.get(id)??[])resolve();
        this.snapshotWaiters.delete(id);
        this.publish();for(const listener of this.listeners)listener(id,current.state);void this.flushDeliveries();
      }catch(error){this.state.error=String(error);this.record("event_error",{threadId:id,error:String(error)});this.publish();}
    };
    this.events.onDisconnect=error=>{if(this.disposed)return;this.raw.clear();this.state.connected=false;this.state.error=error.message;this.publish();this.record("desktop_disconnected",{});for(const listener of this.disconnectListeners)listener(error);};
    this.httpServer=http.createServer((request,response)=>{
      if(request.method!=="GET"||request.url!==`/events/${this.token}`){response.writeHead(404).end();return;}
      response.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store","Connection":"keep-alive","Access-Control-Allow-Origin":"*","X-Content-Type-Options":"nosniff"});
      response.write(`data: ${JSON.stringify(this.state)}\n\n`);this.streams.add(response);request.on("close",()=>this.streams.delete(response));
    });
    this.ready=new Promise((resolve,reject)=>{this.httpServer.once("error",reject);this.httpServer.listen(0,"127.0.0.1",()=>{const address=this.httpServer.address();if(address&&typeof address!=="string")resolve(address.port);else reject(new Error("Missing event server port"));});});
    this.record("plugin_started",{pollingRequests:0});
    void this.ready.then(async()=>{for(const route of this.routes.values()){if(route.status==="armed"||route.status==="pending"){try{await this.follow(route.threadId);}catch(error){this.record("binding_restore_failed",{agentId:route.agentId,error:String(error)});}}}});
  }
  private record(event:string,data:Json){fs.appendFileSync(path.join(DATA_DIRECTORY,"evidence.jsonl"),JSON.stringify({time:new Date().toISOString(),event,...data})+"\n");console.log(`[desktop-bridge] ${event}`,JSON.stringify(data));}
  private persist(){fs.writeFileSync(path.join(DATA_DIRECTORY,"routes.json"),JSON.stringify([...this.routes.values()],null,2));}
  private publish(){this.state.revision++;const body=`data: ${JSON.stringify(this.state)}\n\n`;for(const stream of this.streams){if(stream.writableLength>2*1024*1024){stream.end();this.streams.delete(stream);}else stream.write(body);}}
  async bootstrap(){const port=await this.ready;return {eventUrl:`http://127.0.0.1:${port}/events/${this.token}`,state:this.state};}
  snapshot(threadId:string){return this.raw.get(threadId)?.state;}
  subscribe(listener:(threadId:string,state:Json)=>void,onDisconnect:(error:Error)=>void){this.listeners.add(listener);this.disconnectListeners.add(onDisconnect);return()=>{this.listeners.delete(listener);this.disconnectListeners.delete(onDisconnect);};}
  evidence(event:string,data:Json){this.record(event,data);}
  async imagePreview(rootThreadId:string,callId:string){
    if(!this.raw.has(rootThreadId))await this.follow(rootThreadId);
    for(const id of [rootThreadId,...this.archives.descendants(rootThreadId).map(node=>node.threadId)]){
      const state=this.snapshot(id);if(!state)continue;
      const history=state.turnHistory?.kind==="canonical"?state.turnHistory.history:null;
      const turns=history?history.islands.flatMap((island:Json)=>island.entries.map((entry:Json)=>history.entitiesByKey[entry.value])):state.turns??[];
      for(const turn of turns)for(const item of turn?.items??[])if(item.type==="imageView"&&item.id===callId){
        const file=imagePath(item.path);if(!file)throw new Error("Desktop 未提供可预览的图像路径");
        return readImagePreview(file);
      }
    }
    throw new Error("当前 Desktop 会话中未找到这条读图记录");
  }
  async models(){return modelsFromToolSchema(await this.tools.describe("create_thread"));}
  bindRoot(threadId:string,env:Readonly<Record<string,string>>){
    this.archives.registerThread(threadId);
    if(env.PASEO_DESKBRIDGE_AGENT_ID)this.archives.registerAgent(env.PASEO_DESKBRIDGE_AGENT_ID,env.PASEO_DESKBRIDGE_WORKSPACE_ID||null,threadId);
  }
  bindChild(parentThreadId:string,threadId:string,title:string){this.archives.registerThread(threadId,parentThreadId,title);}
  isThreadArchived(threadId:string){return this.archives.isArchived(threadId);}
  subscribeArchived(listener:(threadId:string)=>void){this.archiveListeners.add(listener);return()=>{this.archiveListeners.delete(listener);};}
  private async archiveChildren(threadId:string){
    const found=new Map<string,{threadId:string;title?:string}>();
    let cursor:string|undefined;const seen=new Set<string>();
    for(let page=0;page<100;page++){
      const response=await this.tools.call("read_thread",{threadId,hostId:"local",turnLimit:10,includeOutputs:true,maxOutputCharsPerItem:1000,...(cursor?{cursor}:{})});
      if(response.thread?.id!==threadId)throw new Error("Desktop 返回了不匹配的会话");
      this.archives.registerThread(threadId,undefined,response.thread.title);
      for(const turn of response.turns??[])for(const item of turn.items??[]){
        for(const child of childrenFromItem(item))found.set(child.threadId,{threadId:child.threadId,title:child.title});
      }
      const next=response.page?.nextCursor;
      if(!next)return [...found.values()];
      if(seen.has(next))throw new Error("Desktop 历史游标重复，无法完整发现子会话");
      seen.add(next);cursor=next;
    }
    throw new Error("Desktop 会话历史超出本次归档发现上限");
  }
  releaseThread(threadId:string){
    this.childFollowers.get(threadId)?.close();this.childFollowers.delete(threadId);
    try{this.events.unfollow(threadId);}catch{}
    this.raw.delete(threadId);delete this.state.details[threadId];
    for(const listener of this.archiveListeners)listener(threadId);
    this.record("desktop_subscription_released",{threadId});
  }
  async configureSession(threadId:string,model:string,effort?:string){
    const committed=await this.events.configure(threadId,{model,...(effort!==undefined?{effort}:{})});
    this.record("provider_model_configured",{threadId,model:committed.model,thinking:committed.reasoningEffort});return committed;
  }
  async followChild(threadId:string,rolloutPath:string){
    if(this.childFollowers.has(threadId))return;
    const follower=new RolloutFollower(rolloutPath,threadId,state=>{
      const revision=(this.raw.get(threadId)?.revision??0)+1;
      this.raw.set(threadId,{state,revision});this.state.details[threadId]=detailFromState(state,revision);this.state.metrics.events++;
      for(const listener of this.listeners)listener(threadId,state);
    },error=>this.record("child_stream_error",{threadId,error:String(error)}));
    this.childFollowers.set(threadId,follower);
    try{follower.start();}catch(error){follower.close();this.childFollowers.delete(threadId);throw error;}
    this.record("child_rollout_subscribed",{threadId,pollingRequests:0});
  }
  async createSession(prompt:string,title:string|undefined,cwd:string,model?:string,thinking?:string){
    const projects=await this.tools.call("list_projects",{});
    const normalize=(value:string)=>process.platform === "win32" ? value.replace(/\\/g,"/").replace(/\/$/,"").toLowerCase() : value.replace(/\/$/,"");
    const project=(projects.projects??[]).find((entry:Json)=>entry.projectKind==="local"&&(entry.hostId??"local")==="local"&&[entry.cwd,entry.path,entry.rootPath].some(value=>typeof value==="string"&&normalize(value)===normalize(cwd)));
    const target=project?{type:"project",projectId:project.id??project.projectId,environment:{type:"local"}}:{type:"projectless"};
    const result=await this.tools.call("create_thread",{prompt,title,target,...(model?{model}:{}),...(thinking?{thinking}:{})});
    const threadId=result.threadId??result.result?.threadId;
    if(typeof threadId!=="string")throw new Error(`Desktop 尚未返回已创建的 threadId: ${JSON.stringify(result)}`);
    this.record("provider_desktop_created",{threadId,requestedCwd:cwd,target,model,thinking});return threadId;
  }
  async listSessions(){
    try{
      const result=await this.tools.call("list_threads",{limit:50});
      const all=[...(result.pinnedThreads??[]),...(result.threads??[])];
      const unique=new Map<string,Json>();
      for(const thread of all){if(thread.kind==="codex"&&(thread.hostId??"local")==="local")unique.set(thread.id,thread);}
      this.state.sessions=[...unique.values()].map(thread=>({id:thread.id,title:(thread.title??thread.id).slice(0,240),cwd:this.raw.get(thread.id)?.state.cwd??thread.cwd??thread.project?.cwd??null,status:typeof thread.status==="string"?thread.status:thread.status?.type??"unknown",updatedAt:thread.updatedAt??null}));
      this.state.error=null;this.publish();return this.state;
    }catch(error){this.state.error=String(error);this.publish();throw error;}
  }
  async follow(threadId:string){
    if(this.raw.has(threadId))return this.state;
    if(this.raw.size>=64)throw new Error("最多同时订阅 64 个 Desktop 会话。重新加载插件可清除订阅。");
    const snapshot=new Promise<void>((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);resolve();};
      const waiters=this.snapshotWaiters.get(threadId)??new Set();waiters.add(done);this.snapshotWaiters.set(threadId,waiters);
      const timer=setTimeout(()=>{waiters.delete(done);if(waiters.size===0)this.snapshotWaiters.delete(threadId);reject(new Error("Desktop 尚未提供会话快照。请在 Desktop 打开此会话后重试。"));},15000);
    });
    void snapshot.catch(()=>{});
    try {await this.events.follow(threadId);await snapshot;this.record("desktop_followed",{threadId,pollingRequests:0});}
    catch(error){if(error instanceof Error&&error.message==="no-client-found")throw new Error("此会话尚未在 Desktop 打开。点击“在 Desktop 打开”，然后重新选择会话。");throw error;}
    return this.state;
  }
  async send(threadId:string,prompt:string){
    const text=prompt.trim();if(!text)throw new Error("消息不能为空。");
    await this.tools.call("send_message_to_thread",{threadId,hostId:"local",prompt:text});
    this.record("desktop_message_accepted",{threadId,characters:text.length});return {accepted:true,threadId};
  }
  async interrupt(threadId:string){
    const turnId=this.state.details[threadId]?.activeTurnId;if(!turnId)throw new Error("该会话没有可中断的活动轮次。");
    await this.events.interrupt(threadId,turnId);this.record("desktop_interrupted",{threadId,turnId});return {accepted:true};
  }
  async open(threadId:string){await this.tools.call("navigate_to_codex_page",{threadId});return {accepted:true};}
  async watchCompletion(input:{agentId:string;threadId:string;verificationId:string}){
    if(this.routes.has(input.agentId))throw new Error("该子任务已有回传绑定。请使用新的子任务。");
    await this.follow(input.threadId);this.routes.set(input.agentId,{...input,status:"armed"});this.persist();this.record("callback_armed",input);return {registered:true};
  }
  async onAgentEnded(event:PluginLifecycleEvents["agent.turn_ended"]){
    const route=this.routes.get(event.agent.id);if(!route||route.status!=="armed")return;
    const timeline=event.timeline;let start=0;for(let i=timeline.length-1;i>=0;i--){if(timeline[i].type==="user_message"){start=i+1;break;}}
    const output=timeline.slice(start).filter(item=>item.type==="assistant_message").map(item=>(item as {text:string}).text).join("\n").slice(-20000);
    route.turnId=event.turnId;route.status="pending";
    route.prompt=`Paseo 任务完成自动回传。绑定编号：${route.verificationId}。\n任务：${event.agent.id}\n状态：${event.outcome.kind}\n结果：\n${output||JSON.stringify(event.outcome)}\n\n这是用户已授权的完成通知。请根据任务结果向用户汇报。`;
    this.persist();this.record("agent_turn_ended",{agentId:event.agent.id,turnId:event.turnId,outcome:event.outcome.kind,verificationId:route.verificationId});
    void this.flushDeliveries();
  }
  private async flushDeliveries(){
    if(this.startFlush||this.disposed)return;this.startFlush=true;
    try{for(const route of this.routes.values()){
      if(route.status!=="pending")continue;
      const detail=this.state.details[route.threadId];
      if(!this.state.connected||!this.raw.has(route.threadId)||!detail||detail.status==="active"||detail.activeTurnId)continue;
      route.status="sending";this.persist();this.record("callback_sending",{agentId:route.agentId,threadId:route.threadId,verificationId:route.verificationId,targetStatus:detail.status});
      try{await this.send(route.threadId,route.prompt!);route.status="sent";delete route.prompt;this.persist();this.record("callback_delivered",{agentId:route.agentId,threadId:route.threadId,verificationId:route.verificationId,metrics:{...this.state.metrics},pollingRequests:0});}
      catch(error){route.status="failed";route.error=String(error);this.persist();this.record("callback_failed",{agentId:route.agentId,error:String(error)});}
    }}finally{this.startFlush=false;}
  }
  async close(){this.disposed=true;for(const follower of this.childFollowers.values())follower.close();this.childFollowers.clear();this.events.close();this.tools.close();for(const stream of this.streams)stream.end();this.streams.clear();await new Promise<void>(resolve=>this.httpServer.close(()=>resolve()));}
}
