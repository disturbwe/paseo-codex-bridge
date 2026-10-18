import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchiveSynchronizer } from "./archive";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"deskbridge-archive-")), file=path.join(directory,"archive.json");
  const calls:Array<{id:string;archived:boolean}>=[], released:string[]=[];
  const children=new Map([[id(1),[id(2),id(3)]],[id(2),[id(4)]],[id(5),[id(6)]]]);
  const failing=new Set<string>();
  const transport={children:async(threadId:string)=>(children.get(threadId)??[]).map(threadId=>({threadId})),setArchived:async(threadId:string,archived:boolean)=>{if(failing.has(threadId))throw new Error("Desktop unavailable");calls.push({id:threadId,archived});},release:(threadId:string)=>{released.push(threadId);}};
  const sync=new ArchiveSynchronizer(file,transport,()=>{});
  sync.registerAgent(id(10),"workspace-A",id(1));sync.registerAgent(id(11),"workspace-B",id(5));
  return {sync,calls,released,failing,file,transport,clean:()=>{for(const name of fs.readdirSync(directory))fs.unlinkSync(path.join(directory,name));fs.rmdirSync(directory);}};
}

test("Workspace archive cascades only to its recorded Desktop tree, including after restart",async()=>{
  const f=fixture();try{
    await f.sync.listChildren(id(10));await f.sync.listChildren(id(11));
    const restored=new ArchiveSynchronizer(f.file,f.transport,()=>{});
    await restored.archiveWorkspace("workspace-A");
    assert.deepEqual(new Set(f.calls.map(call=>call.id)),new Set([id(1),id(2),id(3),id(4)]));
    assert.ok(f.calls.every(call=>call.archived));assert.equal(f.released.length,4);
    await restored.archiveWorkspace("workspace-A");assert.equal(f.calls.length,4);
    assert.ok(!restored.isArchived(id(5)));assert.ok(!restored.isArchived(id(6)));
  }finally{f.clean();}
});

test("Manual child archive is scoped and remains archived when its parent is restored",async()=>{
  const f=fixture();try{
    await f.sync.listChildren(id(10));
    assert.throws(()=>f.sync.archiveChild(id(10),id(6)),/不属于/);
    await f.sync.archiveChild(id(10),id(2));
    await f.sync.archiveTree(id(1));
    await f.sync.restoreTree(id(1));
    const restored=f.calls.filter(call=>!call.archived).map(call=>call.id);
    assert.deepEqual(new Set(restored),new Set([id(1),id(3)]));
    assert.ok(f.sync.isArchived(id(2)));assert.ok(f.sync.isArchived(id(4)));
  }finally{f.clean();}
});

test("Failed native archive stays pending durably and retries once on startup without polling",async()=>{
  const f=fixture();try{
    f.failing.add(id(3));await assert.rejects(f.sync.archiveTree(id(1)),/待处理/);
    assert.ok(JSON.parse(fs.readFileSync(f.file,"utf8")).nodes[id(3)].pending);
    f.failing.clear();const count=f.calls.length;
    const restored=new ArchiveSynchronizer(f.file,f.transport,()=>{});await restored.resumePending();
    assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1)?.id,id(3));
    assert.ok(restored.isArchived(id(3)));assert.ok(!JSON.parse(fs.readFileSync(f.file,"utf8")).nodes[id(3)].pending);
  }finally{f.clean();}
});

test("Discovery outage persists tree intent before any history read and recovers descendants on restart", async () => {
  const f=fixture(); try {
    const broken=new ArchiveSynchronizer(f.file,{...f.transport,children:async()=>{throw new Error("offline");}},()=>{});
    await assert.rejects(broken.archiveTree(id(1)),/offline/);
    assert.equal(JSON.parse(fs.readFileSync(f.file,"utf8")).intents[id(1)],true);
    const restored=new ArchiveSynchronizer(f.file,f.transport,()=>{}); await restored.resumePending();
    assert.deepEqual(new Set(f.calls.map(call=>call.id)),new Set([id(1),id(2),id(3),id(4)]));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file,"utf8")).intents,{});
  } finally { f.clean(); }
});
