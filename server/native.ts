import net from "node:net";
import { toolsEndpoint, eventsEndpoint } from "./endpoints";
import { randomUUID } from "node:crypto";
type Json = any;

export class FramedPipe {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, {resolve:(value:Json)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  onMessage: (message:Json)=>void = () => {};
  onDisconnect: (error:Error)=>void = () => {};
  constructor(readonly path:string) {}
  connect():Promise<void> {
    if(this.socket&&!this.socket.destroyed)return Promise.resolve();
    if(this.connecting)return this.connecting;
    this.connecting=new Promise<void>((resolve,reject)=>{
      const socket=net.createConnection(this.path);
      const timer=setTimeout(()=>socket.destroy(new Error("连接 Desktop 管道超时")),10000);
      socket.once("connect",()=>{clearTimeout(timer);this.socket=socket;resolve();});
      socket.on("data",chunk=>{
        this.buffer=Buffer.concat([this.buffer,chunk]);
        while(this.buffer.length>=4){
          const length=this.buffer.readUInt32LE(0);
          if(length===0||length>32*1024*1024){socket.destroy(new Error("Desktop IPC frame is too large"));return;}
          if(this.buffer.length<4+length)return;
          const payload=this.buffer.subarray(4,4+length);this.buffer=this.buffer.subarray(4+length);
          try {
            const message=JSON.parse(payload.toString("utf8"));
            const id=String(message.requestId??message.id??""),entry=this.pending.get(id);
            if(entry&&(message.type==="response"||"result"in message||"error"in message)){
              this.pending.delete(id);clearTimeout(entry.timer);
              if(message.error||message.resultType==="error")entry.reject(new Error(typeof message.error==="string"?message.error:message.error?.message??"IPC request failed"));
              else entry.resolve(message);
            }else this.onMessage(message);
          }catch(error){socket.destroy(error as Error);return;}
        }
      });
      socket.on("error",error=>{clearTimeout(timer);reject(error);});
      socket.on("close",()=>{clearTimeout(timer);this.socket=null;this.buffer=Buffer.alloc(0);this.connecting=null;const error=new Error("Codex Desktop 连接已断开；重新连接后恢复。");for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}this.pending.clear();this.onDisconnect(error);});
    }).finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  write(message:Json){
    if(!this.socket||this.socket.destroyed)throw new Error("Desktop pipe is not connected");
    const bytes=Buffer.from(JSON.stringify(message)),header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);this.socket.write(Buffer.concat([header,bytes]));
  }
  async request(message:Json):Promise<Json>{
    await this.connect();const id=String(message.requestId??message.id);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Desktop 请求超时: ${message.method}`));},20000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.write(message);}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  close(){this.onDisconnect=()=>{};this.socket?.destroy();}
}

export class AppTools {
  private pipe:FramedPipe|null=null;
  private tools=new Map<string,Json>();
  private initializing:Promise<void>|null=null;
  constructor(private callerThreadId:()=>string,private count:()=>void){}
  private async ensure(){
    if(this.initializing)return this.initializing;
    if(!this.pipe){
      this.initializing=this.load();
      try{await this.initializing;}catch(error){this.close();this.tools.clear();throw error;}finally{this.initializing=null;}
    }
  }
  private async load(){
      this.pipe=new FramedPipe(toolsEndpoint());
      this.pipe.onDisconnect=()=>{this.pipe=null;this.tools.clear();};
      this.count();const response=await this.pipe.request({jsonrpc:"2.0",id:randomUUID(),method:"tools/list",params:{threadStartKind:"all"}});
      for(const tool of response.result.tools)this.tools.set(tool.name,tool);
  }
  async call(name:string,args:Json){
    await this.ensure();const tool=this.tools.get(name);if(!tool)throw new Error(`Desktop 缺少接口: ${name}`);
    this.count();const response=await this.pipe!.request({jsonrpc:"2.0",id:randomUUID(),method:"tools/call",params:{namespace:tool.namespace,tool:name,callerSource:"codex",threadId:this.callerThreadId(),turnId:"paseo-bridge-"+randomUUID(),callId:"paseo-bridge-"+randomUUID(),arguments:args}});
    const result=response.result,text=result.contentItems?.filter((x:Json)=>x.type==="inputText").map((x:Json)=>x.text).join("\n")??"";
    if(!result.success)throw new Error(text||"Desktop tool failed");
    try{return JSON.parse(text);}catch{return {text};}
  }
  async describe(name:string){
    await this.ensure();
    this.count();const response=await this.pipe!.request({jsonrpc:"2.0",id:randomUUID(),method:"tools/list",params:{threadStartKind:"all"}});
    for(const tool of response.result.tools)this.tools.set(tool.name,tool);
    const tool=this.tools.get(name);if(!tool)throw new Error(`Desktop 缺少接口: ${name}`);return tool;
  }
  close(){this.pipe?.close();this.pipe=null;}
}

export class DesktopEvents {
  private pipe=new FramedPipe(eventsEndpoint());
  private clientId="uninitialized";
  private owners=new Map<string,string>();
  private ready:Promise<void>|null=null;
  onChange:(threadId:string,change:Json)=>void=()=>{};
  onDisconnect:(error:Error)=>void=()=>{};
  constructor(private count:()=>void){
    this.pipe.onDisconnect=error=>{this.ready=null;this.owners.clear();this.onDisconnect(error);};
    this.pipe.onMessage=message=>{
      if(message.type==="client-discovery-request")this.pipe.write({type:"client-discovery-response",requestId:message.requestId,response:{canHandle:false}});
      if(message.type==="broadcast"&&message.method==="thread-stream-state-changed"&&message.version===11&&this.owners.has(message.params?.conversationId))this.onChange(message.params.conversationId,message.params.change);
    };
  }
  private initialize(){
    return this.ready??=this.request("initialize",{clientType:"cli"},0).then(response=>{this.clientId=response.result.clientId;});
  }
  private async request(method:string,params:Json,version:number,targetClientId?:string){
    this.count();return this.pipe.request({type:"request",requestId:randomUUID(),sourceClientId:this.clientId,version,method,params,targetClientId,timeoutMs:15000});
  }
  async follow(threadId:string){
    await this.initialize();
    if(this.owners.has(threadId))return;
    const response=await this.request("thread-owner-discovery",{hostId:"local",conversationId:threadId},1);
    this.owners.set(threadId,response.handledByClientId);this.following(threadId,true);
  }
  private following(threadId:string,following:boolean){
    this.pipe.write({type:"broadcast",method:"thread-stream-following-changed",sourceClientId:this.clientId,version:1,params:{conversationId:threadId,hostId:"local",following},targetClientIds:[this.owners.get(threadId)]});
  }
  resnapshot(threadId:string){this.following(threadId,false);this.following(threadId,true);}
  unfollow(threadId:string){if(!this.owners.has(threadId))return;try{this.following(threadId,false);}finally{this.owners.delete(threadId);}}
  async interrupt(threadId:string,expectedTurnId:string){
    await this.follow(threadId);return this.request("thread-follower-interrupt-turn",{conversationId:threadId,expectedTurnId},4,this.owners.get(threadId));
  }
  async readSettings(threadId:string){
    await this.follow(threadId);const response=await this.request("thread-follower-read-model-settings",{conversationId:threadId},1,this.owners.get(threadId));return response.result.settings;
  }
  async configure(threadId:string,threadSettings:Json){
    await this.follow(threadId);const response=await this.request("thread-follower-update-thread-settings",{conversationId:threadId,threadSettings},2,this.owners.get(threadId));
    if(!response.result?.applied)throw new Error("Desktop 未应用模型设置。");
    return this.readSettings(threadId);
  }
  close(){for(const id of this.owners.keys()){try{this.following(id,false);}catch{}}this.pipe.close();}
}

export function applyPatches(state:Json,patches:Json[]):Json{
  let result=state;
  for(const patch of patches){
    const path:Array<string|number>=Array.isArray(patch.path)?patch.path:patch.path===""?[]:String(patch.path).replace(/^\//,"").split("/").map((part:string)=>part.replace(/~1/g,"/").replace(/~0/g,"~"));
    if(path.some(key=>["__proto__","constructor","prototype"].includes(String(key))))throw new Error("Unsafe IPC patch path");
    if(path.length===0){result=patch.value;continue;}
    let parent=result;for(const key of path.slice(0,-1)){if(parent==null||!(key in parent))throw new Error("IPC patch path is missing");parent=parent[key];}
    const key=path.at(-1)!;
    if(Array.isArray(parent)){
      const index=key==="-"?parent.length:Number(key);
      if(!Number.isInteger(index)||index<0||index>parent.length)throw new Error("Invalid array patch index");
      if(patch.op==="remove")parent.splice(index,1);else if(patch.op==="add")parent.splice(index,0,patch.value);else if(patch.op==="replace")parent[index]=patch.value;else throw new Error("Unknown IPC patch operation");
    }else if(patch.op==="remove")delete parent[key];else if(patch.op==="add"||patch.op==="replace")parent[key]=patch.value;else throw new Error("Unknown IPC patch operation");
  }
  return result;
}
