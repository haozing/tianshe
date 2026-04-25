import type {
  ConsoleMessage,
  NetworkEntry,
  WindowOpenPolicy,
} from '../../core/browser-core/types';
import type {
  BrowserDownloadEntry,
  BrowserDialogState,
  BrowserEmulationIdentityOptions,
  BrowserEmulationViewportOptions,
  BrowserInterceptPattern,
  BrowserInterceptedRequest,
  BrowserPdfOptions,
  BrowserRuntimeEvent,
  BrowserStorageArea,
  BrowserTabInfo,
} from '../../types/browser-interface';

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type BidiSuccessMessage<TResult = unknown> = {
  id: number;
  type?: 'success';
  result?: TResult;
};

export type BidiErrorMessage = {
  id: number;
  type?: 'error';
  error?: string;
  message?: string;
  stacktrace?: string;
};

export type BidiEventMessage = {
  type?: 'event';
  method?: string;
  params?: Record<string, unknown>;
};

export type ScriptCommandResult = {
  type?: 'success' | 'exception';
  result?: unknown;
  exceptionDetails?: Record<string, unknown>;
};

export type BrowsingContextInfo = {
  context?: string;
  url?: string;
  originalOpener?: string | null;
  children?: BrowsingContextInfo[];
};

export type DispatchGotoParams = {
  url?: string;
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
};

export type DispatchEvaluateParams = {
  script?: string;
};

export type DispatchEvaluateWithArgsParams = {
  functionSource?: string;
  args?: unknown[];
};

export type DispatchScreenshotParams = {
  captureMode?: 'viewport' | 'full_page';
};

export type DispatchPdfSaveParams = {
  options?: BrowserPdfOptions;
};

export type DispatchCookieSetParams = {
  cookie?: Record<string, unknown>;
};

export type DispatchStorageAreaParams = {
  area?: BrowserStorageArea;
};

export type DispatchStorageGetItemParams = DispatchStorageAreaParams & {
  key?: string;
};

export type DispatchStorageSetItemParams = DispatchStorageAreaParams & {
  key?: string;
  value?: string;
};

export type DispatchNativeClickParams = {
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
};

export type DispatchNativeMoveParams = {
  x?: number;
  y?: number;
};

export type DispatchNativeDragParams = {
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
};

export type DispatchNativeTypeParams = {
  text?: string;
  delay?: number;
};

export type DispatchNativeKeyPressParams = {
  key?: string;
  modifiers?: ('shift' | 'control' | 'alt' | 'meta')[];
};

export type DispatchNativeScrollParams = {
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
};

export type DispatchTouchTapParams = {
  x?: number;
  y?: number;
};

export type DispatchTouchLongPressParams = {
  x?: number;
  y?: number;
  durationMs?: number;
};

export type DispatchTouchDragParams = {
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
};

export type DispatchDialogWaitParams = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type DispatchDialogHandleParams = {
  accept?: boolean;
  promptText?: string;
};

export type DispatchTabControlParams = {
  id?: string;
};

export type DispatchCreateTabParams = {
  url?: string;
  active?: boolean;
};

export type DispatchEmulationIdentityParams = {
  options?: BrowserEmulationIdentityOptions;
};

export type DispatchEmulationViewportParams = {
  options?: BrowserEmulationViewportOptions;
};

export type DispatchInterceptEnableParams = {
  options?: {
    patterns?: BrowserInterceptPattern[];
  };
};

export type DispatchInterceptContinueParams = {
  requestId?: string;
  overrides?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  };
};

export type DispatchInterceptFulfillParams = {
  requestId?: string;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  };
};

export type DispatchInterceptFailParams = {
  requestId?: string;
  errorReason?: string;
};

export type DispatchDownloadBehaviorParams = {
  options?: {
    policy?: 'allow' | 'deny';
    downloadPath?: string;
  };
};

export type DispatchDownloadWaitParams = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type DispatchDownloadCancelParams = {
  id?: string;
};

export type RuyiFirefoxEvent =
  | { type: 'network-entry'; entry: NetworkEntry }
  | { type: 'console-message'; message: ConsoleMessage }
  | { type: 'intercepted-request'; request: BrowserInterceptedRequest }
  | { type: 'runtime-event'; event: BrowserRuntimeEvent };

export type RuyiFirefoxEventListener = (event: RuyiFirefoxEvent) => void;

export type SerializedWindowOpenPolicy = {
  default: string;
  rules: Array<{
    action: string;
    match:
      | { kind: 'string'; value: string }
      | { kind: 'regex'; source: string; flags: string };
  }>;
};

export type {
  BrowserDialogState,
  BrowserDownloadEntry,
  BrowserRuntimeEvent,
  BrowserTabInfo,
  WindowOpenPolicy,
};
