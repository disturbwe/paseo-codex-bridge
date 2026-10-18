import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const child = z.object({ threadId: z.string().uuid(), title: z.string(), archived: z.boolean(), pending: z.boolean(), error: z.string().nullable() });
export const archiveChildren = defineRpc({ name: "desktop.archive.children", input: z.object({ agentId: z.string().uuid() }), output: z.object({ children: z.array(child) }) });
export const archiveChild = defineRpc({ name: "desktop.archive.child", input: z.object({ agentId: z.string().uuid(), threadId: z.string().uuid() }), output: z.object({ archivedThreadIds: z.array(z.string()) }) });
