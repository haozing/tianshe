import type { BrowserStorageArea } from '../../types/browser-interface';
import { serializeLocalValue } from './ruyi-firefox-client-utils';
import type {
  DispatchCookieSetParams,
  DispatchEvaluateWithArgsParams,
  DispatchStorageAreaParams,
  DispatchStorageGetItemParams,
  DispatchStorageSetItemParams,
} from './ruyi-firefox-client.types';

type SendBiDiCommand = <TResult = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

type EvaluateExpression = <TResult>(expression: string, timeoutMs: number) => Promise<TResult>;

type EvaluateWithArgs = <TResult>(
  params: DispatchEvaluateWithArgsParams,
  timeoutMs: number
) => Promise<TResult>;

export interface RuyiFirefoxStorageCookieControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  getActiveContextId: () => Promise<string>;
  evaluateExpression: EvaluateExpression;
  evaluateWithArgs: EvaluateWithArgs;
}

export class RuyiFirefoxStorageCookieController {
  constructor(private readonly deps: RuyiFirefoxStorageCookieControllerDeps) {}

  async getStorageItem(
    params: DispatchStorageGetItemParams,
    timeoutMs: number
  ): Promise<string | null> {
    return await this.deps.evaluateWithArgs<string | null>(
      {
        functionSource: getStorageOperationFunction(),
        args: ['get', normalizeStorageArea(params?.area), params?.key ?? '', null],
      },
      timeoutMs
    );
  }

  async setStorageItem(params: DispatchStorageSetItemParams, timeoutMs: number): Promise<void> {
    await this.deps.evaluateWithArgs<null>(
      {
        functionSource: getStorageOperationFunction(),
        args: ['set', normalizeStorageArea(params?.area), params?.key ?? '', params?.value ?? ''],
      },
      timeoutMs
    );
  }

  async removeStorageItem(
    params: DispatchStorageGetItemParams,
    timeoutMs: number
  ): Promise<void> {
    await this.deps.evaluateWithArgs<null>(
      {
        functionSource: getStorageOperationFunction(),
        args: ['remove', normalizeStorageArea(params?.area), params?.key ?? '', null],
      },
      timeoutMs
    );
  }

  async clearStorageArea(params: DispatchStorageAreaParams, timeoutMs: number): Promise<void> {
    await this.deps.evaluateWithArgs<null>(
      {
        functionSource: getStorageOperationFunction(),
        args: ['clear', normalizeStorageArea(params?.area), '', null],
      },
      timeoutMs
    );
  }

  async getAllCookies(timeoutMs: number): Promise<Array<Record<string, unknown>>> {
    const context = await this.deps.getActiveContextId();
    try {
      const result = await this.deps.sendBiDiCommand<{
        cookies?: Array<Record<string, unknown>>;
      }>(
        'storage.getCookies',
        {
          partition: {
            type: 'context',
            context,
          },
        },
        timeoutMs
      );
      return Array.isArray(result.cookies) ? result.cookies : [];
    } catch {
      const result = await this.deps.sendBiDiCommand<{
        cookies?: Array<Record<string, unknown>>;
      }>('storage.getCookies', {}, timeoutMs);
      return Array.isArray(result.cookies) ? result.cookies : [];
    }
  }

  async setCookie(params: DispatchCookieSetParams, timeoutMs: number): Promise<void> {
    const rawCookie = params?.cookie;
    if (!rawCookie || typeof rawCookie !== 'object') {
      throw new Error('cookie is required');
    }

    const cookie = rawCookie as Record<string, unknown>;
    const name = String(cookie.name ?? '').trim();
    if (!name) {
      throw new Error('cookie.name is required');
    }

    const domain = await this.resolveCookieDomain(cookie, timeoutMs);
    const bidiCookie: Record<string, unknown> = {
      name,
      value: serializeLocalValue(cookie.value),
      domain,
    };

    if (typeof cookie.path === 'string' && cookie.path.trim()) bidiCookie.path = cookie.path;
    if (typeof cookie.secure === 'boolean') bidiCookie.secure = cookie.secure;
    if (typeof cookie.httpOnly === 'boolean') bidiCookie.httpOnly = cookie.httpOnly;
    if (typeof cookie.sameSite === 'string') bidiCookie.sameSite = cookie.sameSite;
    if (typeof cookie.expiry === 'number') {
      bidiCookie.expiry = cookie.expiry;
    } else if (typeof cookie.expirationDate === 'number') {
      bidiCookie.expiry = cookie.expirationDate;
    }

    const context = await this.deps.getActiveContextId();
    try {
      await this.deps.sendBiDiCommand(
        'storage.setCookie',
        {
          cookie: bidiCookie,
          partition: {
            type: 'context',
            context,
          },
        },
        timeoutMs
      );
    } catch {
      await this.deps.sendBiDiCommand(
        'storage.setCookie',
        {
          cookie: bidiCookie,
        },
        timeoutMs
      );
    }
  }

  async clearCookies(timeoutMs: number): Promise<void> {
    const context = await this.deps.getActiveContextId();
    try {
      await this.deps.sendBiDiCommand(
        'storage.deleteCookies',
        {
          partition: {
            type: 'context',
            context,
          },
        },
        timeoutMs
      );
    } catch {
      await this.deps.sendBiDiCommand('storage.deleteCookies', {}, timeoutMs);
    }
  }

  private async resolveCookieDomain(
    cookie: Record<string, unknown>,
    timeoutMs: number
  ): Promise<string> {
    if (typeof cookie.domain === 'string' && cookie.domain.trim()) {
      return cookie.domain.trim();
    }

    const currentUrl = await this.deps
      .evaluateExpression<string>('window.location.href', timeoutMs)
      .catch(() => '');
    try {
      const resolved = new URL(String(currentUrl || ''));
      const domain = resolved.hostname.trim();
      if (domain) {
        return domain;
      }
    } catch {
      // fall through to the explicit error below
    }

    throw new Error('cookie.domain is required when current page URL is unavailable');
  }
}

function normalizeStorageArea(area: BrowserStorageArea | undefined): BrowserStorageArea {
  const normalized = String(area || '').trim().toLowerCase();
  if (normalized === 'local' || normalized === 'session') {
    return normalized;
  }
  throw new Error(`Unsupported storage area: ${String(area ?? '') || '<empty>'}`);
}

function getStorageOperationFunction(): string {
  return String.raw`(operation, area, key, value) => {
    const storageName =
      area === 'session'
        ? 'sessionStorage'
        : area === 'local'
          ? 'localStorage'
          : '';
    if (!storageName) {
      throw new Error('storage area is required');
    }

    try {
      const storage = area === 'session' ? window.sessionStorage : window.localStorage;
      switch (operation) {
        case 'get':
          return storage.getItem(String(key ?? ''));
        case 'set':
          storage.setItem(String(key ?? ''), String(value ?? ''));
          return null;
        case 'remove':
          storage.removeItem(String(key ?? ''));
          return null;
        case 'clear':
          storage.clear();
          return null;
        default:
          throw new Error('unsupported storage operation: ' + String(operation ?? ''));
      }
    } catch (error) {
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String(error.message ?? '')
          : String(error ?? 'unknown error');
      throw new Error('Failed to access ' + storageName + ': ' + message);
    }
  }`;
}
