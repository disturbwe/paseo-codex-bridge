import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { NativeGoalStore } from "./native-goal-store";
import { registerNativeGoals } from "./native-goals";
import { goalDuration, goalSummary } from "../shared/goals";

const threadId = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-native-goals-"));
  const file = path.join(directory, "goals_1.sqlite"), writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,objective TEXT,status TEXT,token_budget INTEGER,tokens_used INTEGER,time_used_seconds INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER)");
  writer.prepare("INSERT INTO thread_goals VALUES(?,?,?,?,?,?,?,?)").run(threadId, "Goal set display verification", "active", 20000, 1234, 156527, 100000, 110000);
  const store = new NativeGoalStore(directory);
  return { writer, store, close() { store.close(); writer.close(); for (const name of ["goals_1.sqlite", "goals_1.sqlite-wal", "goals_1.sqlite-shm"]) fs.rmSync(path.join(directory, name), { force: true }); fs.rmdirSync(directory); } };
}
test("Native goal reader restores objective, status, budget and execution time for only the selected thread", async () => {
  const f = fixture();
  try {
    const goal = await f.store.read(threadId);
    assert.equal(goal?.objective, "Goal set display verification"); assert.equal(goal?.status, "active");
    assert.equal(goal?.timeUsedSeconds, 156527); assert.equal(goal?.tokensUsed, 1234); assert.equal(goal?.createdAt, 100);
    assert.equal(await f.store.read("00000000-0000-4000-8000-000000000002"), null);
    await assert.rejects(f.store.read("' OR 1=1 --"), /Invalid/);
    assert.equal(f.writer.prepare("SELECT count(*) AS count FROM thread_goals").get()?.count, 1);
    assert.equal(goalDuration(goal!.timeUsedSeconds!), "1d 19h 28m 47s");
    assert.ok(goalSummary({ goal, completedGoal: null, connected: true, canPause: true, error: null, revision: 1 }).includes(goal!.objective));
  } finally { f.close(); }
});
test("SQLite WAL changes notify the native goal reader without a status timer", async () => {
  const f = fixture();
  try {
    let remove = () => {};
    const changed = new Promise<void>((resolve, reject) => { remove = f.store.subscribe(resolve, reject); });
    f.writer.prepare("UPDATE thread_goals SET status = 'paused', time_used_seconds = 156528 WHERE thread_id = ?").run(threadId);
    await changed; remove(); assert.equal((await f.store.read(threadId))?.status, "paused");
  } finally { f.close(); }
});
test("Native controls delegate /goal commands and wait for authoritative goal changes", async () => {
  const f = fixture(), handlers = new Map<string, any>(), rows: any[] = [], commands: string[] = [];
  let provider = "codex", emit: any = () => {}, fail = false;
  const reference = {
    refresh: async () => ({ agent: { provider, persistence: { nativeHandle: threadId } } }),
    send: async (text: string) => {
      commands.push(text);
      if (fail) { emit({ event: { type: "timeline", item: { type: "assistant_message", text: "Failed to update goal: test error" } } }); return; }
      if (text === "/goal clear") f.writer.prepare("DELETE FROM thread_goals WHERE thread_id = ?").run(threadId);
      else f.writer.prepare("UPDATE thread_goals SET status = ? WHERE thread_id = ?").run(text === "/goal pause" ? "paused" : "active", threadId);
    },
    timeline: { append: async (item: any) => rows.push(item), subscribe: (listener: any) => { emit = listener; const remove = () => { emit = () => {}; }; remove.ready = Promise.resolve(); return remove; } },
  };
  const paseo: any = { agents: { ref: () => reference } };
  const server: any = { handle: (contract: any, fn: any) => handlers.set(contract.name, fn), on: () => {} };
  const close = registerNativeGoals(server, f.store);
  const read = () => handlers.get("codex.goal.read")({ agentId: "agent" }, { paseo });
  const action = (action: string) => handlers.get("codex.goal.action")({ agentId: "agent", action }, { paseo });
  try {
    assert.equal((await read()).goal.status, "active");
    assert.equal((await action("pause")).goal.status, "paused");
    assert.equal((await action("resume")).goal.status, "active");
    fail = true; await assert.rejects(action("pause"), /test error/); assert.equal((await read()).goal.status, "active"); fail = false;
    assert.equal((await action("clear")).goal, null);
    assert.equal(new Set(rows.map(row => row.id)).size, 1);
    assert.deepEqual(commands, ["/goal pause", "/goal resume", "/goal pause", "/goal clear"]);
    provider = "chatgpt-desktop"; await assert.rejects(action("resume"), /原生 Codex/);
    assert.equal(commands.length, 4);
  } finally { close(); f.close(); }
});
test("Native command acknowledgement confirms state even when WAL changes produce no file event", async () => {
  const handlers = new Map<string, any>(); let emit: any = () => {}, reads = 0;
  let goal: any = { objective: "Acknowledgement fallback", status: "active", createdAt: 1, updatedAt: 2 };
  const store: any = { read: async () => { reads++; return goal; }, subscribe: () => () => {}, close() {} };
  const reference = {
    refresh: async () => ({ agent: { provider: "codex", persistence: { nativeHandle: threadId } } }),
    send: async () => { goal = { ...goal, status: "paused" }; emit({ event: { type: "timeline", item: { type: "assistant_message", text: "Goal paused.\n\n" } } }); },
    timeline: { append: async () => {}, subscribe: (listener: any) => { emit = listener; const remove = () => {}; remove.ready = Promise.resolve(); return remove; } },
  };
  const server: any = { handle: (contract: any, fn: any) => handlers.set(contract.name, fn), on() {} };
  const close = registerNativeGoals(server, store);
  try {
    const result = await handlers.get("codex.goal.action")({ agentId: "agent", action: "pause" }, { paseo: { agents: { ref: () => reference } } });
    assert.equal(result.goal.status, "paused");
    assert.equal(reads, 2, "one initial read and one acknowledgement-driven read, without polling");
  } finally { close(); }
});
