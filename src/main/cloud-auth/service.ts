import Store from 'electron-store';
import type {
  CloudAuthChangeReason,
  CloudAuthPublicSession,
  CloudAuthSessionChangedEvent,
  CloudAuthStoreSchema,
  PersistedCloudAuthSession,
} from '../../types/cloud-sync';

interface CloudAuthLoginParams {
  username: string;
  password: string;
  captchaCode?: string;
  captchaUuid?: string;
}

type CloudAuthResetHandler = (event: CloudAuthSessionChangedEvent) => void | Promise<void>;

const store = new Store<CloudAuthStoreSchema<PersistedCloudAuthSession>>({
  name: 'cloud-auth-open',
});
const resetHandlers = new Set<CloudAuthResetHandler>();

function publicLoggedOutSession(): CloudAuthPublicSession {
  return {
    loggedIn: false,
    authRevision: 0,
  };
}

async function notifyReset(reason: CloudAuthChangeReason): Promise<CloudAuthPublicSession> {
  store.delete('session');
  const session = publicLoggedOutSession();
  const event: CloudAuthSessionChangedEvent = { session, reason };
  for (const handler of resetHandlers) {
    await handler(event);
  }
  return session;
}

export function getCloudAuthService() {
  return {
    getStore: getCloudAuthStore,
    registerResetHandler: registerCloudAuthResetHandler,
    getPersistedSession: getPersistedCloudAuthSession,
    getPublicSession: getPublicCloudAuthSession,
    fetchCaptcha: fetchCloudCaptcha,
    login: loginToCloud,
    logout: logoutFromCloud,
    invalidateSession: invalidateCloudAuthSession,
    commitSession: commitCloudAuthSession,
    isExpired: isCloudAuthSessionExpired,
  };
}

export function getCloudAuthStore(): Store<CloudAuthStoreSchema<PersistedCloudAuthSession>> {
  return store;
}

export function getPersistedCloudAuthSession(): PersistedCloudAuthSession | undefined {
  return undefined;
}

export async function getPublicCloudAuthSession(): Promise<CloudAuthPublicSession> {
  return publicLoggedOutSession();
}

export async function fetchCloudCaptcha(): Promise<{ uuid: string; imageBase64: string }> {
  throw new Error('Cloud auth is not available in the open-source edition');
}

export async function loginToCloud(_params: CloudAuthLoginParams): Promise<CloudAuthPublicSession> {
  throw new Error('Cloud auth is not available in the open-source edition');
}

export async function logoutFromCloud(): Promise<void> {
  await notifyReset('logout');
}

export async function invalidateCloudAuthSession(
  reason: CloudAuthChangeReason
): Promise<CloudAuthPublicSession> {
  return notifyReset(reason);
}

export async function commitCloudAuthSession(
  _session: Omit<PersistedCloudAuthSession, 'authSessionId' | 'authRevision' | 'updatedAt'>,
  reason: CloudAuthChangeReason
): Promise<CloudAuthPublicSession> {
  return notifyReset(reason);
}

export function isCloudAuthSessionExpired(_session?: PersistedCloudAuthSession | null): boolean {
  return false;
}

export function registerCloudAuthResetHandler(handler: CloudAuthResetHandler): () => void {
  resetHandlers.add(handler);
  return () => {
    resetHandlers.delete(handler);
  };
}
