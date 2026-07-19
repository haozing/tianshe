import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const artifacts = join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const releaseManifest = JSON.parse(readFileSync(join(root, "new-remote-web", "release-manifest.json"), "utf8"));

const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.BASE_URL || "http://chihu-remote.localhost:4173";
const smokeResultPath = process.env.SMOKE_RESULT_PATH
  ? resolve(process.env.SMOKE_RESULT_PATH)
  : join(artifacts, "headless-result.json");
const smokeOutputPrefix = process.env.SMOKE_OUTPUT_PREFIX || "smoke";

const checks = [
  {
    name: "root redirects to new remote",
    url: `${baseUrl}/?smoke=1`,
    terms: ["赤狐管家", "预警/违规", "获取店铺"],
    selectors: ["data-foundation-shell=\"ready\"", "data-client-shell=\"ready\"", "data-single-entry=\"true\""]
  },
  {
    name: "new remote renders client shell",
    url: `${baseUrl}/new-remote-web/?smoke=1`,
    terms: ["赤狐管家", "预警/违规", "获取店铺"],
    selectors: [
      "data-foundation-shell=\"ready\"",
      "data-client-shell=\"ready\"",
      "data-route-slot=\"ready\"",
      "data-config-status=\"ready\"",
      "data-config-schema=\"1\"",
      "data-storage-health=\"ok\"",
       "data-release-manifest=\"./release-manifest.json\""
    ]
  },
  {
    name: "config error is explicit",
    url: `${baseUrl}/new-remote-web/?configUrl=./config/invalid-config.json&smoke=1`,
    terms: ["Config error", "赤狐管家"],
    selectors: ["data-config-status=\"error\"", "data-single-entry=\"true\""]
  },
  {
    name: "system diagnostics route renders",
    url: `${baseUrl}/new-remote-web/?route=/system/diagnostics&smoke=1`,
    terms: ["Diagnostics", "storage_checked", "manifest_loaded"],
    selectors: ["data-foundation-shell=\"ready\"", "data-route-slot=\"ready\""]
  },
  {
    name: "release manifest loads",
    url: `${baseUrl}/new-remote-web/release-manifest.json`,
    terms: [String(releaseManifest.releaseId || ""), "remote-html", "single active entry"],
    selectors: []
  }
];

function runEdge(check, outputFile) {
  return new Promise((resolveRun) => {
    const profile = mkdtempSync(join(tmpdir(), "chihu-remote-smoke-"));
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=5000",
      `--user-data-dir=${profile}`,
      "--dump-dom",
      check.url
    ];

    const child = spawn(edgePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}

      const html = stdout || stderr;
      writeFileSync(outputFile, html, "utf8");
      const missingTerms = check.terms.filter((term) => !html.includes(term));
      const missingSelectors = check.selectors.filter((selector) => !html.includes(selector));
      resolveRun({
        name: check.name,
        url: check.url,
        ok: code === 0 && missingTerms.length === 0 && missingSelectors.length === 0,
        exitCode: code,
        missingTerms,
        missingSelectors,
        outputFile
      });
    });
  });
}

const results = [];
for (let index = 0; index < checks.length; index += 1) {
  const check = checks[index];
  const outputFile = join(artifacts, `${smokeOutputPrefix}-${String(index + 1).padStart(2, "0")}.html`);
  results.push(await runEdge(check, outputFile));
}

writeFileSync(smokeResultPath, JSON.stringify(results, null, 2), "utf8");

const failed = results.filter((item) => !item.ok);
if (failed.length) {
  console.error("SMOKE_FAIL");
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}

console.log("SMOKE_OK");
console.log(JSON.stringify({
  count: results.length,
  resultPath: smokeResultPath
}, null, 2));

if (existsSync(smokeResultPath)) {
  JSON.parse(readFileSync(smokeResultPath, "utf8"));
}
