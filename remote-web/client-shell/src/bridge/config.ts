import type { ChihuConfig, ReleaseManifest } from "../types";
import { STORAGE_KEY_CONFIG_CACHE, storageSet } from "./storage";

export const CONFIG_URL = "./config/chihu-config.json";
export const RELEASE_MANIFEST_URL = "./release-manifest.json";

export function defaultConfig(): ChihuConfig {
  return {
    schemaVersion: 1,
    version: "local-client-shell",
    configTtlSeconds: 300,
    entry: {
      newRemoteOrigin: "./"
    },
    shell: {
      mode: "foundation",
      enabled: true,
      shellVersion: "client-shell"
    },
    features: {
      diagnostics: { enabled: true },
      bridgeSelfCheck: { enabled: true },
      storageHealth: { enabled: true },
      businessSlot: { enabled: true },
      marketingMenu: { enabled: true },
      marketingLimitedTime: { enabled: true },
      marketingNewUserBonus: { enabled: true },
      marketingGeneralCoupon: { enabled: true },
      marketingWriteActions: { enabled: true }
    },
    assets: {
      shellEntry: "./app.js",
      cssEntry: "./styles.css",
      manifestUrl: RELEASE_MANIFEST_URL
    },
    diagnostics: {
      enabled: true,
      sampleRate: 1
    },
    release: {
      gitCommit: "local-client-shell",
      buildTime: "2026-07-04T00:00:00+08:00"
    }
  };
}

function assertConfig(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateConfig(input: unknown): ChihuConfig {
  const config = input as ChihuConfig;
  assertConfig(config && typeof config === "object", "config must be object");
  assertConfig(config.schemaVersion === 1, "schemaVersion must be 1");
  assertConfig(typeof config.version === "string" && config.version, "version is required");
  assertConfig(typeof config.entry?.newRemoteOrigin === "string" && config.entry.newRemoteOrigin, "entry.newRemoteOrigin is required");
  assertConfig(config.shell?.mode === "foundation", "shell.mode must be foundation");
  assertConfig(config.shell.enabled === true, "shell.enabled must be true");
  assertConfig(config.assets?.manifestUrl === RELEASE_MANIFEST_URL, "assets.manifestUrl is invalid");
  assertConfig(Boolean(config.release?.gitCommit), "release.gitCommit is required");
  assertConfig(Boolean(config.release?.buildTime), "release.buildTime is required");
  return config;
}

export async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(url + " http " + response.status);
  return response.json() as Promise<T>;
}

export async function loadConfig() {
  const query = new URLSearchParams(window.location.search);
  const smokeOverrideAllowed = window.location.hostname.endsWith(".localhost") && query.get("smoke") === "1";
  const override = smokeOverrideAllowed ? query.get("configUrl") : null;
  const url = override || CONFIG_URL;
  const config = validateConfig(await loadJson<unknown>(url));
  storageSet(STORAGE_KEY_CONFIG_CACHE, {
    savedAt: new Date().toISOString(),
    version: config.version,
    config
  });
  return {
    config,
    source: override ? "query" as const : "remote" as const
  };
}

export async function loadManifest() {
  const config = await loadConfig().catch(() => null);
  return loadJson<ReleaseManifest>(config?.config.assets?.manifestUrl || RELEASE_MANIFEST_URL);
}
