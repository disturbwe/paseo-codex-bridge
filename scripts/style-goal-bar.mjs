import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { patchGoalBarBundle, goalStyleMarker } from "./goal-bar-style.mjs";

const args = process.argv.slice(2), flag = args.indexOf("--app-root");
const explicit = flag >= 0 ? args[flag + 1] : undefined;
if (flag >= 0 && (!explicit || explicit.startsWith("--"))) throw new Error("--app-root requires a Paseo resources directory.");
const restore = args.includes("--restore"), dryRun = args.includes("--dry-run");
const candidates = explicit ? [path.resolve(explicit)] : process.platform === "win32" ? [
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Paseo", "resources"),
  path.join(process.env.ProgramFiles ?? "C:/Program Files", "Paseo", "resources"),
] : [];
if (!explicit && process.platform === "darwin") throw new Error("For macOS use --app-root with an unsigned development build's Resources directory; signed apps are not modified automatically.");
const roots = candidates.filter(root => fs.existsSync(path.join(root, "app-dist", "_expo", "static", "js", "web")));
if (roots.length !== 1) throw new Error("Specify exactly one Paseo resources directory with --app-root.");
if (process.platform === "darwin" && roots[0].includes(".app/Contents/Resources") && !args.includes("--unsigned-build")) throw new Error("Modifying a signed .app invalidates its signature. Use an unsigned development build and pass --unsigned-build explicitly.");
const directory = path.join(roots[0], "app-dist", "_expo", "static", "js", "web");
const matches = [];
for (const name of fs.readdirSync(directory).filter(name => /^index-.*\.js$/.test(name))) {
  const file = path.join(directory, name), source = fs.readFileSync(file, "utf8");
  if (!source.includes("PluginComposerPills")) continue;
  if (restore) {
    const backup = file + ".paseo-codex-bridge.backup";
    if (!source.includes(goalStyleMarker) || !fs.existsSync(backup)) continue;
    matches.push({ file, source: fs.readFileSync(backup, "utf8"), backup, changed: true });
  } else matches.push({ file, backup: file + ".paseo-codex-bridge.backup", ...patchGoalBarBundle(source) });
}
if (matches.length !== 1) throw new Error("Expected exactly one supported Paseo UI bundle; no files changed.");
const result = matches[0];
if (result.changed && !dryRun) {
  if (!restore) {
    if (!fs.existsSync(result.backup)) fs.writeFileSync(result.backup, fs.readFileSync(result.file), { flag: "wx" });
    else if (fs.readFileSync(result.backup, "utf8") !== fs.readFileSync(result.file, "utf8")) throw new Error("Existing backup differs from the unpatched bundle; no files changed.");
  }
  const temporary = result.file + ".paseo-codex-bridge.tmp";
  fs.writeFileSync(temporary, result.source); fs.renameSync(temporary, result.file);
}
console.log(JSON.stringify({ action: restore ? "restore" : "apply", dryRun, changed: result.changed,
  bundle: result.file, sha256: crypto.createHash("sha256").update(result.source).digest("hex"),
  scope: "paseo-codex-desktop composer goal controls only", reloadRequired: result.changed && !dryRun }));
