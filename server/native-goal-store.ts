import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { goalFromNative } from "../shared/goals";

export class NativeGoalStore {
  private watcher?: fs.FSWatcher;
  private listeners = new Set<() => void>();
  private errors = new Set<(error: Error) => void>();
  private queued = false;
  private closed = false;
  constructor(readonly home: string) {}
  subscribe(listener: () => void, onError: (error: Error) => void) {
    if (!this.watcher) {
      this.watcher = fs.watch(this.home, (_event, file) => {
        if (file && !/^goals_1\.sqlite(?:-wal|-shm)?$/.test(String(file))) return;
        if (this.queued || this.closed) return;
        this.queued = true;
        queueMicrotask(() => { this.queued = false; if (!this.closed) for (const listener of this.listeners) listener(); });
      });
      this.watcher.on("error", error => {
        this.watcher?.close(); this.watcher = undefined;
        for (const listener of this.errors) listener(error);
      });
    }
    this.listeners.add(listener); this.errors.add(onError);
    return () => { this.listeners.delete(listener); this.errors.delete(onError); };
  }
  async read(threadId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("Invalid native Codex thread ID");
    const file = path.join(this.home, "goals_1.sqlite");
    if (!fs.existsSync(file)) throw new Error("未找到 Codex 目标数据库，请核对 CODEX_HOME 或 Codex 版本。");
    const { DatabaseSync } = await import("node:sqlite");
    let db: DatabaseSync | undefined;
    try {
      // Never write goals or connect another app-server to an active thread.
      db = new DatabaseSync(file, { readOnly: true });
      const row = db.prepare("SELECT objective,status,token_budget,tokens_used,time_used_seconds,created_at_ms,updated_at_ms FROM thread_goals WHERE thread_id = ?").get(threadId);
      if (!row) return null;
      return goalFromNative({ objective: row.objective, status: row.status, tokenBudget: row.token_budget,
        tokensUsed: row.tokens_used, timeUsedSeconds: row.time_used_seconds,
        createdAt: Number(row.created_at_ms) / 1000, updatedAt: Number(row.updated_at_ms) / 1000 });
    } finally { db?.close(); }
  }
  close() { this.closed = true; this.watcher?.close(); this.watcher = undefined; this.listeners.clear(); this.errors.clear(); }
}
