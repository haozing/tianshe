import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const artifacts = join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });

const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:4173";

const checks = [
  {
    name: "old-entry redirects to new remote",
    url: `${baseUrl}/old-entry/`,
    terms: ["新远程 Web", "Bridge", "店铺管理"]
  },
  {
    name: "new remote renders shell",
    url: `${baseUrl}/new-remote-web/`,
    terms: ["Legacy App Replica", "配置", "诊断"]
  },
  {
    name: "hard fallback renders",
    url: `${baseUrl}/old-entry/legacy/index.html`,
    terms: ["小尊宝兜底入口", "不白屏"]
  }
];

function runEdgeDump(check, index) {
  const outputFile = join(artifacts, `smoke-${index}.html`);
  const chunks = [];
  const errors = [];

  return new Promise((resolveCheck) => {
    const child = spawn(edgePath, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(artifacts, `edge-smoke-profile-${index}`)}`,
      "--virtual-time-budget=8000",
      "--dump-dom",
      check.url
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("exit", (code) => {
      const html = Buffer.concat(chunks).toString("utf8");
      writeFileSync(outputFile, html, "utf8");
      const missing = check.terms.filter((term) => !html.includes(term));
      resolveCheck({
        name: check.name,
        ok: code === 0 && missing.length === 0,
        code,
        url: check.url,
        outputFile,
        missing,
        stderr: Buffer.concat(errors).toString("utf8").split(/\r?\n/).filter(Boolean).slice(0, 5)
      });
    });
  });
}

const results = [];
for (let index = 0; index < checks.length; index += 1) {
  results.push(await runEdgeDump(checks[index], index));
}

writeFileSync(join(artifacts, "headless-result.json"), JSON.stringify(results, null, 2), "utf8");

const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error("SMOKE_FAIL");
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}

console.log("SMOKE_OK");
console.log(JSON.stringify(results.map((result) => ({
  name: result.name,
  url: result.url,
  outputFile: result.outputFile
})), null, 2));

