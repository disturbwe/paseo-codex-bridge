import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FramedPipe, applyPatches } from "./native";
import { detailFromState } from "./bridge";

test("IPC handles fragmented frames, unsolicited events, and concurrent responses",async()=>{
  const pipeName=process.platform === "win32" ? `\\\\.\\pipe\\paseo-desktop-test-${randomUUID()}` : path.join(os.tmpdir(), `pcb-${randomUUID()}.sock`);
  const encode=(body:unknown)=>{const b=Buffer.from(JSON.stringify(body)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);};
  const peers=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    peers.add(socket);let buffer=Buffer.alloc(0);const requests:any[]=[];
    socket.on("data",chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE(0)){
        const length=buffer.readUInt32LE(0);requests.push(JSON.parse(buffer.subarray(4,4+length).toString()));buffer=buffer.subarray(4+length);
      }
      if(requests.length===2){
        const frames=Buffer.concat([encode({type:"broadcast",method:"example"}),...requests.reverse().map(r=>encode({jsonrpc:"2.0",id:r.id,result:r.method}))]);
        socket.write(frames.subarray(0,2));setImmediate(()=>socket.write(frames.subarray(2,11)));setImmediate(()=>socket.write(frames.subarray(11)));
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(pipeName,resolve));
  const client=new FramedPipe(pipeName);const events:unknown[]=[];client.onMessage=e=>events.push(e);
  try{const values=await Promise.all([client.request({id:"one",method:"a"}),client.request({id:"two",method:"b"})]);assert.deepEqual(values.map(v=>v.result),["a","b"]);assert.equal(events.length,1);}
  finally{client.close();for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("Desktop patches preserve streamed arrays and reject prototype writes",()=>{
 const state={messages:[{text:"a"},{text:"b"}],status:"active"};
 applyPatches(state,[{op:"replace",path:["messages",0,"text"],value:"streamed"},{op:"remove",path:["messages",1]},{op:"add",path:["messages",1],value:{text:"final"}},{op:"replace",path:["status"],value:"idle"}]);
 assert.deepEqual(state,{messages:[{text:"streamed"},{text:"final"}],status:"idle"});
 assert.throws(()=>applyPatches(state,[{op:"add",path:["__proto__","bad"],value:true}]),/Unsafe/);
});

test("Canonical Desktop history exposes only user and assistant messages",()=>{
 const result=detailFromState({id:"test",title:"Existing Desktop chat",latestModel:"example",threadRuntimeStatus:{type:"active"},turnHistory:{kind:"canonical",history:{entitiesByKey:{first:{turnId:"turn-1",status:"inProgress",items:[{type:"userMessage",id:"u",content:[{type:"text",text:"question"}]},{type:"reasoning",id:"r",content:["private"]},{type:"commandExecution",id:"c",aggregatedOutput:"private"},{type:"agentMessage",id:"a",text:"answer",phase:"commentary"}]}},islands:[{entries:[{value:"first"}]}]}}},7);
 assert.deepEqual(result.messages.map(m=>[m.role,m.text]),[["user","question"],["assistant","answer"]]);assert.equal(result.activeTurnId,"turn-1");assert.equal(result.revision,7);
});
