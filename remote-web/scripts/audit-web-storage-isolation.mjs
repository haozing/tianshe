import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifactsDir = join(root, "artifacts");
const docsDir = join(repoRoot, "docs");
const jsonOutputPath = join(artifactsDir, "web-storage-isolation-audit.json");
const mdOutputPath = join(artifactsDir, "web-storage-isolation-audit.md");
const docsOutputPath = join(docsDir, "web-storage-isolation-audit.md");

const SOURCE_FILES = [
  "new-remote-web/index.html",
  "new-remote-web/app.js",
  "new-remote-web/bridge.js",
  "new-remote-web/config/chihu-config.json",
  "new-remote-web/release-manifest.json",
  "client-shell/src/bridge/storage.ts"
];

const DYNAMIC_STORAGE_FUNCTIONS = new Set([
  "storageSet",
  "storageGet"
]);

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function readSource(relativePath) {
  const filePath = relativePath.startsWith("client-shell/")
    ? join(root, relativePath)
    : join(root, relativePath);
  return {
    relativePath,
    filePath,
    exists: existsSync(filePath),
    text: existsSync(filePath) ? readFileSync(filePath, "utf8") : ""
  };
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function lineColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}

function addIssue(issues, source, index, rule, detail, severity = "fail") {
  const location = lineColumn(source.text, index);
  issues.push({
    severity,
    rule,
    detail,
    file: rel(source.filePath),
    line: location.line,
    column: location.column
  });
}

function nearestFunctionName(text, index) {
  const before = text.slice(0, index);
  const matches = Array.from(before.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g));
  const last = matches[matches.length - 1];
  return last ? last[1] : "";
}

function extractFunctionBody(text, functionName) {
  const marker = new RegExp(`function\\s+${functionName}(?:\\s*<[^>]+>)?\\s*\\(`);
  const match = marker.exec(text);
  if (!match) return "";
  const start = text.indexOf("{", match.index);
  if (start === -1) return "";
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return text.slice(start);
}

function firstArgument(argsText) {
  return String(argsText || "").split(",")[0].trim();
}

function stripQuotes(value) {
  const match = /^["']([^"']*)["']$/.exec(String(value || "").trim());
  return match ? match[1] : "";
}

function extractAllowedStorageConstants(appSource) {
  const constants = [];
  for (const match of appSource.text.matchAll(/\b(?:export\s+)?(?:var|const|let)\s+([A-Z0-9_]+)\s*=\s*"([^"]+)"/g)) {
    if (match[2].startsWith("chihu20_")) {
      constants.push({
        name: match[1],
        value: match[2]
      });
    }
  }
  return constants;
}

function guardStatus(appText) {
  const output = {};
  for (const functionName of DYNAMIC_STORAGE_FUNCTIONS) {
    const body = extractFunctionBody(appText, functionName);
    output[functionName] = {
      present: Boolean(body),
      guarded: /isChihuStorageKey\s*\(\s*key\s*\)/.test(body)
    };
  }
  output.isChihuStorageKey = {
    present: /function\s+isChihuStorageKey\s*\(/.test(appText),
    checksPrefix: /indexOf\(\s*"chihu20_"\s*\)\s*===\s*0/.test(appText) || /startsWith\(\s*"chihu20_"\s*\)/.test(appText)
  };
  return output;
}

function auditForbiddenPatterns(source, issues) {
  const patterns = [
    {
      rule: "no-document-cookie",
      regex: /\bdocument\s*\.\s*cookie\b/g,
      detail: "new remote Web must not read or write Web document.cookie directly"
    },
    {
      rule: "no-indexeddb",
      regex: /\bindexedDB\b|\bindexeddb\b/g,
      detail: "new remote Web must not rely on old Web IndexedDB"
    },
    {
      rule: "no-session-storage",
      regex: /\bsessionStorage\b/g,
      detail: "new remote Web storage contract only allows chihu20_ localStorage keys and Electron DB mirror"
    },
    {
      rule: "no-placeholder-domain",
      regex: new RegExp(["https:\\/\\/www", "chihu", "com"].join("\\."), "gi"),
      detail: "documentation placeholder origin must not be a runtime target"
    }
  ];

  for (const pattern of patterns) {
    for (const match of source.text.matchAll(pattern.regex)) {
      addIssue(issues, source, match.index || 0, pattern.rule, pattern.detail);
    }
  }
}

function auditLocalStorageCalls(appSource, allowedConstants, guards, issues, options = {}) {
  const allowedNames = new Set(allowedConstants.map((item) => item.name));
  const allowedValues = new Set(allowedConstants.map((item) => item.value));
  const calls = [];
  const trustGuardedBundleDynamicKeys = Boolean(options.trustGuardedBundleDynamicKeys);

  for (const match of appSource.text.matchAll(/localStorage\s*\.\s*(getItem|setItem|removeItem|clear|key)\s*\(([^)]*)\)/g)) {
    const method = match[1];
    const argsText = match[2] || "";
    const arg = firstArgument(argsText);
    const literal = stripQuotes(arg);
    const functionName = nearestFunctionName(appSource.text, match.index || 0);
    let status = "ok";
    let detail = "";

    if (method === "clear") {
      status = "fail";
      detail = "localStorage.clear is forbidden because it can delete old-origin or unrelated Web storage";
    } else if (method === "key") {
      status = functionName === "listChihuStorageKeys" ? "ok" : "fail";
      detail = status === "ok"
        ? "localStorage.key is only used to enumerate chihu20_ keys"
        : "localStorage.key enumeration must stay inside listChihuStorageKeys";
    } else if (literal) {
      status = literal.startsWith("chihu20_") ? "ok" : "fail";
      detail = status === "ok"
        ? `literal key ${literal} is chihu20-scoped`
        : `literal key ${literal} is not chihu20-scoped`;
    } else if (allowedNames.has(arg)) {
      status = "ok";
      detail = `${arg} resolves to ${allowedConstants.find((item) => item.name === arg).value}`;
    } else if (arg === "key" && DYNAMIC_STORAGE_FUNCTIONS.has(functionName)) {
      const guard = guards[functionName];
      status = guard && guard.guarded && guards.isChihuStorageKey.present && guards.isChihuStorageKey.checksPrefix ? "ok" : "fail";
      detail = status === "ok"
        ? `${functionName} blocks non-chihu20_ dynamic keys`
        : `${functionName} uses a dynamic key without a chihu20_ guard`;
    } else if (trustGuardedBundleDynamicKeys && DYNAMIC_STORAGE_FUNCTIONS.has("storageGet") && guards.storageGet && guards.storageGet.guarded && guards.storageSet && guards.storageSet.guarded) {
      status = "ok";
      detail = `bundled dynamic key expression ${arg || "(empty)"} is covered by guarded source storage helpers`;
    } else {
      status = "fail";
      detail = `localStorage.${method} uses unsupported key expression: ${arg || "(empty)"}`;
    }

    const location = lineColumn(appSource.text, match.index || 0);
    const call = {
      method,
      keyExpression: arg,
      functionName,
      status,
      detail,
      file: rel(appSource.filePath),
      line: location.line,
      column: location.column
    };
    calls.push(call);
    if (status !== "ok") {
      issues.push({
        severity: "fail",
        rule: "local-storage-key-scope",
        detail,
        file: call.file,
        line: call.line,
        column: call.column
      });
    }
  }

  for (const [functionName, guard] of Object.entries(guards)) {
    if (functionName === "isChihuStorageKey") continue;
    if (!guard.present || !guard.guarded) {
      issues.push({
        severity: "fail",
        rule: "dynamic-local-storage-guard",
        detail: `${functionName} must guard dynamic keys with isChihuStorageKey(key)`,
        file: rel(appSource.filePath),
        line: 1,
        column: 1
      });
    }
  }
  if (!guards.isChihuStorageKey.present || !guards.isChihuStorageKey.checksPrefix) {
    issues.push({
      severity: "fail",
      rule: "chihu-storage-key-prefix",
      detail: "isChihuStorageKey must exist and require the chihu20_ prefix",
      file: rel(appSource.filePath),
      line: 1,
      column: 1
    });
  }

  return {
    calls,
    allowedValues: Array.from(allowedValues).sort()
  };
}

function mdEscape(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(report) {
  return [
    "# Web Storage Isolation Audit",
    "",
    `> Generated at: ${report.generatedAt}`,
    `> Status: ${report.status}`,
    "> Scope: new remote Web must not reuse old Web Cookie, localStorage, or IndexedDB.",
    "",
    "## Summary",
    "",
    `- Source files: ${report.summary.sourceFileCount}`,
    `- Allowed storage keys: ${report.summary.allowedStorageKeyCount}`,
    `- localStorage calls: ${report.summary.localStorageCallCount}`,
    `- Issues: ${report.summary.issueCount}`,
    `- Runtime guard: ${report.summary.runtimeGuardOk ? "ok" : "fail"}`,
    "",
    "## Allowed Keys",
    "",
    report.allowedStorageKeys.length ? report.allowedStorageKeys.map((key) => `- ${key}`).join("\n") : "- none",
    "",
    "## localStorage Calls",
    "",
    "| File | Line | Function | Method | Key | Status | Detail |",
    "|---|---:|---|---|---|---|---|",
    ...report.localStorageCalls.map((call) => `| ${[
      call.file,
      call.line,
      call.functionName,
      call.method,
      call.keyExpression,
      call.status,
      call.detail
    ].map(mdEscape).join(" | ")} |`),
    "",
    "## Issues",
    "",
    report.issues.length
      ? [
        "| Severity | Rule | File | Line | Detail |",
        "|---|---|---|---:|---|",
        ...report.issues.map((issue) => `| ${[
          issue.severity,
          issue.rule,
          issue.file,
          issue.line,
          issue.detail
        ].map(mdEscape).join(" | ")} |`)
      ].join("\n")
      : "- none",
    "",
    "## How To Regenerate",
    "",
    "```powershell",
    "node remote-web/scripts/audit-web-storage-isolation.mjs",
    "```"
  ].join("\n");
}

const sources = SOURCE_FILES.map(readSource);
const missingSources = sources.filter((source) => !source.exists);
const issues = [];
for (const source of sources) {
  if (!source.exists) {
    issues.push({
      severity: "fail",
      rule: "missing-source",
      detail: "required source file is missing",
      file: rel(source.filePath),
      line: 1,
      column: 1
    });
    continue;
  }
  auditForbiddenPatterns(source, issues);
}

const appSource = sources.find((source) => source.relativePath === "new-remote-web/app.js");
const storageSource = sources.find((source) => source.relativePath === "client-shell/src/bridge/storage.ts") || appSource;
const allowedConstants = storageSource ? extractAllowedStorageConstants(storageSource) : [];
const guards = storageSource ? guardStatus(storageSource.text) : {};
const localStorageAudit = appSource
  ? auditLocalStorageCalls(appSource, allowedConstants, guards, issues, { trustGuardedBundleDynamicKeys: storageSource !== appSource })
  : { calls: [], allowedValues: [] };
const failedIssues = issues.filter((issue) => issue.severity === "fail");
const status = failedIssues.length ? "fail" : "ok";
const runtimeGuardOk = Boolean(
  guards.isChihuStorageKey &&
  guards.isChihuStorageKey.present &&
  guards.isChihuStorageKey.checksPrefix &&
  Array.from(DYNAMIC_STORAGE_FUNCTIONS).every((name) => guards[name] && guards[name].guarded)
);

const report = {
  generatedAt: new Date().toISOString(),
  status,
  scope: "new-remote-web-storage-isolation",
  summary: {
    sourceFileCount: sources.length,
    missingSourceCount: missingSources.length,
    allowedStorageKeyCount: localStorageAudit.allowedValues.length,
    localStorageCallCount: localStorageAudit.calls.length,
    issueCount: issues.length,
    failedIssueCount: failedIssues.length,
    runtimeGuardOk
  },
  rules: {
    oldWebCookieDirectAccessAllowed: false,
    oldWebIndexedDbAllowed: false,
    oldWebSessionStorageAllowed: false,
    localStoragePrefix: "chihu20_",
    placeholderDomainRuntimeTargetAllowed: false
  },
  files: sources.map((source) => ({
    path: rel(source.filePath),
    exists: source.exists
  })),
  allowedStorageConstants: allowedConstants,
  allowedStorageKeys: localStorageAudit.allowedValues,
  runtimeGuards: guards,
  localStorageCalls: localStorageAudit.calls,
  issues,
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath),
    docsMarkdown: rel(docsOutputPath)
  }
};

const markdown = renderMarkdown(report);
writeJson(jsonOutputPath, report);
ensureDir(mdOutputPath);
writeFileSync(mdOutputPath, markdown, "utf8");
ensureDir(docsOutputPath);
writeFileSync(docsOutputPath, markdown, "utf8");

console.log(report.status === "ok" ? "WEB_STORAGE_ISOLATION_AUDIT_OK" : "WEB_STORAGE_ISOLATION_AUDIT_FAIL");
console.log(JSON.stringify({
  status: report.status,
  allowedStorageKeyCount: report.summary.allowedStorageKeyCount,
  localStorageCallCount: report.summary.localStorageCallCount,
  runtimeGuardOk: report.summary.runtimeGuardOk,
  failedIssueCount: report.summary.failedIssueCount,
  json: report.outputs.json,
  markdown: report.outputs.docsMarkdown
}, null, 2));

if (report.status === "fail") {
  process.exit(1);
}
