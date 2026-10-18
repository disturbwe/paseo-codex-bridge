import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { goalStateSchema } from "./goals";
export const readNativeGoal = defineRpc({ name: "codex.goal.read", input: z.object({ agentId: z.string().min(1) }), output: goalStateSchema });
export const nativeGoalAction = defineRpc({ name: "codex.goal.action", input: z.object({ agentId: z.string().min(1), action: z.enum(["pause", "resume", "clear"]) }), output: goalStateSchema });
