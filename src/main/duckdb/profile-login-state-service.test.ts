import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileLoginStateService } from './profile-login-state-service';

describe('ProfileLoginStateService', () => {
  let db: DuckDBInstance | null = null;
  let conn: DuckDBConnection | null = null;

  async function openService(): Promise<ProfileLoginStateService> {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    const service = new ProfileLoginStateService(conn);
    await service.initTable();
    return service;
  }

  afterEach(() => {
    conn?.closeSync();
    db?.closeSync();
    conn = null;
    db = null;
  });

  it('upserts and reads the latest login state for a profile and site', async () => {
    const service = await openService();

    const first = await service.upsertLoginState({
      profileId: 'profile-1',
      site: 'example',
      loginUrl: 'https://example.test/login',
      runtimeId: 'electron-webcontents',
      status: 'needs_manual_login',
      reason: 'manual handoff required',
    });
    const second = await service.upsertLoginState({
      profileId: 'profile-1',
      site: 'example',
      loginUrl: 'https://example.test/account',
      runtimeId: 'electron-webcontents',
      status: 'logged_in',
      evidence: {
        verifier: 'url_contains',
        url: 'https://example.test/account',
      },
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('logged_in');
    expect(second.verified).toBe(true);
    expect(second.verifiedAt).toBeInstanceOf(Date);

    const latest = await service.getLoginState({
      profileId: 'profile-1',
      site: 'example',
    });
    expect(latest).toMatchObject({
      id: first.id,
      profileId: 'profile-1',
      site: 'example',
      loginUrl: 'https://example.test/account',
      runtimeId: 'electron-webcontents',
      status: 'logged_in',
      verified: true,
    });
  });

  it('redacts credential-like evidence before persistence', async () => {
    const service = await openService();

    const state = await service.upsertLoginState({
      profileId: 'profile-1',
      site: 'example',
      status: 'blocked',
      evidence: {
        authorization: 'Bearer secret',
        nested: {
          cookie: 'sid=secret',
          visibleText: 'captcha required',
        },
      },
    });

    expect(state.evidence).toEqual({
      authorization: '[REDACTED]',
      nested: {
        cookie: '[REDACTED]',
        visibleText: 'captcha required',
      },
    });
  });
});
