export function childSessionId(threadId: string) { return `desktop-child:${threadId}`; }

export interface DesktopChild {
  threadId: string; toolCallId: string; title: string; description?: string;
  rolloutPath?: string;
}

export function childrenFromItem(item: any): DesktopChild[] {
  if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
    return (item.receiverThreadIds ?? []).filter((id: unknown): id is string => typeof id === "string" && id.length > 0).map((threadId: string) => {
      const thread = item.receiverThreads?.find((entry: any) => entry.threadId === threadId)?.thread;
      return { threadId, toolCallId: item.id, title: thread?.agentNickname ?? thread?.name ?? `Desktop 子任务 ${threadId.slice(-8)}`, description: item.prompt, rolloutPath: thread?.path };
    });
  }
  if (item.type === "subAgentActivity" && item.kind === "started" && typeof item.agentThreadId === "string") {
    return [{ threadId: item.agentThreadId, toolCallId: item.id, title: item.agentPath?.split("/").filter(Boolean).at(-1) ?? "Desktop 子任务" }];
  }
  return [];
}
