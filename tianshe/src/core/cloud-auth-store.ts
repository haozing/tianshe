import Store from 'electron-store';

export interface CloudAuthStoreSessionLike {
  authSessionId?: string;
  authRevision?: number;
  token?: string;
  expire?: string;
  updatedAt?: number;
  user?: unknown;
}

export function getPersistedCloudAuthSession<T extends CloudAuthStoreSessionLike>(
  store: Store<any>
): T | undefined {
  const session = store.get('session') as T | undefined;
  if (!session || typeof session !== 'object') {
    return undefined;
  }

  const authSessionId = String(session.authSessionId || '').trim();
  const authRevision = Number(session.authRevision);
  if (authSessionId && Number.isFinite(authRevision) && authRevision >= 0) {
    return {
      ...session,
      authSessionId,
      authRevision: Math.trunc(authRevision),
    };
  }

  store.delete('session');
  return undefined;
}
