import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
type Json = any;

// Native background subagents have no Desktop window owner. Their persisted
// public item/lifecycle events are followed using filesystem notifications.
export class RolloutReducer {
  readonly state: Json;
  constructor(threadId: string) { this.state = { id: threadId, title: threadId, turns: [], threadRuntimeStatus: { type: "active" } }; }
  accept(row: Json) {
    const event = row.payload;
    if (!event) return;
    if (row.type === "session_meta") { this.state.title = event.agent_nickname ?? this.state.title; this.state.cwd = event.cwd; }
    if (row.type === "turn_context") { this.state.latestModel = event.model; this.state.latestReasoningEffort = event.effort; }
    if (row.type !== "event_msg") return;
    const id = event.turn_id;
    let turn = this.state.turns.find((candidate: Json) => candidate.turnId === id);
    if (event.type === "task_started" && !turn) { turn = { turnId: id, status: "inProgress", items: [] }; this.state.turns.push(turn); this.state.threadRuntimeStatus = { type: "active" }; }
    turn ??= this.state.turns.at(-1);
    if (!turn) return;
    if (event.type === "item_started" || event.type === "item_completed") {
      const native = event.item;
      if (!native) return;
      let item: Json;
      if (native.type === "AgentMessage") item = { type: "agentMessage", id: native.id, text: (native.content ?? []).filter((part: Json) => part.type === "Text").map((part: Json) => part.text).join(""), phase: native.phase };
      else if (native.type === "UserMessage") item = { type: "userMessage", id: native.id, content: (native.content ?? []).map((part: Json) => ({ ...part, type: String(part.type).toLowerCase() })) };
      else if (native.type === "CommandExecution") item = { type: "commandExecution", id: native.id, command: Array.isArray(native.command) ? native.command.map((part: unknown) => JSON.stringify(String(part))).join(" ") : String(native.command ?? ""), cwd: native.cwd, status: native.status === "InProgress" ? "inProgress" : String(native.status).toLowerCase(), aggregatedOutput: native.aggregated_output, exitCode: native.exit_code };
      else if (native.type === "ImageView") item = {type:"imageView",id:native.id,path:native.path,status:event.type === "item_started"?"inProgress":"completed"};
      else if (native.type === "CollabAgentToolCall") item = { type: "collabAgentToolCall", id: native.id, tool: native.tool, status: String(native.status).toLowerCase(), receiverThreadIds: native.receiver_thread_ids ?? [], prompt: native.prompt };
      else return; // Never copy reasoning, developer/system content, or raw response items.
      const index = turn.items.findIndex((current: Json) => current.id === item.id);
      if (index < 0) turn.items.push(item); else turn.items[index] = item;
    }
    if (event.type === "task_complete" || event.type === "turn_aborted") {
      turn.status = event.type === "turn_aborted" ? "interrupted" : "completed";
      this.state.threadRuntimeStatus = { type: "idle" };
      if (event.last_agent_message && !turn.items.some((item: Json) => item.type === "agentMessage" && item.text === event.last_agent_message)) turn.items.push({ type: "agentMessage", id: `final:${turn.turnId}`, text: event.last_agent_message, phase: "final_answer" });
    }
  }
}

export class RolloutFollower {
  private watcher: fs.FSWatcher;
  private offset = 0;
  private remainder = "";
  private disposed = false;
  private reducer: RolloutReducer;
  private decoder = new StringDecoder("utf8");
  constructor(private file: string, threadId: string, private publish: (state: Json) => void, private failed: (error: Error) => void) {
    const root = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
    const resolved = path.resolve(file);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !path.basename(resolved).endsWith(`${threadId}.jsonl`)) throw new Error("Invalid Desktop child rollout path");
    this.reducer = new RolloutReducer(threadId);
    this.watcher = fs.watch(path.dirname(resolved), { persistent: false }, (_event, name) => {
      if (name && String(name) !== path.basename(resolved)) return;
      try { this.read(); } catch (error) { this.failed(error as Error); }
    });
    this.watcher.on("error", failed);
  }
  start() { this.read(); }
  private read() {
    if (this.disposed) return;
    let descriptor: number;
    try { descriptor = fs.openSync(this.file, "r"); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    try {
      const size = fs.fstatSync(descriptor).size;
      if (size < this.offset) throw new Error("Desktop child rollout was truncated; restore the parent agent to reconnect.");
      if (size === this.offset) return;
      if (size - this.offset > 64 * 1024 * 1024) throw new Error("Desktop child history exceeds the supported size");
      const chunk = Buffer.alloc(size - this.offset);
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, this.offset); this.offset += count;
      const text = this.remainder + this.decoder.write(chunk.subarray(0, count));
      const lines = text.split("\n"); this.remainder = lines.pop() ?? "";
      for (const line of lines) { if (line.trim()) this.reducer.accept(JSON.parse(line)); }
      this.publish(this.reducer.state);
    } finally { fs.closeSync(descriptor); }
  }
  close() { this.disposed = true; this.watcher.close(); }
}
