import test from "node:test";
import assert from "node:assert/strict";
import { toolsEndpoint, eventsEndpoint } from "./endpoints";
test("Windows discovers named app-tools pipes and fixed events endpoint", () => {
  const io={names:(directory:string)=>{assert.equal(directory,"\\\\.\\pipe\\");return ["unrelated","codex-app-tools-abc"];},socket:()=>false};
  assert.equal(toolsEndpoint("win32",undefined,io),"\\\\.\\pipe\\codex-app-tools-abc");
  assert.equal(eventsEndpoint("win32"),"\\\\.\\pipe\\codex-ipc");
});
test("macOS discovers Unix sockets and rejects ambiguous instances", () => {
  const io={names:(directory:string)=>{assert.equal(directory,"/tmp/codex-app-tools");return ["one.sock","note.txt"];},socket:(file:string)=>file==="/tmp/codex-app-tools/one.sock"};
  assert.equal(toolsEndpoint("darwin",undefined,io),"/tmp/codex-app-tools/one.sock");
  assert.throws(()=>toolsEndpoint("darwin",undefined,{names:()=>["a.sock","b.sock"],socket:()=>true}),/多个/);
  assert.throws(()=>toolsEndpoint("darwin",undefined,{names:()=>[],socket:()=>true}),/启动/);
  assert.equal(toolsEndpoint("darwin","/custom/tools.sock",io),"/custom/tools.sock");
  assert.equal(eventsEndpoint("darwin","/custom/events.sock"),"/custom/events.sock");
});
