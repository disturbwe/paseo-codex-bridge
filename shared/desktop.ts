import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const sessionSchema = z.object({id:z.string(),title:z.string(),cwd:z.string().nullable(),status:z.string(),updatedAt:z.number().nullable()});
export const messageSchema = z.object({id:z.string(),role:z.enum(["user","assistant"]),text:z.string(),phase:z.string().nullable()});
export const detailSchema = z.object({threadId:z.string(),title:z.string(),status:z.string(),model:z.string().nullable(),activeTurnId:z.string().nullable(),messages:z.array(messageSchema),revision:z.number()});
export const stateSchema = z.object({connected:z.boolean(),error:z.string().nullable(),revision:z.number(),sessions:z.array(sessionSchema),details:z.record(z.string(),detailSchema),metrics:z.object({rpcRequests:z.number(),ipcRequests:z.number(),events:z.number(),pollingRequests:z.literal(0)})});
export type BridgeState = z.infer<typeof stateSchema>;
export type SessionDetail = z.infer<typeof detailSchema>;
const target = z.object({threadId:z.string().uuid()});
export const bootstrap=defineRpc({name:"desktop.bootstrap",input:z.object({}),output:z.object({eventUrl:z.string(),state:stateSchema})});
export const listSessions=defineRpc({name:"desktop.list",input:z.object({}),output:stateSchema});
export const followSession=defineRpc({name:"desktop.follow",input:target,output:stateSchema});
export const sendMessage=defineRpc({name:"desktop.send",input:target.extend({prompt:z.string().trim().min(1).max(60000)}),output:z.object({accepted:z.boolean(),threadId:z.string()})});
export const interruptSession=defineRpc({name:"desktop.interrupt",input:target,output:z.object({accepted:z.boolean()})});
export const openSession=defineRpc({name:"desktop.open",input:target,output:z.object({accepted:z.boolean()})});
export const watchCompletion=defineRpc({name:"desktop.watch-completion",input:z.object({agentId:z.string().min(1),threadId:z.string().uuid(),verificationId:z.string().min(1).max(120)}),output:z.object({registered:z.boolean()})});
