import test from "node:test";
import assert from "node:assert/strict";
import { ProviderEventSchema, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import { DesktopProviderConnection, timelineFromItem } from "./provider";
import type { DesktopBridge } from "./bridge";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const config = { cwd: "C:/test", env: {}, mcpServers: {}, settings: {}, persist: true };
class FakeBridge {
  state: any = { id: "native-thread", cwd: "C:/test", turns: [], threadRuntimeStatus: { type: "idle" } };
  listener: (id: string, state: any) => void = () => {};
  interrupted = 0;
  createdWith: any[] = [];
  childStates = new Map<string, any>();
  async models() { return [{ id: "desktop", label: "Default" }, { id: "model-a", label: "A", thinkingOptions: [{ id: "low", label: "low" }, { id: "high", label: "high" }] }, { id: "model-b", label: "B", thinkingOptions: [{ id: "none", label: "none" }] }]; }
  async configureSession(_threadId: string, model: string, thinking?: string) { this.state.latestModel = model; this.state.latestReasoningEffort = thinking; return { model, reasoningEffort: thinking }; }
  subscribe(listener: typeof this.listener) { this.listener = listener; return () => { this.listener = () => {}; }; }
  snapshot(id?: string) { return this.childStates.get(id ?? "") ?? this.state; }
  async follow() {}
  async followChild() {}
  bindRoot() {}
  bindChild() {}
  isThreadArchived() { return false; }
  subscribeArchived() { return () => {}; }
  async open() {}
  async send() {}
  async createSession(...args: any[]) { this.createdWith = args; this.state.latestModel = args[3] ?? "model-a"; this.state.latestReasoningEffort = args[4] ?? "high"; return "native-thread"; }
  async interrupt() { this.interrupted++; }
  evidence() {}
  push(turns: any[]) { this.state.turns = turns; this.listener("native-thread", this.state); }
}
function setup() {
  const bridge = new FakeBridge();
  const connection = new DesktopProviderConnection(bridge as unknown as DesktopBridge, ["prompt.message", "session.persistence"]);
  const events: ProviderEvent[] = [];
  connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
  return { bridge, connection, events };
}

test("Desktop provider correlates one prompt, streams stable IDs, and terminates once", async () => {
  const { bridge, connection, events } = setup();
  await connection.send({ type: "session.open", requestId: "open", sessionId: "agent", config, history: "skip" }); await tick();
  await connection.send({ type: "session.prompt", sessionId: "agent", prompt: { clientMessageId: "message", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hello" }] } } }); await tick();
  const turn = { turnId: "native-turn", status: "inProgress", items: [{ id: "answer", type: "agentMessage", text: "he" }] };
  bridge.push([turn]); bridge.push([turn]);
  bridge.push([{ ...turn, items: [{ ...turn.items[0], text: "hello" }] }]);
  bridge.push([{ ...turn, status: "completed", items: [{ ...turn.items[0], text: "hello" }] }]);
  bridge.push([{ ...turn, status: "completed", items: [{ ...turn.items[0], text: "hello" }] }]);
  assert.equal(events.filter(e => e.type === "session.prompt_result").length, 1);
  const textEvents = events.filter(e => e.type === "timeline.item" && e.item.type === "assistant_message");
  assert.equal(textEvents.length, 2);
  assert.equal(new Set(textEvents.map(e => e.type === "timeline.item" ? e.item.id : "")).size, 1);
  assert.deepEqual(events.filter(e => e.type === "session.turn").map(e => e.type === "session.turn" && e.state), ["started", "completed"]);
  assert.ok(events.some(e => e.type === "session.persistence"));
  await connection.close();
});

test("Desktop provider restores the same thread and ignores historical completion", async () => {
  const { bridge, connection, events } = setup();
  bridge.state.turns = [{ turnId: "old", status: "completed", items: [{ id: "old-answer", type: "agentMessage", text: "previous" }] }];
  await connection.send({ type: "session.open", requestId: "open", sessionId: "agent", config, persistence: { version: 1, data: { threadId: "native-thread" } }, history: "replay" }); await tick();
  assert.ok(events.some(e => e.type === "timeline.item" && e.item.id === "desktop:old-answer"));
  await connection.send({ type: "session.prompt", sessionId: "agent", prompt: { clientMessageId: "second", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "next" }] } } }); await tick();
  assert.equal(events.filter(e => e.type === "session.turn" && e.state === "completed").length, 0);
  await connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "agent" }); await tick();
  assert.equal(bridge.interrupted, 1);
  bridge.push([...bridge.state.turns, { turnId: "next", status: "interrupted", items: [] }]);
  assert.equal(events.filter(e => e.type === "session.turn" && e.state === "canceled").length, 1);
  await connection.close();
});

test("Desktop timeline omits private reasoning and preserves command failure/output", () => {
  assert.equal(timelineFromItem({ id: "secret", type: "reasoning", content: ["private"] }), null);
  const prompt = timelineFromItem({ id: "delegated", type: "functionCallOutput", name: "send_message_to_thread", namespace: "codex_app", output: "<codex_delegation>\n<source_thread_id>root</source_thread_id>\n<input>test prompt</input>\n</codex_delegation>" });
  assert.equal(prompt?.type, "user_message");
  if (prompt?.type === "user_message") assert.equal(prompt.text, "test prompt");
  const item = timelineFromItem({ id: "cmd", type: "commandExecution", status: "completed", command: "exit 1", output: { text: "failed" }, exitCode: 1 });
  assert.equal(item?.type, "tool_call");
  if (item?.type === "tool_call") { assert.equal(item.status, "failed"); assert.equal(item.detail.type, "shell"); if (item.detail.type === "shell") assert.equal(item.detail.output, "failed"); }
});

test("Turns started directly in Desktop also update the ordinary Paseo agent lifecycle", async () => {
  const { bridge, connection, events } = setup();
  await connection.send({ type: "session.open", requestId: "open", sessionId: "agent", config, persistence: { version: 1, data: { threadId: "native-thread" } }, history: "skip" }); await tick();
  bridge.push([{ turnId: "external", status: "inProgress", items: [] }]);
  bridge.push([{ turnId: "external", status: "completed", items: [] }]);
  bridge.push([{ turnId: "external", status: "completed", items: [] }]);
  assert.deepEqual(events.filter(e => e.type === "session.turn").map(e => e.type === "session.turn" && e.state), ["started", "completed"]);
  await connection.close();
});

test("Selected model/thinking reach Desktop creation and can change on an existing agent", async () => {
  const { bridge, connection, events } = setup();
  await connection.send({ type: "session.open", requestId: "open", sessionId: "agent", config: { ...config, model: "model-a", thinkingOption: "low" }, history: "skip" }); await tick();
  await connection.send({ type: "session.prompt", sessionId: "agent", prompt: { clientMessageId: "model-test", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "test" }] } } }); await tick();
  assert.deepEqual(bridge.createdWith.slice(3), ["model-a", "low"]);
  bridge.push([{ turnId: "first", status: "completed", items: [] }]);
  await connection.send({ type: "session.configure", requestId: "switch", sessionId: "agent", changes: { model: "model-b" } }); await tick();
  assert.equal(bridge.state.latestModel, "model-b");
  assert.equal(bridge.state.latestReasoningEffort, "none");
  const committed = events.filter(e => e.type === "session.config").at(-1);
  assert.equal(committed?.type === "session.config" && committed.config.model, "model-b");
  assert.ok(events.some(e => e.type === "request.completed" && e.requestId === "switch"));
  await connection.send({ type: "session.configure", requestId: "invalid", sessionId: "agent", changes: { thinkingOption: "high" } }); await tick();
  assert.ok(events.some(e => e.type === "request.failed" && e.requestId === "invalid"));
  assert.equal(bridge.state.latestReasoningEffort, "none");
  await connection.close();
});

test("Native Desktop children populate Paseo provider subagents once, with isolated history and terminal state", async () => {
  const { bridge, connection, events } = setup();
  const spawn = { id: "spawn-tool", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child-1", "child-2"], receiverThreads: ["child-1", "child-2"].map(threadId => ({ threadId, thread: { path: `C:/${threadId}.jsonl` } })), prompt: "two native tasks" };
  bridge.state.turns = [{ turnId: "parent-old", status: "completed", items: [spawn] }];
  for (const id of ["child-1", "child-2"]) bridge.childStates.set(id, { id, cwd: "C:/test", latestModel: "model-a", turns: [{ turnId: `${id}-turn`, status: "completed", items: [{ id: `${id}-reply`, type: "agentMessage", text: `${id} result` }] }] });
  await connection.send({ type: "session.open", requestId: "open", sessionId: "parent", config, persistence: { version: 1, data: { threadId: "native-thread" } }, history: "skip" }); await tick(); await tick();
  bridge.push(bridge.state.turns); await tick();
  const children = events.filter(e => e.type === "session.opened" && e.parentSessionId === "parent");
  assert.equal(children.length, 2);
  assert.ok(children.every(e => e.type === "session.opened" && e.restoration === "parent" && e.toolCallId === "spawn-tool"));
  for (const id of ["child-1", "child-2"]) {
    assert.ok(events.some(e => e.type === "timeline.item" && e.sessionId === `desktop-child:${id}` && e.item.type === "assistant_message" && e.item.text === `${id} result`));
    assert.equal(events.filter(e => e.type === "session.turn" && e.sessionId === `desktop-child:${id}` && e.state === "completed").length, 1);
  }
  assert.ok(!events.some(e => e.type === "timeline.item" && e.sessionId === "parent" && e.item.type === "assistant_message"));
  await connection.close();
});

test("Desktop image views retain public paths and status in live and replayed timelines",async()=>{
  const {bridge,connection,events}=setup();
  bridge.state.turns=[{turnId:"image-turn",status:"completed",items:[{type:"imageView",id:"image-call",path:"/tmp/render.png"}]}];
  await connection.send({type:"session.open",requestId:"image-replay",sessionId:"image-agent",config,persistence:{version:1,data:{threadId:"native-thread"}},history:"replay"});await tick();
  const rows=events.filter(e=>e.type==="timeline.item"&&e.item.type==="tool_call"&&e.item.metadata?.desktopImageView===true);
  assert.equal(rows.length,1);
  const item=timelineFromItem({type:"imageView",id:"image-call",path:"/tmp/render.png",status:"inProgress"});
  assert.equal(item?.id,"desktop:image-call");assert.equal(item?.type==="tool_call"&&item.status,"running");
  assert.equal(item?.type==="tool_call"&&item.detail.type,"plain_text");
  assert.equal(item?.type==="tool_call"&&item.metadata?.filePath,"/tmp/render.png");
  await connection.close();
});
