import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settings } from "./config";
type Discovery = { names(directory: string): string[]; socket(file: string): boolean };
const discovery: Discovery = { names: directory => fs.readdirSync(directory), socket: file => { const stat = fs.lstatSync(file); return stat.isSocket() && (process.getuid?.() === undefined || stat.uid === process.getuid?.()); } };
export function toolsEndpoint(platform = process.platform, override = process.env.PASEO_CODEX_BRIDGE_TOOLS_SOCKET ?? settings().toolsSocket, io: Discovery = discovery): string {
  if (override) return override;
  if (platform !== "win32" && platform !== "darwin") throw new Error("仅支持 Windows 和 macOS");
  const directory = platform === "win32" ? "\\\\.\\pipe\\" : "/tmp/codex-app-tools";
  let names: string[];
  try { names = io.names(directory); } catch (error: any) { if (error.code === "ENOENT") throw new Error("请先启动 Codex Desktop"); throw error; }
  const candidates = names.filter(name => platform === "win32" ? name.startsWith("codex-app-tools-") : name.endsWith(".sock") && io.socket(path.posix.join(directory, name)));
  if (candidates.length !== 1) throw new Error(candidates.length ? "发现多个 Desktop socket，请配置 toolsSocket 指定实例。" : "请先启动 Codex Desktop");
  return platform === "win32" ? directory + candidates[0] : path.posix.join(directory, candidates[0]);
}
export function eventsEndpoint(platform = process.platform, override = process.env.PASEO_CODEX_BRIDGE_EVENTS_SOCKET ?? settings().eventsSocket): string {
  if (override) return override;
  if (platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  if (platform !== "darwin") throw new Error("仅支持 Windows 和 macOS");
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const primary = path.join(home, "ipc", "ipc.sock");
  if (fs.existsSync(primary)) return primary;
  const uid = process.getuid?.();
  return path.join(os.tmpdir(), "codex-ipc", uid ? `ipc-${uid}.sock` : "ipc.sock");
}
