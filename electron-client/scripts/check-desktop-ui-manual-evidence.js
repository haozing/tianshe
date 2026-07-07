const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const repoRoot = path.resolve(root, "..");
const artifactsDir = path.join(root, "artifacts");
const docsDir = path.join(repoRoot, "docs");
const evidencePath = path.join(artifactsDir, "desktop-ui-manual-evidence.json");
const uiContractSmokePath = path.join(artifactsDir, "smoke-ui-contract.json");
const templatePath = path.join(artifactsDir, "desktop-ui-manual-evidence.template.json");
const jsonOutputPath = path.join(artifactsDir, "desktop-ui-manual-evidence-check.json");
const mdOutputPath = path.join(artifactsDir, "desktop-ui-manual-evidence-check.md");
const docsMdOutputPath = path.join(docsDir, "electron-desktop-ui-manual-evidence.md");
const packageJson = require("../package.json");

const REQUIRED_CHECKS = [
  {
    key: "selectDirectoryDialog",
    title: "Real selectDirectory dialog",
    expected: "A native directory picker opens, user selects a directory, and the selected path is returned.",
    evidenceHint: "Set evidence.selectedPath to the chosen directory."
  },
  {
    key: "openDirectoryInExplorer",
    title: "Real openPathInExplorer directory",
    expected: "An existing directory opens in Windows Explorer.",
    evidenceHint: "Set evidence.targetPath to the directory that opened."
  },
  {
    key: "openFileInExplorer",
    title: "Real openPathInExplorer file",
    expected: "An existing file is selected or revealed in Windows Explorer.",
    evidenceHint: "Set evidence.targetPath to the file that was revealed."
  },
  {
    key: "systemNotificationShown",
    title: "Real system notification shown",
    expected: "A real system notification is displayed with the expected title/body/icon.",
    evidenceHint: "Set evidence.notificationTitle and evidence.notes."
  },
  {
    key: "systemNotificationClickEvent",
    title: "Real system notification click",
    expected: "Clicking the notification emits the expected app event and does not break focus/routing.",
    evidenceHint: "Set evidence.clickEventObserved to true."
  }
];

function parseArgs(argv) {
  return {
    requireComplete: argv.includes("--require-complete")
  };
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPassed(value) {
  return String(value || "").toLowerCase() === "passed";
}

function isFailed(value) {
  return ["failed", "fail"].includes(String(value || "").toLowerCase());
}

function uiContractSmokePassed(smoke) {
  const result = smoke && smoke.result || {};
  const ui = result.uiContract || {};
  return Boolean(
    smoke &&
    smoke.scenario === "ui-contract" &&
    smoke.ok === true &&
    result.scenario === "ui-contract" &&
    result.ok === true &&
    result.uiContractOk === true &&
    ui.selectDirectoryOk === true &&
    ui.openExistingDirectoryOk === true &&
    ui.openExistingFileOk === true &&
    ui.notificationContractOk === true
  );
}

function precheckStatus(evidence, uiContractSmoke) {
  if (uiContractSmokePassed(uiContractSmoke)) {
    return {
      passed: true,
      source: "smoke-ui-contract",
      artifact: rel(uiContractSmokePath)
    };
  }
  if (evidence && evidence.precheck && evidence.precheck.passed === true) {
    return {
      passed: true,
      source: "manual-evidence",
      artifact: ""
    };
  }
  return {
    passed: false,
    source: "",
    artifact: fs.existsSync(uiContractSmokePath) ? rel(uiContractSmokePath) : ""
  };
}

function createTemplate() {
  return {
    schemaVersion: 1,
    scope: "electron-desktop-ui-manual",
    createdAt: new Date().toISOString(),
    appVersion: packageJson.version,
    reviewer: "",
    executedAt: "",
    environment: {
      os: process.platform,
      appTitle: "赤狐管家",
      notes: ""
    },
    precheck: {
      command: "npm run smoke:ui-contract",
      passed: false,
      notes: ""
    },
    instructions: [
      "Run npm run smoke:ui-contract first; it writes electron-client/artifacts/smoke-ui-contract.json and only proves the dry-run contract.",
      "Run npm run record:desktop-ui-manual-evidence to open the visible Electron evidence collector.",
      "Only let a check status become passed after observing the real native UI behavior.",
      "Do not store Cookie, Authorization, tokens, or customer data in this evidence file."
    ],
    checks: REQUIRED_CHECKS.map((check) => ({
      key: check.key,
      title: check.title,
      status: "pending",
      expected: check.expected,
      evidenceHint: check.evidenceHint,
      evidence: {
        selectedPath: "",
        targetPath: "",
        notificationTitle: "",
        clickEventObserved: false,
        screenshot: "",
        notes: ""
      }
    })),
    redaction: {
      cookieValuesIncluded: false,
      tokenValuesIncluded: false,
      customerDataIncluded: false
    }
  };
}

function evidenceFieldsOk(key, evidence) {
  const data = evidence || {};
  if (key === "selectDirectoryDialog") {
    return hasText(data.selectedPath) || hasText(data.notes);
  }
  if (key === "openDirectoryInExplorer" || key === "openFileInExplorer") {
    return hasText(data.targetPath) || hasText(data.notes);
  }
  if (key === "systemNotificationShown") {
    return hasText(data.notificationTitle) || hasText(data.notes);
  }
  if (key === "systemNotificationClickEvent") {
    return data.clickEventObserved === true || hasText(data.notes);
  }
  return hasText(data.notes);
}

function buildReport(args, evidence, uiContractSmoke) {
  const failures = [];
  const warnings = [];
  const checks = [];
  const precheck = precheckStatus(evidence, uiContractSmoke);

  if (!evidence) {
    warnings.push("manual evidence file is missing");
  } else {
    if (evidence.schemaVersion !== 1) failures.push("schemaVersion must be 1");
    if (evidence.scope !== "electron-desktop-ui-manual") failures.push("scope must be electron-desktop-ui-manual");
    if (!hasText(evidence.reviewer)) warnings.push("reviewer is missing");
    if (!hasText(evidence.executedAt)) warnings.push("executedAt is missing");
    if (evidence.redaction && (evidence.redaction.cookieValuesIncluded || evidence.redaction.tokenValuesIncluded || evidence.redaction.customerDataIncluded)) {
      failures.push("manual evidence must not include cookies, tokens, or customer data");
    }
  }
  if (!precheck.passed) {
    warnings.push("precheck npm run smoke:ui-contract has not produced a passing dry-run artifact");
  }

  const byKey = new Map(((evidence && evidence.checks) || []).map((check) => [check.key, check]));
  for (const required of REQUIRED_CHECKS) {
    const check = byKey.get(required.key);
    if (!check) {
      checks.push({
        key: required.key,
        title: required.title,
        status: "missing",
        evidenceComplete: false,
        detail: "required check is missing"
      });
      warnings.push(`missing required check: ${required.key}`);
      continue;
    }

    const evidenceComplete = evidenceFieldsOk(required.key, check.evidence);
    const status = isPassed(check.status) && evidenceComplete
      ? "passed"
      : isFailed(check.status)
        ? "failed"
        : "pending";
    const detail = status === "passed"
      ? "manual evidence accepted"
      : isFailed(check.status)
        ? "manual check is marked failed"
        : evidenceComplete
          ? `status is ${check.status || "missing"}`
          : "required evidence fields are incomplete";

    checks.push({
      key: required.key,
      title: required.title,
      status,
      evidenceComplete,
      detail
    });

    if (status === "failed") failures.push(`${required.key} is marked failed`);
    if (status !== "passed") warnings.push(`${required.key} is not complete: ${detail}`);
  }

  if (args.requireComplete && warnings.length) {
    failures.push("--require-complete requested but manual desktop UI evidence is incomplete");
  }

  const failed = Array.from(new Set(failures));
  const warned = Array.from(new Set(warnings));
  const status = failed.length ? "fail" : warned.length ? "warn" : "ok";

  return {
    generatedAt: new Date().toISOString(),
    status,
    scope: "electron-desktop-ui-manual",
    strict: {
      requireComplete: args.requireComplete
    },
    inputs: {
      evidence: fs.existsSync(evidencePath) ? rel(evidencePath) : "",
      uiContractSmoke: fs.existsSync(uiContractSmokePath) ? rel(uiContractSmokePath) : "",
      template: rel(templatePath)
    },
    outputs: {
      json: rel(jsonOutputPath),
      markdown: rel(mdOutputPath),
      docsMarkdown: rel(docsMdOutputPath)
    },
    summary: {
      requiredCheckCount: REQUIRED_CHECKS.length,
      passedCheckCount: checks.filter((check) => check.status === "passed").length,
      missingCheckCount: checks.filter((check) => check.status === "missing").length,
      failedCheckCount: checks.filter((check) => check.status === "failed").length,
      reviewer: evidence && evidence.reviewer || "",
      executedAt: evidence && evidence.executedAt || "",
      precheckPassed: precheck.passed,
      precheckSource: precheck.source,
      precheckArtifact: precheck.artifact
    },
    checks,
    failures: failed,
    warnings: warned,
    redaction: {
      cookieValuesIncluded: false,
      tokenValuesIncluded: false,
      customerDataIncluded: false
    }
  };
}

function mdEscape(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(report) {
  return [
    "# Electron Desktop UI Manual Evidence",
    "",
    `> Generated at: ${report.generatedAt}`,
    `> Status: ${report.status}`,
    "> This report tracks real native desktop UI acceptance; dry-run smoke alone is not enough.",
    "",
    "## Summary",
    "",
    `- Passed checks: ${report.summary.passedCheckCount}/${report.summary.requiredCheckCount}`,
    `- Missing checks: ${report.summary.missingCheckCount}`,
    `- Failed checks: ${report.summary.failedCheckCount}`,
    `- Reviewer: ${report.summary.reviewer || "missing"}`,
    `- Executed at: ${report.summary.executedAt || "missing"}`,
    `- Precheck smoke marked passed: ${report.summary.precheckPassed ? "yes" : "no"}`,
    `- Precheck source: ${report.summary.precheckSource || "missing"}`,
    "",
    "## Checks",
    "",
    "| Key | Title | Status | Evidence Complete | Detail |",
    "|---|---|---|---|---|",
    ...report.checks.map((check) => `| ${[
      check.key,
      check.title,
      check.status,
      check.evidenceComplete ? "yes" : "no",
      check.detail
    ].map(mdEscape).join(" | ")} |`),
    "",
    "## Failures And Warnings",
    "",
    report.failures.length ? report.failures.map((item) => `- failure: ${item}`).join("\n") : "- failure: none",
    report.warnings.length ? report.warnings.map((item) => `- warning: ${item}`).join("\n") : "- warning: none",
    "",
    "## How To Complete",
    "",
    "```powershell",
    "cd electron-client",
    "npm run smoke:ui-contract",
    "npm run record:desktop-ui-manual-evidence",
    "npm run check:desktop-ui-manual-evidence",
    "```",
    "",
    `The recorder saves completed manual evidence as electron-client/artifacts/desktop-ui-manual-evidence.json. The template is still available at ${report.inputs.template}. Then run strict mode:`,
    "",
    "```powershell",
    "cd electron-client",
    "npm run check:desktop-ui-manual-ready",
    "```",
    "",
    "## Outputs",
    "",
    `- JSON: ${report.outputs.json}`,
    `- Markdown: ${report.outputs.docsMarkdown}`
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const template = createTemplate();
if (!fs.existsSync(templatePath)) {
  writeJson(templatePath, template);
}

const evidence = readJsonIfExists(evidencePath);
const uiContractSmoke = readJsonIfExists(uiContractSmokePath);
const report = buildReport(args, evidence, uiContractSmoke);
const markdown = renderMarkdown(report);

writeJson(jsonOutputPath, report);
ensureDir(mdOutputPath);
fs.writeFileSync(mdOutputPath, markdown, "utf8");
ensureDir(docsMdOutputPath);
fs.writeFileSync(docsMdOutputPath, markdown, "utf8");

const label = report.status === "ok"
  ? "DESKTOP_UI_MANUAL_EVIDENCE_OK"
  : report.status === "warn"
    ? "DESKTOP_UI_MANUAL_EVIDENCE_WARN"
    : "DESKTOP_UI_MANUAL_EVIDENCE_FAIL";

console.log(label);
console.log(JSON.stringify({
  status: report.status,
  passedCheckCount: report.summary.passedCheckCount,
  requiredCheckCount: report.summary.requiredCheckCount,
  precheckPassed: report.summary.precheckPassed,
  precheckSource: report.summary.precheckSource,
  failedCount: report.failures.length,
  warningCount: report.warnings.length,
  json: report.outputs.json,
  markdown: report.outputs.docsMarkdown
}, null, 2));

if (report.status === "fail") {
  process.exit(1);
}
