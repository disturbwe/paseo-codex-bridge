import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const imageViewData=z.object({callId:z.string(),filePath:z.string(),status:z.string()});
export const imagePreview=defineRpc({name:"desktop.image.preview",input:z.object({agentId:z.string().uuid(),callId:z.string().min(1)}),output:z.object({uri:z.string()})});
