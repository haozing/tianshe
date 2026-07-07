import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const docsDir = join(repoRoot, "docs");
const artifactsDir = join(root, "artifacts");
const sourcePath = join(docsDir, "赤狐管家基础底座实施进度.md");
const jsonOutputPath = join(artifactsDir, "foundation-progress-audit.json");
const mdOutputPath = join(docsDir, "赤狐管家基础底座剩余项审计.md");

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function parseItems(markdown) {
  return markdown.split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^- \[(x|~| |\-)\] (.+)$/i);
      if (!match) return null;
      const mark = match[1].toLowerCase();
      const status = mark === "x" ? "completed" : mark === "~" ? "partial" : mark === "-" ? "out-of-scope" : "todo";
      return { status, text: match[2].trim() };
    })
    .filter(Boolean);
}

function renderMarkdown(report) {
  return [
    "# 赤狐管家基础底座剩余项审计",
    "",
    `> 生成时间：${report.generatedAt}`,
    `> 状态：${report.status}`,
    `> 来源：${report.source}`,
    "",
    "## 统计",
    "",
    `- 总项：${report.itemCount}`,
    `- 已完成：${report.summary.completed}`,
    `- 部分完成：${report.summary.partial}`,
    `- 未完成：${report.summary.todo}`,
    "",
    "## 未完成项",
    "",
    report.remaining.length
      ? report.remaining.map((item) => `- [${item.status}] ${item.text}`).join("\n")
      : "- 无"
  ].join("\n");
}

if (!existsSync(sourcePath)) {
  throw new Error(`progress doc not found: ${sourcePath}`);
}

const markdown = readFileSync(sourcePath, "utf8");
const items = parseItems(markdown);
const remaining = items.filter((item) => item.status !== "completed" && item.status !== "out-of-scope");
const summary = {
  completed: items.filter((item) => item.status === "completed").length,
  partial: items.filter((item) => item.status === "partial").length,
  todo: items.filter((item) => item.status === "todo").length,
  outOfScope: items.filter((item) => item.status === "out-of-scope").length
};
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: remaining.length ? "warn" : "ok",
  source: rel(sourcePath),
  itemCount: items.length,
  incompleteCount: remaining.length,
  summary,
  remaining,
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath)
  }
};

ensureDir(jsonOutputPath);
ensureDir(mdOutputPath);
writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2), "utf8");
writeFileSync(mdOutputPath, renderMarkdown(report), "utf8");

console.log("FOUNDATION_PROGRESS_AUDIT_" + report.status.toUpperCase());
console.log(JSON.stringify({
  status: report.status,
  itemCount: report.itemCount,
  incompleteCount: report.incompleteCount,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));
