import { v4 as uuidv4 } from 'uuid';
import { WAIT_QUEUE_CONFIG } from '../../constants/browser-pool';
import { AcquireFailedError } from '../errors/BrowserPoolError';
import {
  getAbortMessage,
  validateAcquireRuntime,
} from './acquire-session-resolver';
import type { AcquireOptions, AcquireRequest, AcquireSource, SessionConfig } from './types';

export const DEFAULT_ACQUIRE_OPTIONS: AcquireOptions = {
  strategy: 'any',
  timeout: WAIT_QUEUE_CONFIG.defaultAcquireTimeoutMs,
  priority: 'normal',
};

export class AcquireRequestFactory {
  normalizeOptions(
    session: SessionConfig,
    options?: Partial<AcquireOptions>
  ): AcquireOptions {
    const acquireOptions: AcquireOptions = {
      ...DEFAULT_ACQUIRE_OPTIONS,
      ...options,
    };

    validateAcquireRuntime(session, acquireOptions);
    if (acquireOptions.signal?.aborted) {
      throw new AcquireFailedError(getAbortMessage(acquireOptions.signal, 'Acquire cancelled'));
    }

    acquireOptions.runtimeId = session.runtimeId;
    return acquireOptions;
  }

  create(
    session: SessionConfig,
    options: AcquireOptions,
    source: AcquireSource,
    pluginId?: string
  ): AcquireRequest {
    return {
      sessionId: session.id,
      requestId: uuidv4(),
      pluginId,
      source,
      options,
    };
  }
}
