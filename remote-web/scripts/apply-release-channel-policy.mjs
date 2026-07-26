import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function channelName(value) {
  const channel = String(value || "").trim().toLowerCase();
  if (channel !== "stable" && channel !== "beta") throw new Error(`Unsupported release channel: ${value}`);
  return channel;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function applyReleaseChannelPolicy(adapter, channelValue) {
  const channel = channelName(channelValue);
  const next = structuredClone(record(adapter, "adapter"));
  const policies = record(next.policies, "adapter.policies");
  const opportunityReport = record(policies.opportunityReport, "adapter.policies.opportunityReport");
  opportunityReport.submitThrottleRecoveryEnabled = channel === "beta";
  opportunityReport.submitHistoryPrewarmEnabled = false;
  opportunityReport.submitPipelineStreamingEnabled = channel === "beta";
  return next;
}

export function applyReleaseChannelPolicyFile(filePath, channel) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) throw new Error(`Adapter config not found: ${resolvedPath}`);
  const adapter = JSON.parse(readFileSync(resolvedPath, "utf8"));
  const updated = applyReleaseChannelPolicy(adapter, channel);
  writeFileSync(resolvedPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return resolvedPath;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function main() {
  const channel = channelName(argValue("--channel"));
  const buildRoot = resolve(argValue("--build-root"));
  const configRoot = join(buildRoot, "config");
  const files = [
    join(configRoot, "doudian-adapter.json"),
    join(configRoot, "doudian-adapter.marketing-pilot.json")
  ];
  for (const filePath of files) applyReleaseChannelPolicyFile(filePath, channel);
  console.log(`RELEASE_CHANNEL_POLICY_OK ${channel}`);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPath === import.meta.url) main();
