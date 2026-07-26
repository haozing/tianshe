import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDoudianScripts } from "../client-shell/src/bridge/doudianScripts.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
};
const adapterPath = resolve(argValue("--adapter") || resolve(root, "client-shell", "public", "config", "doudian-adapter.marketing-pilot.json"));
const outputArg = argValue("--output");
const deployOutputArg = argValue("--deploy-output");
const outputPaths = outputArg || deployOutputArg
  ? [outputArg, deployOutputArg].filter(Boolean).map((value) => resolve(value))
  : [
      resolve(root, "client-shell", "public", "config", "doudian-window-commands.json"),
      resolve(root, "new-remote-web", "config", "doudian-window-commands.json")
    ];
const adapterBuffer = readFileSync(adapterPath);
const adapter = JSON.parse(adapterBuffer.toString("utf8"));
const scripts = buildDoudianScripts(adapter);

const output = {
  schemaVersion: 1,
  version: scripts.version,
  adapterSha256: createHash("sha256").update(adapterBuffer).digest("hex"),
  commands: {
    collectRoleShopNames: scripts.collectRoleShopNames,
    isHomePage: scripts.isHomePage,
    signFactory: scripts.signFactory,
    switchShopFactory: scripts.switchShopFactory
  }
};

const serialized = `${JSON.stringify(output)}\n`;
for (const outputPath of [...new Set(outputPaths)]) writeFileSync(outputPath, serialized, "utf8");
console.log(`DOUDIAN_WINDOW_COMMANDS_OK ${output.version}`);
