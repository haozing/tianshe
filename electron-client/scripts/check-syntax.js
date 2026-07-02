const { execFileSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (name === "node_modules") continue;
      walk(fullPath);
    } else if (fullPath.endsWith(".js")) {
      files.push(fullPath);
    }
  }
}

walk(join(root, "src"));

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Checked ${files.length} JavaScript files.`);

