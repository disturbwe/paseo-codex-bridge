import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { goalFromState, goalLabel, goalStateSchema } from "../shared/goals";
import { registerGoalHooks } from "./goals";
import { DesktopEvents } from "./native";

const goal = { objective: "Verify the bridge", status: "active", createdAt: 100, updatedAt: 110 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("Goal projection preserves authoritative lifecycle and excludes private state", () => {
  const active = goalFromState({ threadGoal: { ...goal, privateReasoning: "secret" }, turns: ["secret"] }, 1);
  assert.deepEqual(active.goal, goal);
  assert.equal(active.canPause, true);
  assert.equal(goalLabel(active), "目标 · 进行中");
  assert.equal(goalFromState({ threadGoal: { ...goal, status: "paused" } }, 2).canPause, false);
  const completed = goalFromState({ threadGoal: null, completedThreadGoal: { ...goal, status: "complete" } }, 3);
  assert.equal(goalLabel(completed), "目标 · 已完成");
  assert.equal(goalLabel(goalFromState({ threadGoal: null }, 4)), "目标 · 未设置");
  assert.equal(goalLabel(goalFromState({}, 5, false, "Disconnected")), "目标 · 未同步");
  assert.equal(goalLabel(goalFromState({ threadGoal: { ...goal, status: "budgetLimited" } }, 5)), "目标 · 达到预算");
  assert.equal(goalFromState({ threadGoal: { objective: 42, status: "active" } }, 6).goal, null);
  assert.equal(goalStateSchema.parse(active).revision, 1);
});

function setup() {
  let state: any = { threadGoal: goal };
  const rows: any[] = [], handlers = new Map<string, any>();
  let listener: any = () => {}, disconnect: any = () => {}, archived: any = () => {};
  let provider = "chatgpt-desktop", failure = false;
  const bridge: any = {
    state: { revision: 1, connected: true, error: null }, snapshot: () => state,
    archives: { registerAgent() {}, agent: () => ({ threadId: "thread" }) }, isThreadArchived: () => false, follow: async () => {}, evidence() {},
    subscribe: (onChange: any, onDisconnect: any) => { listener = onChange; disconnect = onDisconnect; return () => { listener = disconnect = () => {}; }; },
    subscribeArchived: (fn: any) => { archived = fn; return () => { archived = () => {}; }; },
    pauseGoal: async () => { if (failure) throw new Error("Native pause failed"); push({ threadGoal: { ...goal, status: "paused" } }); },
    open: async () => ({ accepted: true }),
  };
  const push = (value: any) => { state = value; bridge.state.revision++; bridge.state.connected = true; bridge.state.error = null; listener("thread", value); };
  const paseo: any = { agents: { ref: () => ({ refresh: async () => ({ agent: { provider, workspaceId: "workspace", persistence: { metadata: { pluginProviderPersistence: { version: 1, data: { threadId: "thread" } } } } } }), timeline: { append: async (item: any) => { rows.push(item); } } }) } };
  const hooks = new Map<string, any>();
  const server: any = { handle: (contract: any, fn: any) => { handlers.set(contract.name, fn); }, before: (name: string, fn: any) => hooks.set(name, fn) };
  const close = registerGoalHooks(server, bridge);
  const call = (method: string) => handlers.get(`desktop.goal.${method}`)({ agentId: "agent" }, { paseo });
  return { rows, call, close, push, open: () => hooks.get("agent.session_open")({ request: { provider, agentId: "agent" } }, { paseo }), failPause: () => { failure = true; }, wrongProvider: () => { provider = "codex"; },
    disconnect: () => { state = undefined; bridge.state.revision++; bridge.state.connected = false; disconnect(new Error("Disconnected")); },
    archive: () => archived("thread") };
}
test("Goal events replace one row, retain stale data on disconnect and clear authoritatively", async () => {
  const s = setup();
  const first = await s.call("read"); await tick();
  assert.equal(first.goal.status, "active"); assert.equal(s.rows.length, 1);
  s.push({ threadGoal: goal }); await tick(); assert.equal(s.rows.length, 1);
  s.disconnect(); await tick();
  assert.equal(s.rows.at(-1).data.goal.objective, goal.objective);
  assert.equal(s.rows.at(-1).data.connected, false); assert.equal(s.rows.at(-1).data.canPause, false);
  s.push({ threadGoal: { ...goal, status: "paused" } }); await tick();
  assert.equal(s.rows.at(-1).data.goal.status, "paused"); assert.equal(s.rows.at(-1).data.connected, true);
  s.push({ threadGoal: null, completedThreadGoal: { ...goal, status: "complete" } }); await tick();
  assert.equal(s.rows.at(-1).data.completedGoal.status, "complete");
  s.push({ threadGoal: null, completedThreadGoal: null }); await tick(); assert.equal(s.rows.at(-1).data.goal, null);
  assert.equal(new Set(s.rows.map(row => row.id)).size, 1);
  const count = s.rows.length; s.archive(); s.push({ threadGoal: goal }); await tick(); assert.equal(s.rows.length, count);
  s.close();
});
test("First-turn goals publish from the bridge binding before persistence is committed", async () => {
  const s = setup(); s.open(); s.push({ threadGoal: goal }); await tick();
  assert.equal(s.rows.length, 1); assert.equal(s.rows[0].data.goal.status, "active");
  s.close(); s.push({ threadGoal: null }); await tick(); assert.equal(s.rows.length, 1);
});
test("Goal controls reject other providers and failures do not fabricate paused status", async () => {
  const s = setup(); s.wrongProvider(); await assert.rejects(s.call("read"), /Desktop/); s.close();
  const t = setup(); await t.call("read"); t.failPause(); await assert.rejects(t.call("pause"), /Native pause failed/); await tick();
  assert.equal(t.rows.at(-1).data.goal.status, "active"); t.close();
  const u = setup(); await u.call("read"); const result = await u.call("pause");
  assert.equal(result.goal.status, "paused"); await assert.rejects(u.call("pause"), /活动目标/); u.close();
});
test("Native goal pause uses user-stop without expectedTurnId and propagates goalPauseError", async () => {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\paseo-goal-test-${randomUUID()}` : path.join(os.tmpdir(), `pg-${randomUUID()}.sock`);
  const requests: any[] = []; let pauseError: string | undefined;
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
        if (request.type !== "request") continue;
        requests.push(request);
        const response = { type: "response", requestId: request.requestId, resultType: "success", handledByClientId: "owner", result: request.method === "initialize" ? { clientId: "client" } : { ok: true, ...(pauseError ? { goalPauseError: pauseError } : {}) } };
        const bytes = Buffer.from(JSON.stringify(response)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); socket.write(Buffer.concat([header, bytes]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const events = new DesktopEvents(() => {}, endpoint);
  try {
    await events.pauseGoal("thread"); const request = requests.at(-1);
    assert.equal(request.method, "thread-follower-interrupt-turn"); assert.equal(request.version, 3);
    assert.deepEqual(request.params, { conversationId: "thread", mode: "user-stop" }); assert.equal(request.targetClientId, "owner");
    pauseError = "Goal could not be paused"; await assert.rejects(events.pauseGoal("thread"), /could not be paused/);
    assert.equal(requests.filter(request => request.method === "thread-follower-interrupt-turn").length, 2);
  } finally { events.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
