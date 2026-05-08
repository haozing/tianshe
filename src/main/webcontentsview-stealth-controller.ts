import { app, type Session, type WebContents } from 'electron';
import fs from 'fs';
import path from 'path';
import { AIRPA_RUNTIME_CONFIG } from '../constants/runtime-config';
import { attachNavigationGuards } from '../core/browser-core/navigation-guard';
import { getSessionWebRequestHub } from '../core/browser-core/web-request-hub';
import {
  fingerprintManager,
  generateFullStealthScript,
  generateCDPCommands,
  generateDebuggerHidingCommands,
  buildLowEntropyClientHintsHeaders,
  buildHighEntropyClientHintsHeaders,
  buildAcceptLanguageHeaderValue,
  type LowEntropyClientHintsHeaders,
  type HighEntropyClientHintsHeaders,
  type StealthOptions,
  type StealthConfig,
} from '../core/stealth';
import type { ViewMetadata } from './webcontentsview-manager';

const stealthDebugLogPath = path.join(app.getPath('userData'), 'stealth-debug.log');

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function stealthDebug(message: string): void {
  if (!AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders) return;
  try {
    console.log(message);
  } catch {
    // ignore
  }
  try {
    fs.appendFileSync(stealthDebugLogPath, message + '\n');
  } catch {
    // ignore
  }
}

function mergeRequestHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string,
  value: string
): void {
  headers[key] = value;
  const lower = key.toLowerCase();
  if (lower !== key && lower in headers) {
    delete headers[lower];
  }
}

type HighEntropyHintEntry = {
  headers: HighEntropyClientHintsHeaders;
  expiresAt?: number;
};

type StealthNetworkOverrides = {
  acceptLanguage: string;
  clientHints: LowEntropyClientHintsHeaders;
  highEntropyHints: HighEntropyClientHintsHeaders;
  highEntropyByOrigin: Map<string, HighEntropyHintEntry>;
};

function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.join(',');
    if (typeof value === 'string') return value;
    return null;
  }
  return null;
}

function parseAcceptCH(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^"+|"+$/g, ''));
}

function parseAcceptCHLifetime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch (_e) {
    return null;
  }
}

function filterHighEntropyHints(
  headers: HighEntropyClientHintsHeaders,
  requested: string[]
): HighEntropyClientHintsHeaders {
  if (!requested.length) return {};
  const requestedSet = new Set(
    requested.map((token) =>
      token
        .trim()
        .replace(/^"+|"+$/g, '')
        .toLowerCase()
    )
  );
  const filtered: HighEntropyClientHintsHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (requestedSet.has(key.toLowerCase())) {
      filtered[key as keyof HighEntropyClientHintsHeaders] = value;
    }
  }
  return filtered;
}

export class WebContentsViewStealthController {
  private stealthNetworkOverridesByPartition: Map<string, StealthNetworkOverrides> = new Map();
  private stealthNetworkHookedPartitions: Set<string> = new Set();
  private stealthDebuggerMessageHandlers: Map<
    string,
    (event: unknown, method: string, params: unknown) => void
  > = new Map();
  private navigationGuardCleanupByViewId: Map<string, () => void> = new Map();

  debug(message: string): void {
    stealthDebug(message);
  }

  private resolveStealthConfig(partition: string, metadata?: ViewMetadata): StealthConfig | null {
    const base = metadata?.stealth;
    if (base && base.enabled === false) {
      return base;
    }

    const profileKey = typeof metadata?.profileId === 'string' ? metadata.profileId.trim() : '';
    const derivedProfileKey =
      profileKey ||
      (partition.startsWith('persist:profile-') ? partition.slice('persist:profile-'.length) : '');
    const identityKey =
      typeof base?.identityKey === 'string' && base.identityKey.trim()
        ? base.identityKey.trim()
        : derivedProfileKey || partition;

    if (base) {
      return { ...base, enabled: true, identityKey };
    }

    return { enabled: true, identityKey };
  }

  private ensureStealthNetworkHooks(session: Session, partition: string): void {
    if (this.stealthNetworkHookedPartitions.has(partition)) {
      return;
    }
    this.stealthNetworkHookedPartitions.add(partition);
    const requestHub = getSessionWebRequestHub(session);

    requestHub.subscribeBeforeSendHeaders((details, callback) => {
      const overrides = this.stealthNetworkOverridesByPartition.get(partition);
      if (!overrides || !details.url.startsWith('http')) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }

      const requestHeaders = { ...details.requestHeaders } as Record<string, string | string[]>;

      mergeRequestHeader(requestHeaders, 'Accept-Language', overrides.acceptLanguage);

      for (const [key, value] of Object.entries(overrides.clientHints)) {
        mergeRequestHeader(requestHeaders, key, value);
      }

      const origin = getOrigin(details.url);
      if (origin) {
        const highEntropyEntry = overrides.highEntropyByOrigin.get(origin);
        if (highEntropyEntry) {
          if (highEntropyEntry.expiresAt && highEntropyEntry.expiresAt <= Date.now()) {
            overrides.highEntropyByOrigin.delete(origin);
          } else {
            for (const [key, value] of Object.entries(highEntropyEntry.headers)) {
              if (typeof value === 'string') {
                mergeRequestHeader(requestHeaders, key, value);
              }
            }
          }
        }
      }

      if (
        AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders &&
        details.resourceType === 'mainFrame'
      ) {
        const acceptLanguage = requestHeaders['Accept-Language'];
        const secChUa = requestHeaders['Sec-CH-UA'];
        const secChUaPlatform = requestHeaders['Sec-CH-UA-Platform'];
        const secChUaPlatformVersion = requestHeaders['Sec-CH-UA-Platform-Version'];
        stealthDebug(
          `[Stealth][Network] partition=${partition} url=${details.url} Accept-Language=${String(
            acceptLanguage
          )} Sec-CH-UA=${String(secChUa)} Sec-CH-UA-Platform=${String(
            secChUaPlatform
          )} Sec-CH-UA-Platform-Version=${String(secChUaPlatformVersion)}`
        );
      }

      callback({ requestHeaders });
    });

    requestHub.subscribeHeadersReceived((details, callback) => {
      const overrides = this.stealthNetworkOverridesByPartition.get(partition);
      if (!overrides || !details.url.startsWith('http')) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const acceptCH = getHeaderValue(details.responseHeaders, 'accept-ch');
      if (!acceptCH) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const requested = parseAcceptCH(acceptCH);
      if (requested.length === 0) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const origin = getOrigin(details.url);
      if (!origin) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const filtered = filterHighEntropyHints(overrides.highEntropyHints, requested);
      if (Object.keys(filtered).length > 0) {
        const lifetimeValue = getHeaderValue(details.responseHeaders, 'accept-ch-lifetime');
        const lifetime = parseAcceptCHLifetime(lifetimeValue);
        const expiresAt = lifetime ? Date.now() + lifetime * 1000 : undefined;
        overrides.highEntropyByOrigin.set(origin, { headers: filtered, expiresAt });
        if (AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders) {
          stealthDebug(
            `[Stealth][CH] partition=${partition} origin=${origin} accept-ch=${acceptCH}`
          );
        }
      }

      callback({ responseHeaders: details.responseHeaders });
    });
  }

  async applyToWebContents(
    viewId: string,
    webContents: WebContents,
    partition: string,
    metadata?: ViewMetadata
  ): Promise<void> {
    const existingNavigationGuardCleanup = this.navigationGuardCleanupByViewId.get(viewId);
    if (existingNavigationGuardCleanup) {
      existingNavigationGuardCleanup();
    }
    this.navigationGuardCleanupByViewId.set(
      viewId,
      attachNavigationGuards(webContents, {
        onBlocked: ({ eventName, protocol, url }) => {
          console.warn(
            `  ⛔ [NavigationGuard] Blocked ${eventName} for unsupported protocol ${protocol}: ${url}`
          );
        },
      })
    );

    const stealthConfig = this.resolveStealthConfig(partition, metadata);
    if (!stealthConfig?.enabled) {
      return;
    }

    const fingerprintKey =
      typeof stealthConfig.identityKey === 'string' && stealthConfig.identityKey.trim()
        ? stealthConfig.identityKey.trim()
        : partition;
    const fingerprint = fingerprintManager.getFingerprint(fingerprintKey, stealthConfig);
    const acceptLanguage = buildAcceptLanguageHeaderValue(fingerprint.languages);

    stealthDebug(
      `[Stealth][Config] view=${viewId} partition=${partition} ` +
        `profileId=${metadata?.profileId || ''} source=${metadata?.source || ''} ` +
        `config.languages=${JSON.stringify(stealthConfig.languages || null)} ` +
        `config.noise=${JSON.stringify({
          canvas: stealthConfig.canvasNoise,
          canvasLevel: stealthConfig.canvasNoiseLevel,
          audio: stealthConfig.audioNoise,
          audioLevel: stealthConfig.audioNoiseLevel,
          webgl: stealthConfig.webglNoise,
        })} ` +
        `fp.languages=${JSON.stringify(fingerprint.languages)} ` +
        `fp.noise=${JSON.stringify({
          canvas: fingerprint.canvas?.noise,
          canvasLevel: fingerprint.canvas?.noiseLevel,
          audio: fingerprint.audio?.noise,
          audioLevel: fingerprint.audio?.noiseLevel,
          webgl: fingerprint.webglNoise,
        })} ` +
        `acceptLanguage=${acceptLanguage}`
    );
    webContents.session.setUserAgent(fingerprint.userAgent, acceptLanguage);

    const clientHints = buildLowEntropyClientHintsHeaders(fingerprint);
    const highEntropyHints = buildHighEntropyClientHintsHeaders(fingerprint);
    this.stealthNetworkOverridesByPartition.set(partition, {
      acceptLanguage,
      clientHints,
      highEntropyHints,
      highEntropyByOrigin: new Map(),
    });
    this.ensureStealthNetworkHooks(webContents.session, partition);
    console.log(`  🥷 [Stealth] HTTP User-Agent set: ${fingerprint.userAgent.substring(0, 50)}...`);

    // 🎯 CDP-first: 使用 CDP 命令 + JS 脚本注入（确保 JS/网络层一致）
    // 注意：Electron 启动参数 --disable-blink-features=AutomationControlled 已在 index.ts 中设置

    // 构建 StealthOptions：确保 CDP/JS 注入与 network 使用相同的开关与参数
    // 右栏/分栏布局依赖真实 viewport 跟随 setBounds 变化：
    // 对自动化视图禁用 CDP DeviceMetrics 固定尺寸，仅保留 screen/devicePixelRatio 的指纹伪装。
    const dynamicViewportSource =
      metadata?.source === 'pool' || metadata?.source === 'mcp' || metadata?.source === 'account';
    const mobileUserAgent = /\bMobile\b|\bAndroid\b|\biPhone\b|\biPad\b/i.test(
      fingerprint.userAgent
    );
    const disableFixedDeviceMetrics = dynamicViewportSource && !mobileUserAgent;
    const stealthOptions: StealthOptions = {
      canvasNoise:
        typeof stealthConfig.canvasNoise === 'boolean' ? stealthConfig.canvasNoise : undefined,
      canvasNoiseLevel:
        typeof stealthConfig.canvasNoiseLevel === 'number'
          ? stealthConfig.canvasNoiseLevel
          : undefined,
      audioNoise:
        typeof stealthConfig.audioNoise === 'boolean' ? stealthConfig.audioNoise : undefined,
      audioNoiseLevel:
        typeof stealthConfig.audioNoiseLevel === 'number'
          ? stealthConfig.audioNoiseLevel
          : undefined,
      webglNoise:
        typeof stealthConfig.webglNoise === 'boolean' ? stealthConfig.webglNoise : undefined,
      touchEvents: stealthConfig.touchSupport ?? false,
      deviceMetrics: disableFixedDeviceMetrics ? false : undefined,
    };

    const cdpCommands = [
      ...generateCDPCommands(fingerprint, stealthOptions),
      ...generateDebuggerHidingCommands(),
    ];

    const debugStealth = AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders;
    const script = (() => {
      const base = generateFullStealthScript(fingerprint, stealthOptions);
      if (!debugStealth) return base;

      const expected = {
        languages: fingerprint.languages,
        timezone: fingerprint.timezone,
        devicePixelRatio:
          typeof fingerprint.pixelRatio === 'number' && fingerprint.pixelRatio > 0
            ? fingerprint.pixelRatio
            : 1,
        noise: {
          canvas: stealthOptions.canvasNoise ?? fingerprint.canvas?.noise ?? true,
          canvasLevel: stealthOptions.canvasNoiseLevel ?? fingerprint.canvas?.noiseLevel ?? 0.1,
          audio: stealthOptions.audioNoise ?? fingerprint.audio?.noise ?? false,
          audioLevel: stealthOptions.audioNoiseLevel ?? fingerprint.audio?.noiseLevel ?? 0.01,
          webgl: stealthOptions.webglNoise ?? fingerprint.webglNoise ?? false,
        },
      };

      return (
        base +
        `\n;(()=>{try{Object.defineProperty(globalThis,'__airpaStealthExpected',{value:${JSON.stringify(
          expected
        )},configurable:true});}catch(_e){}})();\n`
      );
    })();

    // 先加载 about:blank 确保渲染进程完全初始化
    // 否则 CDP 命令可能永远挂起（渲染进程未就绪无法响应）
    await webContents.loadURL('about:blank');
    console.log(`  📄 [Stealth] Loaded about:blank to initialize renderer for view: ${viewId}`);

    // 立即尝试 CDP 注入（同步执行，不使用 setTimeout）
    let cdpInjected = false;
    try {
      const debuggerApi = webContents.debugger as unknown as {
        attach: (protocolVersion?: string) => void;
        sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
        on: (
          event: 'message',
          listener: (event: unknown, method: string, params: unknown) => void
        ) => void;
        removeListener: (
          event: 'message',
          listener: (event: unknown, method: string, params: unknown) => void
        ) => void;
      };

      // 1. 附加调试器（允许复用已被其他地方占用的 debugger）
      try {
        debuggerApi.attach('1.3');
        console.log(`  🔌 [Stealth] CDP debugger attached for view: ${viewId}`);
      } catch (attachError) {
        const msg = getErrorMessage(attachError);
        if (msg.toLowerCase().includes('already attached')) {
          console.log(`  🔌 [Stealth] CDP debugger already attached, reusing for view: ${viewId}`);
        } else {
          throw attachError;
        }
      }

      // Ensure cross-process iframes inherit stealth scripts and emulation overrides.
      let subTargetMessageId = 0;
      const sendToTarget = async (
        sessionId: string,
        method: string,
        params?: Record<string, unknown>
      ): Promise<void> => {
        const message = JSON.stringify({ id: ++subTargetMessageId, method, params });
        await debuggerApi.sendCommand('Target.sendMessageToTarget', { sessionId, message });
      };

      const applyStealthToTarget = async (
        sessionId: string,
        targetInfo?: { type?: string; targetId?: string; url?: string }
      ): Promise<void> => {
        const targetLabel = `${targetInfo?.type || 'unknown'} ${targetInfo?.targetId || sessionId}`;
        let commandFailures = 0;

        try {
          await sendToTarget(sessionId, 'Page.enable');
        } catch {
          commandFailures++;
        }

        for (const command of cdpCommands) {
          try {
            await sendToTarget(sessionId, command.method, command.params);
          } catch {
            commandFailures++;
          }
        }

        try {
          await sendToTarget(sessionId, 'Page.addScriptToEvaluateOnNewDocument', {
            source: script,
          });
          if (debugStealth) {
            console.log(
              `  ✅ [Stealth] Subtarget injected: ${targetLabel} (failures=${commandFailures})`
            );
          }
        } catch (error) {
          if (debugStealth) {
            console.warn(`  ⚠️ [Stealth] Subtarget injection failed: ${targetLabel}`, error);
          }
        }
      };

      const handleTargetAttached = (_event: unknown, method: string, params: unknown) => {
        if (method !== 'Target.attachedToTarget') return;
        if (!params || typeof params !== 'object') return;

        const payload = params as { sessionId?: unknown; targetInfo?: unknown };
        if (typeof payload.sessionId !== 'string') return;
        if (!payload.targetInfo || typeof payload.targetInfo !== 'object') return;

        const targetInfo = payload.targetInfo as {
          type?: unknown;
          targetId?: unknown;
          url?: unknown;
        };
        const type = targetInfo.type;
        if (type !== 'iframe' && type !== 'page' && type !== 'frame') return;

        void applyStealthToTarget(payload.sessionId, {
          type,
          targetId: typeof targetInfo.targetId === 'string' ? targetInfo.targetId : undefined,
          url: typeof targetInfo.url === 'string' ? targetInfo.url : undefined,
        });
      };

      const existingHandler = this.stealthDebuggerMessageHandlers.get(viewId);
      if (existingHandler) {
        debuggerApi.removeListener('message', existingHandler);
      }
      debuggerApi.on('message', handleTargetAttached);
      this.stealthDebuggerMessageHandlers.set(viewId, handleTargetAttached);

      try {
        await debuggerApi.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } catch (error) {
        if (debugStealth) {
          console.warn(`  ⚠️ [Stealth] Target auto-attach failed:`, error);
        }
      }

      // 2. 启用 Page 和 Emulation 域
      await debuggerApi.sendCommand('Page.enable');
      console.log(`  📄 [Stealth] Page domain enabled for view: ${viewId}`);

      // 3. 🎯 CDP-first: 执行 CDP 伪装命令（时区、UA+Client Hints、地理位置、设备指标）
      let cdpSuccessCount = 0;
      let cdpFailCount = 0;

      for (const command of cdpCommands) {
        try {
          await debuggerApi.sendCommand(command.method, command.params);
          cdpSuccessCount++;
        } catch (err) {
          cdpFailCount++;
          // 某些 CDP 命令可能不支持，静默处理
          console.log(`  ⚠️ [Stealth] CDP command ${command.method} failed: ${err}`);
        }
      }

      console.log(
        `  🎯 [Stealth] CDP commands executed: ${cdpSuccessCount} succeeded, ${cdpFailCount} failed`
      );

      // 4. 注入 JS 脚本到每个新文档（补充 CDP 无法实现的功能）
      await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: script,
      });
      cdpInjected = true;
      console.log(`  ✅ [Stealth] CDP script injection configured for view: ${viewId}`);
    } catch (cdpError) {
      const cdpErrorMessage = getErrorMessage(cdpError);
      const cdpErrorLower = cdpErrorMessage.toLowerCase();
      if (
        cdpErrorLower.includes('already attached') ||
        cdpErrorLower.includes('another debugger') ||
        (cdpErrorLower.includes('debugger') && cdpErrorLower.includes('attach'))
      ) {
        console.log(
          `  [Stealth] CDP attach failed (debugger occupied). Close DevTools/other debugger and retry.`
        );
      }
      // CDP 失败不影响视图创建，回退方案会在导航时生效
      console.log(`  ⚠️ [Stealth] CDP injection failed, using fallback: ${cdpError}`);
    }

    if (!cdpInjected) {
      // 回退方案1：使用 will-navigate 事件（比 did-start-navigation 更早）
      webContents.on('will-navigate', async (_event, url) => {
        if (url === 'about:blank' || url.startsWith('devtools://')) return;

        try {
          await webContents.executeJavaScript(script);
          console.log(`  ✅ [Stealth] Script injected on will-navigate for view: ${viewId}`);
        } catch (_error) {
          // will-navigate 可能太早导致失败，静默处理
        }
      });

      // 回退方案2：使用 did-start-navigation 事件注入（作为保险）
      webContents.on('did-start-navigation', async (_event, url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        if (url === 'about:blank' || url.startsWith('devtools://')) return;

        try {
          await webContents.executeJavaScript(script);
          console.log(`  ✅ [Stealth] Script injected on navigation for view: ${viewId}`);
        } catch (error) {
          console.error(`  ❌ [Stealth] Navigation injection failed for view ${viewId}:`, error);
        }
      });
    }
  }


  cleanupBeforeDebuggerDetach(viewId: string, webContents: WebContents): void {
    const navigationGuardCleanup = this.navigationGuardCleanupByViewId.get(viewId);
    if (navigationGuardCleanup) {
      navigationGuardCleanup();
      this.navigationGuardCleanupByViewId.delete(viewId);
    }

    const handler = this.stealthDebuggerMessageHandlers.get(viewId);
    if (handler) {
      if (!webContents.isDestroyed()) {
        webContents.debugger.removeListener('message', handler);
      }
      this.stealthDebuggerMessageHandlers.delete(viewId);
    }
  }

  detachFromWebContents(viewId: string, webContents: WebContents): void {
    this.cleanupBeforeDebuggerDetach(viewId, webContents);

    if (!webContents.isDestroyed() && webContents.debugger?.isAttached()) {
      try {
        webContents.debugger.detach();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.warn(
          '  ?? Failed to detach debugger (non-critical):',
          message,
          error
        );
      }
    }
  }
}
