import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const appJsPath = join(root, "new-remote-web", "app.js");
const require = createRequire(new URL("../client-shell/package.json", import.meta.url));
const JavaScriptObfuscator = require("javascript-obfuscator");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function bytes(filePath) {
  return statSync(filePath).size;
}

if (process.env.CHIHU_REMOTE_OBFUSCATE === "0") {
  console.log("REMOTE_OBFUSCATE_SKIPPED");
  console.log(JSON.stringify({ reason: "CHIHU_REMOTE_OBFUSCATE=0", target: appJsPath }, null, 2));
  process.exit(0);
}

if (!existsSync(appJsPath)) {
  throw new Error(`app.js is missing: ${appJsPath}`);
}

const source = readFileSync(appJsPath, "utf8");
const before = {
  bytes: bytes(appJsPath),
  sha256: sha256(Buffer.from(source, "utf8"))
};

const result = JavaScriptObfuscator.obfuscate(source, {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: "hexadecimal",
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  sourceMap: false,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ["base64"],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.32,
  target: "browser",
  transformObjectKeys: false,
  unicodeEscapeSequence: false
});

const obfuscated = result.getObfuscatedCode();
writeFileSync(appJsPath, obfuscated, "utf8");

const after = {
  bytes: bytes(appJsPath),
  sha256: sha256(Buffer.from(obfuscated, "utf8"))
};

console.log("REMOTE_OBFUSCATE_OK");
console.log(JSON.stringify({
  target: "new-remote-web/app.js",
  before,
  after
}, null, 2));
