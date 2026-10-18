import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const DATA_DIRECTORY = process.env.PASEO_CODEX_BRIDGE_DATA_DIR ?? path.join(process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"), "plugin-data", "paseo-codex-bridge");
export function settings(): { callerThreadId?: string; toolsSocket?: string; eventsSocket?: string } {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIRECTORY, "config.json"), "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") return {}; throw error; }
}
export function callerThreadId() {
  const id = process.env.PASEO_CODEX_BRIDGE_CALLER_THREAD_ID ?? settings().callerThreadId ?? process.env.CODEX_THREAD_ID;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("请先配置 Codex Desktop callerThreadId，参见 README 的连接设置。");
  return id;
}
