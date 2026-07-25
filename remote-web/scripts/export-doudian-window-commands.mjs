import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDoudianScripts } from "../client-shell/src/bridge/doudianScripts.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const adapterPath = resolve(root, "client-shell", "public", "config", "doudian-adapter.marketing-pilot.json");
const outputPath = resolve(root, "client-shell", "public", "config", "doudian-window-commands.json");
const deployOutputPath = resolve(root, "new-remote-web", "config", "doudian-window-commands.json");
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
writeFileSync(outputPath, serialized, "utf8");
writeFileSync(deployOutputPath, serialized, "utf8");
console.log(`DOUDIAN_WINDOW_COMMANDS_OK ${output.version}`);
