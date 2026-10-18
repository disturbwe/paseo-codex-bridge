import type { ProviderModel } from "@getpaseo/plugin/server/provider";

export const desktopDefault: ProviderModel = { id: "desktop", label: "沿用 Desktop 默认模型", isDefault: true };

// Desktop publishes its model allowlist and reasoning options in the app-tool schema.
// Read the live schema instead of maintaining a separate list or using CLI models.
export function modelsFromToolSchema(tool: any): ProviderModel[] {
  const description = tool?.inputSchema?.properties?.model?.description;
  if (typeof description !== "string") throw new Error("Desktop 没有提供模型列表。");
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  const pattern = /([\w./-]+) \((.*?); supported reasoning efforts: ([^)]+)\)/g;
  for (const match of description.matchAll(pattern)) {
    const [, id, label, efforts] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    const options = efforts.split(",").map(effort => effort.trim()).filter(effort => /^[a-z]+$/.test(effort));
    models.push({ id, label: id, description: label, thinkingOptions: options.map(id => ({ id, label: id })) });
  }
  if (!models.length) throw new Error("无法解析当前 Desktop 模型列表；请检查 Desktop 接口是否更新。");
  return [desktopDefault, ...models];
}
