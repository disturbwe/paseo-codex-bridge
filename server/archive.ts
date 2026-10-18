import fs from "node:fs";
import path from "node:path";

export interface ArchiveNode {
  threadId: string; parentThreadId?: string; title?: string; archived?: boolean;
  archivedBy?: string; pending?: { archived: boolean; origin: string }; error?: string;
}
interface ArchiveData { version: 1; intents?: Record<string, boolean>; nodes: Record<string, ArchiveNode>; agents: Record<string, { threadId: string; workspaceId: string | null }> }
interface ArchiveTransport {
  children(threadId: string): Promise<Array<{ threadId: string; title?: string }>>;
  setArchived(threadId: string, archived: boolean): Promise<void>;
  release(threadId: string): void;
}

export class ArchiveSynchronizer {
  private data: ArchiveData;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private transport: ArchiveTransport, private evidence: (event: string, data: unknown) => void) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); if (this.data.version !== 1 || !this.data.nodes || !this.data.agents) throw new Error("Unsupported archive index"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; this.data = { version: 1, nodes: {}, agents: {} }; }
  }
  private save() { fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2)); fs.renameSync(`${this.file}.tmp`, this.file); }
  registerThread(threadId: string, parentThreadId?: string, title?: string) {
    if (!/^[0-9a-f-]{36}$/i.test(threadId) || (parentThreadId && !/^[0-9a-f-]{36}$/i.test(parentThreadId))) throw new Error("Invalid Desktop thread ID");
    const node = this.data.nodes[threadId] ?? { threadId };
    if (parentThreadId) {
      if (threadId === parentThreadId || this.descendants(threadId).some(child => child.threadId === parentThreadId)) throw new Error("Cyclic Desktop parent relationship");
      if (node.parentThreadId && node.parentThreadId !== parentThreadId) throw new Error("Desktop child already belongs to another parent");
    }
    const changed = !this.data.nodes[threadId] || (parentThreadId && node.parentThreadId !== parentThreadId) || (title && node.title !== title);
    if (parentThreadId) node.parentThreadId = parentThreadId;
    if (title) node.title = title;
    this.data.nodes[threadId] = node;
    if (changed) this.save();
  }
  registerAgent(agentId: string, workspaceId: string | null, threadId: string) {
    this.registerThread(threadId);
    this.data.agents[agentId] = { threadId, workspaceId }; this.save();
  }
  agent(agentId: string) { return this.data.agents[agentId]; }
  isArchived(threadId: string) { return this.data.nodes[threadId]?.archived === true; }
  descendants(threadId: string): ArchiveNode[] {
    const result: ArchiveNode[] = [], seen = new Set([threadId]);
    const visit = (id: string) => { for (const node of Object.values(this.data.nodes)) if (node.parentThreadId === id && !seen.has(node.threadId)) { seen.add(node.threadId); result.push({ ...node }); visit(node.threadId); } };
    visit(threadId); return result;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const next = this.serial.then(operation); this.serial = next.catch(() => {}); return next; }
  private async discover(threadId: string, seen = new Set<string>()) {
    if (seen.has(threadId)) return; seen.add(threadId); this.registerThread(threadId);
    if (this.data.nodes[threadId].archived && !this.data.nodes[threadId].pending) return;
    // An explicit archive/list action discovers native descendants once. These
    // history reads are pagination/discovery, never a timed task-status poll.
    for (const child of await this.transport.children(threadId)) this.registerThread(child.threadId, threadId, child.title);
    for (const child of Object.values(this.data.nodes).filter(node => node.parentThreadId === threadId)) await this.discover(child.threadId, seen);
  }
  async listChildren(agentId: string) {
    const agent = this.agent(agentId); if (!agent) return [];
    await this.enqueue(() => this.discover(agent.threadId));
    return this.descendants(agent.threadId);
  }
  archiveChild(agentId: string, childId: string) {
    const agent = this.agent(agentId);
    if (!agent || !this.descendants(agent.threadId).some(node => node.threadId === childId)) throw new Error("此子会话不属于当前 Desktop agent");
    return this.archiveTree(childId);
  }
  archiveTree(threadId: string) {
    return this.enqueue(() => this.archiveNow(threadId));
  }
  private async archiveNow(threadId: string) {
      this.data.intents ??= {}; this.data.intents[threadId] = true; this.save();
      await this.discover(threadId);
      const targets = [...this.descendants(threadId).reverse(), this.data.nodes[threadId]];
      for (const target of targets) {
        const node = this.data.nodes[target.threadId];
        if (node.archived && !node.pending) continue;
        node.pending = { archived: true, origin: threadId };
      }
      this.save(); await this.applyPending(targets.map(node => node.threadId));
      delete this.data.intents[threadId]; this.save();
      return targets.map(node => node.threadId);
  }
  restoreTree(threadId: string) {
    return this.enqueue(async () => {
      this.registerThread(threadId);
      delete this.data.intents?.[threadId];
      const targets = [this.data.nodes[threadId], ...this.descendants(threadId)].filter(node => node.threadId === threadId || node.archivedBy === threadId || node.pending?.origin === threadId);
      for (const target of targets) this.data.nodes[target.threadId].pending = { archived: false, origin: threadId };
      this.save(); await this.applyPending(targets.map(node => node.threadId));
      return targets.map(node => node.threadId);
    });
  }
  async archiveWorkspace(workspaceId: string) {
    const roots = [...new Set(Object.values(this.data.agents).filter(agent => agent.workspaceId === workspaceId).map(agent => agent.threadId))];
    const results = await Promise.allSettled(roots.map(root => this.archiveTree(root)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new Error(`工作区归档同步尚未完成：${failures.map(result => String(result.reason)).join("; ")}`);
    return roots;
  }
  resumePending() { return this.enqueue(async () => {
    const errors: unknown[] = [];
    for (const id of Object.keys(this.data.intents ?? {})) { try { await this.archiveNow(id); } catch (error) { errors.push(error); } }
    const remaining = Object.values(this.data.nodes).filter(node => node.pending && !this.data.intents?.[node.pending.origin]);
    try { await this.applyPending(remaining.map(node => node.threadId)); } catch (error) { errors.push(error); }
    if (errors.length) throw new Error(errors.map(String).join("; "));
  }); }
  private async applyPending(ids: string[]) {
    const failures: string[] = [];
    for (const id of ids) {
      const node = this.data.nodes[id], pending = node.pending;
      if (!pending) continue;
      try {
        await this.transport.setArchived(id, pending.archived);
        node.archived = pending.archived; node.archivedBy = pending.archived ? pending.origin : undefined;
        delete node.pending; delete node.error; this.save();
        if (pending.archived) this.transport.release(id);
        this.evidence("desktop_archive_synced", { threadId: id, archived: node.archived, origin: pending.origin });
      } catch (error) {
        node.error = String(error); this.save(); failures.push(id);
        this.evidence("desktop_archive_pending", { threadId: id, archived: pending.archived, error: String(error) });
      }
    }
    if (failures.length) throw new Error(`${failures.length} 个 Desktop 会话归档同步失败，已保留待处理记录：${failures.join(", ")}`);
  }
}
