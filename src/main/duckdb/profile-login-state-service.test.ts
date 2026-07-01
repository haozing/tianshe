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

  async function createProfileSnapshotTable(): Promise<void> {
    await conn!.run(`
      CREATE TABLE browser_profiles (
        id VARCHAR PRIMARY KEY,
        runtime_id VARCHAR,
        login_state_revision INTEGER DEFAULT 0
      )
    `);
  }

  async function upsertProfileSnapshot(
    profileId: string,
    runtimeId = 'electron-webcontents',
    revision = 0
  ): Promise<void> {
    await conn!.run(`
      INSERT INTO browser_profiles (id, runtime_id, login_state_revision)
      VALUES ('${profileId}', '${runtimeId}', ${revision})
    `);
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
      runtimeIdSnapshot: 'electron-webcontents',
      runtimeId: 'electron-webcontents',
      profileRevision: 0,
      status: 'logged_in',
      verified: true,
    });
  });

  it('stores writer role and expires states when profile revision changes', async () => {
    const service = await openService();
    await createProfileSnapshotTable();
    await upsertProfileSnapshot('profile-1', 'electron-webcontents', 1);

    const state = await service.upsertLoginState({
      profileId: 'profile-1',
      site: 'example',
      status: 'logged_in',
      verifiedBy: 'trusted_site_adapter_verifier',
    });

    expect(state).toMatchObject({
      runtimeIdSnapshot: 'electron-webcontents',
      runtimeId: 'electron-webcontents',
      profileRevision: 1,
      verifiedBy: 'trusted_site_adapter_verifier',
      status: 'logged_in',
      verified: true,
    });

    await conn!.run(`
      UPDATE browser_profiles
      SET login_state_revision = 2
      WHERE id = 'profile-1'
    `);

    const expired = await service.getLoginState({
      profileId: 'profile-1',
      site: 'example',
    });

    expect(expired).toMatchObject({
      id: state.id,
      status: 'expired',
      verified: false,
      verifiedAt: null,
      reason: 'profile login state expired after profile runtime or revision changed',
    });
  });

  it('expires states when the profile runtime snapshot changes', async () => {
    const service = await openService();
    await createProfileSnapshotTable();
    await upsertProfileSnapshot('profile-1', 'electron-webcontents', 0);

    await service.upsertLoginState({
      profileId: 'profile-1',
      site: 'example',
      status: 'logged_in',
    });

    await conn!.run(`
      UPDATE browser_profiles
      SET runtime_id = 'chromium-extension-relay'
      WHERE id = 'profile-1'
    `);

    const expired = await service.getLoginState({
      profileId: 'profile-1',
      site: 'example',
    });

    expect(expired).toMatchObject({
      status: 'expired',
      verified: false,
      reason: 'profile login state expired after profile runtime or revision changed',
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

  it('persists expired login state as an unverified human-handoff state', async () => {
    const service = await openService();

    const state = await service.upsertLoginState({
      profileId: 'profile-1',
      site: 'example',
      runtimeId: 'electron-webcontents',
      status: 'expired',
      reason: 'session cookie expired',
    });

    expect(state.status).toBe('expired');
    expect(state.verified).toBe(false);
    expect(state.verifiedAt).toBeNull();

    const latest = await service.getLoginState({
      profileId: 'profile-1',
      site: 'example',
    });
    expect(latest).toMatchObject({
      profileId: 'profile-1',
      site: 'example',
      status: 'expired',
      verified: false,
      reason: 'session cookie expired',
    });
  });
});
