import type { NativeDataApi } from "../nativeData/types";

export interface NativeOpenWindowRequest {
  url: string;
  title?: string;
  partition?: string;
  width?: number;
  height?: number;
  show?: boolean;
  waitForLoad?: boolean;
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
}

export interface NativeWindowCommandRequest {
  winId: number;
  command: "collect-role-shop-names" | "is-home-page" | "sign" | "switch-shop" | "page-fetch";
  args?: Record<string, unknown>;
  taskGrantId?: string;
  timeoutMs?: number;
}

export interface NativeHttpRequest {
  taskGrantId?: string;
  partition?: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: "json" | "losslessJson" | "text" | "arrayBuffer" | "base64";
  timeoutMs?: number;
  persistSetCookie?: boolean;
}

export interface CookieHeaderRequest {
  partition: string;
  url?: string;
  domain?: string;
  names?: string[];
}

export interface CookieHeaderResult {
  ok: boolean;
  cookieHeader: string;
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
}

export interface SelectFileRequest {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  chihu_e2e_mock_path?: string;
}

export interface SelectFileResult {
  ok: boolean;
  canceled?: boolean;
  fileName?: string;
  filePath?: string;
  e2e?: boolean;
}

export interface ReadFileRequest {
  filePath: string;
  encoding?: "utf8" | "base64";
  maxBytes?: number;
}

export interface ReadFileResult {
  ok: boolean;
  fileName: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
  message?: string;
}

export interface NativeUpdateStartRequest {
  autoDownload?: boolean;
  quitAndInstall?: boolean;
  channel?: string;
}

export interface NativeUpdateVersionRequest {
  channel?: string;
}

export interface NativeUpdateVersionData {
  ok?: boolean;
  status?: "available" | "not-available" | "unavailable" | "error" | string;
  channel?: string;
  hasUpdate?: boolean;
  isNewVersion?: boolean;
  currentVersion: string;
  latestVersion?: string;
  newVersion?: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: unknown;
  reason?: string;
  message?: string;
  error?: string;
}

export interface NativeTextSegmentRequest {
  texts: string[];
  mode?: "search" | "default";
  stopwordVersion?: string;
  minTokenLength?: number;
}

export interface NativeTextSegmentResult {
  tokenizerVersion: string;
  stopwordVersion: string;
  tokenizerFallback?: boolean;
  fallbackReason?: string;
  items: Array<{
    source: string;
    tokens: string[];
  }>;
}

export interface NativeLicenseStatus {
  ok?: boolean;
  configured: boolean;
  bypass?: boolean;
  licensed: boolean;
  allowFreeFeatures: boolean;
  status?: string;
  reason?: string;
  message?: string;
  deviceNo?: string;
  clientInstanceId?: string;
  authStatus?: string;
  allowPaidFeatures?: boolean;
  paidAccessGranted: boolean;
  paidAccessSource: "none" | "server" | "redeem" | "bypass";
  paidAccessLeaseRemainingSeconds?: number;
  verificationPending: boolean;
  expireAt?: string | null;
  remainingSeconds?: number;
  isPermanent?: boolean;
  needRedeemOrRenew?: boolean;
  contact?: string;
  requestId?: string;
  serverTime?: string;
  lastCheckedAt?: string;
}

export interface NativeLicenseStatusRequest {
  refresh?: boolean;
  scene?: string;
}

export interface NativeLicenseRedeemRequest {
  cardKey: string;
}

export interface NativeTaskStartRequest {
  taskType: string;
  clientRequestId?: string;
  params: Record<string, unknown>;
}

export type NativeTaskStartResult =
  | { ok: true; operationId: string; status: "started" | "deduplicated"; runnerWinId?: number }
  | { ok: false; code: "LICENSE_REQUIRED" | "AUTH_EXPIRED" | "AUTH_CHECK_FAILED" | "TASK_TYPE_DENIED" | "TASK_PARAMS_INVALID" | string; message: string };

export interface ChihuNativeApi {
  app: {
    getInfo: () => Promise<unknown>;
  };
  windows: {
    open: (args: NativeOpenWindowRequest) => Promise<number>;
    command: (args: NativeWindowCommandRequest) => Promise<unknown>;
    destroy: (args: { winId: number }) => Promise<unknown>;
    getInfo?: (args: { winId: number }) => Promise<unknown>;
    getAll?: () => Promise<unknown>;
    getMainInfo?: () => Promise<unknown>;
    resetMain?: (args?: unknown) => Promise<unknown>;
    reloadHome?: (args?: unknown) => Promise<unknown>;
    minimize?: (args?: unknown) => Promise<unknown>;
    maximize?: (args?: unknown) => Promise<unknown>;
    close?: (args?: unknown) => Promise<unknown>;
    isMaximized?: (args?: unknown) => Promise<unknown>;
    isDestroyed?: (args?: unknown) => Promise<unknown>;
  };
  cookies: {
    get: (args: unknown) => Promise<unknown>;
    set: (args: unknown) => Promise<unknown>;
    copy: (args: unknown) => Promise<unknown>;
    remove?: (args: unknown) => Promise<unknown>;
    getHeader: (args: CookieHeaderRequest) => Promise<CookieHeaderResult>;
    clear: (args: { partition: string }) => Promise<unknown>;
  };
  http: {
    request: (args: NativeHttpRequest) => Promise<unknown>;
  };
  license?: {
    getStatus: (args?: NativeLicenseStatusRequest) => Promise<NativeLicenseStatus>;
    check: (args?: NativeLicenseStatusRequest) => Promise<NativeLicenseStatus>;
    redeem: (args: NativeLicenseRedeemRequest) => Promise<NativeLicenseStatus>;
    clearLocal: () => Promise<NativeLicenseStatus>;
  };
  files: {
    selectFile: (args?: SelectFileRequest) => Promise<SelectFileResult>;
    readFile: (args: ReadFileRequest) => Promise<ReadFileResult>;
  };
  notifications: {
    send: (args?: unknown) => Promise<unknown>;
  };
  updates: {
    start: (args?: NativeUpdateStartRequest) => Promise<unknown>;
    getVersionData: (args?: NativeUpdateVersionRequest) => Promise<NativeUpdateVersionData>;
  };
  logs: {
    report: (args?: unknown) => Promise<unknown>;
    getDir: () => Promise<unknown>;
    clean: (args?: unknown) => Promise<unknown>;
  };
  partitions: {
    cleanInvalid: (args?: unknown) => Promise<unknown>;
  };
  text: {
    segment: (args: NativeTextSegmentRequest) => Promise<NativeTextSegmentResult>;
  };
  tasks: {
    getCatalog: () => Promise<Record<string, { taskType: string; accessTier: "free" | "paid" | "recovery" | "internal"; mutation: boolean | "dynamic" }>>;
    startRunner: (args: NativeTaskStartRequest) => Promise<NativeTaskStartResult>;
    cancelRunner: (args: { operationId: string }) => Promise<unknown>;
    getStatus: (args: { operationId: string }) => Promise<unknown>;
    listStatus: () => Promise<unknown>;
    interrupt: (args: { operationId: string; reason?: string }) => Promise<unknown>;
    recover: (args: { operationId: string }) => Promise<unknown>;
    authorizePlan: (args: { planKey: string; context?: Record<string, unknown>; transport?: Record<string, unknown> }) => Promise<{ ok: boolean; planKey: string; grantId?: string; expiresAt: number }>;
    report: (message: unknown) => Promise<unknown>;
    onCommand: (listener: (message: unknown) => void) => () => void;
    onEvent: (listener: (message: unknown) => void) => () => void;
  };
  nativeData: NativeDataApi;
}
