import type { DoudianAdapterPayload } from "../../../types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function marketingAdapterSnapshotHash(payload: DoudianAdapterPayload) {
  const input = canonical({ adapter: payload.adapter, scripts: payload.scripts || null });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `marketing-adapter-${(hash >>> 0).toString(36)}`;
}
