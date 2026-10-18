import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const goalSchema = z.object({
  objective: z.string(), status: z.string(),
  createdAt: z.number().nullable(), updatedAt: z.number().nullable(),
});
export const goalStateSchema = z.object({
  goal: goalSchema.nullable(), completedGoal: goalSchema.nullable(),
  connected: z.boolean(), canPause: z.boolean(), error: z.string().nullable(),
  revision: z.number(),
});
export type GoalState = z.infer<typeof goalStateSchema>;
export const readGoal = defineRpc({ name: "desktop.goal.read", input: z.object({ agentId: z.string().min(1) }), output: goalStateSchema });
export const pauseGoal = defineRpc({ name: "desktop.goal.pause", input: z.object({ agentId: z.string().min(1) }), output: goalStateSchema });
export const openGoal = defineRpc({ name: "desktop.goal.open", input: z.object({ agentId: z.string().min(1) }), output: z.object({ accepted: z.boolean() }) });

// Explicit projection: never forward raw conversation state or private tool data.
export function goalFromNative(value: unknown): z.infer<typeof goalSchema> | null {
  if (!value || typeof value !== "object") return null;
  const goal = value as Record<string, unknown>;
  if (typeof goal.objective !== "string" || typeof goal.status !== "string") return null;
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
  return { objective: goal.objective, status: goal.status, createdAt: number(goal.createdAt), updatedAt: number(goal.updatedAt) };
}
export function goalFromState(state: Record<string, unknown> | undefined, revision: number, connected = true, error: string | null = null): GoalState {
  const goal = goalFromNative(state?.threadGoal);
  return { goal, completedGoal: goalFromNative(state?.completedThreadGoal), connected,
    canPause: connected && goal?.status === "active", error, revision };
}
export function goalLabel(state: GoalState | null): string {
  if (!state) return "目标 · 读取中";
  if (!state.connected) return "目标 · 未同步";
  const goal = state.goal ?? state.completedGoal;
  if (!goal) return "目标 · 未设置";
  const labels: Record<string, string> = { active: "进行中", paused: "已暂停", complete: "已完成", blocked: "受阻", budgetLimited: "达到预算", usageLimited: "达到用量限制", budget_limited: "达到预算", usage_limited: "达到用量限制" };
  return `目标 · ${labels[goal.status] ?? goal.status}`;
}
