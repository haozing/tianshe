import { DEFAULT_BROWSER_PROFILE } from '../../constants/browser-pool';
import type { IProfileService } from '../../types/service-interfaces';
import { normalizeProfileBrowserQuota, type BrowserProfile } from '../../types/profile';
import { DEFAULT_BROWSER_RUNTIME_ID } from '../../types/browser-runtime';
import { AcquireFailedError, ProfileNotFoundError } from '../errors/BrowserPoolError';
import type { AcquireOptions, SessionConfig } from './types';

export interface ResolvedAcquireSession {
  session: SessionConfig;
  options: AcquireOptions;
}

export function profileToSessionConfig(profile: BrowserProfile): SessionConfig {
  const runtimeId = profile.runtimeId ?? DEFAULT_BROWSER_RUNTIME_ID;
  const quota = normalizeProfileBrowserQuota(profile.quota).quota;

  return {
    id: profile.id,
    partition: profile.partition,
    runtimeId,
    runtimeSourceOverride: profile.runtimeSourceOverride
      ? structuredClone(profile.runtimeSourceOverride)
      : null,
    fingerprint: profile.fingerprint ? structuredClone(profile.fingerprint) : undefined,
    proxy: profile.proxy ? structuredClone(profile.proxy) : null,
    quota,
    idleTimeoutMs: profile.idleTimeoutMs,
    lockTimeoutMs: profile.lockTimeoutMs,
    createdAt: profile.createdAt.getTime(),
    lastAccessedAt: profile.lastActiveAt?.getTime() || Date.now(),
  };
}

export function getAbortMessage(signal: AbortSignal | undefined, fallback: string): string {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return fallback;
}

export class AcquireSessionResolver {
  constructor(
    private readonly getProfileService: () => IProfileService,
    private readonly normalizeOptions: (
      session: SessionConfig,
      options?: Partial<AcquireOptions>
    ) => AcquireOptions
  ) {}

  async resolve(
    profileId: string | undefined,
    options?: Partial<AcquireOptions>
  ): Promise<ResolvedAcquireSession> {
    const targetProfileId = profileId || DEFAULT_BROWSER_PROFILE.id;
    const profile = await this.getProfileService().get(targetProfileId);
    if (!profile) {
      throw new ProfileNotFoundError(profileId || 'default');
    }

    const session = profileToSessionConfig(profile);
    return {
      session,
      options: this.normalizeOptions(session, options),
    };
  }
}

export function validateAcquireRuntime(
  session: SessionConfig,
  acquireOptions: AcquireOptions
): void {
  if (acquireOptions.runtimeId && acquireOptions.runtimeId !== session.runtimeId) {
    throw new AcquireFailedError(
      `Runtime mismatch for profile ${session.id}: profile is bound to "${session.runtimeId}", requested "${acquireOptions.runtimeId}"`
    );
  }
}
