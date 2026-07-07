import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUploadAudit, writeUploadAudit } from "./diagnostic-upload-store.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const artifacts = join(root, "artifacts");

function parseArgs(argv) {
  const result = {
    uploadDir: "",
    output: join(artifacts, "diagnostic-upload-audit.json"),
    markdown: join(artifacts, "diagnostic-upload-audit.md"),
    requirePair: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--upload-dir") {
      result.uploadDir = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--upload-dir=")) {
      result.uploadDir = arg.slice("--upload-dir=".length);
      continue;
    }
    if (arg === "--output") {
      result.output = argv[index + 1] || result.output;
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      result.markdown = argv[index + 1] || result.markdown;
      index += 1;
      continue;
    }
    if (arg === "--no-require-pair") {
      result.requirePair = false;
      continue;
    }
  }

  return result;
}

const args = parseArgs(process.argv.slice(2));
const audit = buildUploadAudit({
  uploadDir: args.uploadDir,
  requirePair: args.requirePair
});
const outputs = writeUploadAudit(audit, {
  jsonPath: args.output,
  mdPath: args.markdown
});

console.log("DIAGNOSTIC_UPLOAD_AUDIT_" + audit.status.toUpperCase());
console.log(JSON.stringify({
  status: audit.status,
  count: audit.count,
  redactedCount: audit.redactedCount,
  byType: audit.byType,
  issues: audit.issues,
  warnings: audit.warnings,
  json: outputs.jsonPath,
  markdown: outputs.mdPath
}, null, 2));

if (audit.status === "fail") {
  process.exit(1);
}
