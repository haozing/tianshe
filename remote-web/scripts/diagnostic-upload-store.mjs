import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const defaultArtifacts = join(root, "artifacts");
const defaultUploadDir = join(defaultArtifacts, "diagnostic-upload-inbox");

const packageTypeByQueueType = {
  "diagnostic-ticket": "chihu-diagnostic-ticket",
  "data-repair-ticket": "chihu-data-repair-ticket"
};

const sensitiveKeyPattern = /(^|[-_.])(cookie|authorization|token|csrf|session|set-cookie|x-csrftoken)([-_.]|$)/i;
const sensitiveValuePattern = /(sessionid|passport_csrf|csrf_token|authorization|bearer|set-cookie)\s*[:=]\s*[^,\s"']{4,}/i;

export function resolveUploadDir(uploadDir) {
  return resolve(uploadDir || process.env.LIEHU_DIAGNOSTIC_UPLOAD_DIR || defaultUploadDir);
}

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeName(value) {
  return String(value || "unknown").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "unknown";
}

function readJsonSafe(filePath, defaultValue) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return defaultValue;
  }
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

export function simpleDigest(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isAllowedRedactionPath(pathParts) {
  return pathParts.includes("redaction") ||
    pathParts.includes("forbidden") ||
    pathParts.includes("loginSignals") ||
    pathParts.includes("rateLimitSignals") ||
    pathParts.includes("nextActions");
}

function scanSensitive(value, pathParts = [], findings = []) {
  if (value == null) {
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitive(item, pathParts.concat(String(index)), findings));
    return findings;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = pathParts.concat(key);
      if (sensitiveKeyPattern.test(key) && !isAllowedRedactionPath(nextPath)) {
        const text = typeof child === "string" ? child : JSON.stringify(child);
        if (text && !/^\[REDACTED/i.test(text) && text !== "true" && text !== "false") {
          findings.push({
            path: nextPath.join("."),
            reason: "sensitive-looking key carries a non-redacted value"
          });
        }
      }
      scanSensitive(child, nextPath, findings);
    }
    return findings;
  }

  if (typeof value === "string" && !isAllowedRedactionPath(pathParts) && sensitiveValuePattern.test(value)) {
    findings.push({
      path: pathParts.join("."),
      reason: "sensitive-looking value pattern"
    });
  }

  return findings;
}

export function validateDiagnosticUpload(payload, headers = {}) {
  const issues = [];
  const warnings = [];
  const type = payload && payload.type || headers["x-chihu-package-type"] || "";
  const expectedPackageType = packageTypeByQueueType[type] || "";
  const bodyPayload = payload && payload.payload || {};
  const actualPackageType = bodyPayload && bodyPayload.packageType || "";

  if (!payload || typeof payload !== "object") {
    issues.push("payload must be a JSON object");
  }
  if (payload && payload.queueVersion !== 1) {
    issues.push("queueVersion must be 1");
  }
  if (payload && payload.source !== "new-remote-web") {
    issues.push("source must be new-remote-web");
  }
  if (payload && payload.scope !== "clean-foundation") {
    issues.push("scope must be clean-foundation");
  }
  if (!packageTypeByQueueType[type]) {
    issues.push(`type must be one of ${Object.keys(packageTypeByQueueType).join(", ")}`);
  }
  if (expectedPackageType && actualPackageType !== expectedPackageType) {
    issues.push(`payload.packageType must be ${expectedPackageType}`);
  }
  if (!payload || !payload.itemId) {
    issues.push("itemId is required");
  }
  if (!payload || !payload.payloadDigest) {
    issues.push("payloadDigest is required");
  }
  if (!payload || !payload.redaction || payload.redaction.enabled !== true) {
    issues.push("top-level redaction.enabled must be true");
  }
  if (!bodyPayload || !bodyPayload.redaction || bodyPayload.redaction.enabled !== true) {
    issues.push("payload.redaction.enabled must be true");
  }
  if (bodyPayload && bodyPayload.scope !== "clean-foundation") {
    issues.push("payload.scope must be clean-foundation");
  }
  if (bodyPayload && bodyPayload.source !== "new-remote-web") {
    issues.push("payload.source must be new-remote-web");
  }

  const sensitiveFindings = scanSensitive(payload);
  for (const finding of sensitiveFindings) {
    issues.push(`${finding.path}: ${finding.reason}`);
  }

  if (headers["x-chihu-package-type"] && headers["x-chihu-package-type"] !== type) {
    warnings.push("X-Chihu-Package-Type does not match payload.type");
  }
  if (!headers["x-chihu-upload-source"]) {
    warnings.push("X-Chihu-Upload-Source header is missing");
  }
  return {
    ok: issues.length === 0,
    type,
    expectedPackageType,
    actualPackageType,
    issues,
    warnings
  };
}

export function storeDiagnosticUpload(payload, options = {}) {
  const uploadDir = resolveUploadDir(options.uploadDir);
  const headers = options.headers || {};
  const bodyText = options.bodyText || JSON.stringify(payload);
  const receivedAt = new Date();
  const validation = validateDiagnosticUpload(payload, headers);
  const itemId = payload && payload.itemId || "";
  const type = validation.type || "unknown";
  const fileName = `${nowStamp(receivedAt)}-${safeName(type)}-${safeName(itemId)}.json`;
  const filePath = join(uploadDir, fileName);
  const record = {
    receivedAt: receivedAt.toISOString(),
    itemId,
    type,
    packageType: validation.actualPackageType,
    source: payload && payload.source || "",
    scope: payload && payload.scope || "",
    bytes: Buffer.byteLength(bodyText, "utf8"),
    clientPayloadDigest: payload && payload.payloadDigest || "",
    serverPayloadDigest: simpleDigest(payload && payload.payload || {}),
    bodyDigest: simpleDigest(bodyText),
    redacted: validation.issues.length === 0,
    validation,
    headers: {
      "content-type": headers["content-type"] || "",
      "x-chihu-package-type": headers["x-chihu-package-type"] || "",
      "x-chihu-upload-source": headers["x-chihu-upload-source"] || ""
    },
    payload: payload && payload.payload || null
  };

  writeJson(filePath, record);

  const indexPath = join(uploadDir, "index.json");
  const index = readJsonSafe(indexPath, {
    version: 1,
    updatedAt: "",
    records: []
  });
  index.updatedAt = receivedAt.toISOString();
  index.records = [
    {
      receivedAt: record.receivedAt,
      itemId: record.itemId,
      type: record.type,
      packageType: record.packageType,
      bytes: record.bytes,
      redacted: record.redacted,
      issueCount: record.validation.issues.length,
      warningCount: record.validation.warnings.length,
      file: relative(uploadDir, filePath).replace(/\\/g, "/")
    },
    ...index.records.filter((item) => item.file !== fileName)
  ].slice(0, 200);
  writeJson(indexPath, index);

  return {
    ok: validation.ok,
    uploadDir,
    filePath,
    record
  };
}

export function buildUploadAudit(options = {}) {
  const uploadDir = resolveUploadDir(options.uploadDir);
  const indexPath = join(uploadDir, "index.json");
  const index = readJsonSafe(indexPath, {
    version: 1,
    updatedAt: "",
    records: []
  });
  const records = (index.records || []).map((entry) => {
    const recordPath = join(uploadDir, entry.file);
    const record = readJsonSafe(recordPath, null);
    return record ? { entry, record, recordPath } : { entry, record: null, recordPath };
  });

  const byType = {};
  const byPackageType = {};
  const issues = [];
  const warnings = [];
  let redactedCount = 0;
  let totalBytes = 0;

  for (const item of records) {
    if (!item.record) {
      issues.push(`${item.entry.file}: missing stored record`);
      continue;
    }
    const record = item.record;
    byType[record.type] = (byType[record.type] || 0) + 1;
    byPackageType[record.packageType] = (byPackageType[record.packageType] || 0) + 1;
    totalBytes += Number(record.bytes || 0);
    if (record.redacted) redactedCount += 1;
    for (const issue of record.validation.issues || []) {
      issues.push(`${item.entry.file}: ${issue}`);
    }
    for (const warning of record.validation.warnings || []) {
      warnings.push(`${item.entry.file}: ${warning}`);
    }
  }

  if (options.requirePair !== false) {
    if (!byType["diagnostic-ticket"]) {
      issues.push("missing diagnostic-ticket upload");
    }
    if (!byType["data-repair-ticket"]) {
      issues.push("missing data-repair-ticket upload");
    }
  }

  const status = issues.length ? "fail" : (warnings.length ? "warn" : "ok");
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    uploadDir,
    status,
    count: records.length,
    redactedCount,
    totalBytes,
    byType,
    byPackageType,
    issues,
    warnings,
    latest: records.slice(0, 10).map((item) => ({
      file: item.entry.file,
      itemId: item.entry.itemId,
      type: item.entry.type,
      packageType: item.entry.packageType,
      bytes: item.entry.bytes,
      redacted: item.entry.redacted,
      issueCount: item.entry.issueCount,
      warningCount: item.entry.warningCount,
      receivedAt: item.entry.receivedAt
    })),
    productionContract: {
      acceptedTypes: Object.keys(packageTypeByQueueType),
      acceptedPackageTypes: Object.values(packageTypeByQueueType),
      requiredSource: "new-remote-web",
      requiredScope: "clean-foundation",
      cookieValuesIncluded: false,
      authorizationIncluded: false,
      fullResponseBodiesIncluded: false
    },
    evidenceDigest: simpleDigest(stableStringify({
      count: records.length,
      byType,
      byPackageType,
      issues,
      warnings
    }))
  };
}

export function writeUploadAudit(audit, options = {}) {
  const jsonPath = resolve(options.jsonPath || join(defaultArtifacts, "diagnostic-upload-audit.json"));
  const mdPath = resolve(options.mdPath || join(defaultArtifacts, "diagnostic-upload-audit.md"));
  writeJson(jsonPath, audit);
  writeFileSync(mdPath, buildUploadAuditMarkdown(audit), "utf8");
  return { jsonPath, mdPath };
}

export function buildUploadAuditMarkdown(audit) {
  return [
    "# 诊断上传后台审计",
    "",
    `> 生成时间：${audit.generatedAt}`,
    `> 状态：${audit.status}`,
    `> 收件箱：${audit.uploadDir}`,
    "",
    "## 总览",
    "",
    `- 上传记录：${audit.count}`,
    `- 脱敏通过：${audit.redactedCount}/${audit.count}`,
    `- 总字节：${audit.totalBytes}`,
    `- 类型：${JSON.stringify(audit.byType)}`,
    `- 包类型：${JSON.stringify(audit.byPackageType)}`,
    `- 证据摘要：${audit.evidenceDigest}`,
    "",
    "## 最新记录",
    "",
    "| 文件 | 类型 | 包类型 | 字节 | 脱敏 | 问题 | 警告 |",
    "|---|---|---|---|---|---|---|",
    ...audit.latest.map((item) => `| ${item.file} | ${item.type} | ${item.packageType} | ${item.bytes} | ${item.redacted} | ${item.issueCount} | ${item.warningCount} |`),
    "",
    "## 问题",
    "",
    audit.issues.length ? audit.issues.map((item) => `- ${item}`).join("\n") : "- 无",
    "",
    "## 警告",
    "",
    audit.warnings.length ? audit.warnings.map((item) => `- ${item}`).join("\n") : "- 无",
    "",
    "## 生产合同",
    "",
    "- 只接受 `diagnostic-ticket` 和 `data-repair-ticket`。",
    "- 只接受 `new-remote-web` / `clean-foundation` 来源范围。",
    "- 不接收 Cookie 值、Authorization、token、完整请求头或完整响应体。",
    "- 该本地收件箱只作为生产后台接入前的合同与脱敏验收证据。"
  ].join("\n");
}
