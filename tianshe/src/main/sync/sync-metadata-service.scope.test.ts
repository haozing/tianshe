import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { SyncMetadataService } from './sync-metadata-service';

describe('SyncMetadataService scope isolation', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let service: SyncMetadataService;

  beforeAll(async () => {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    service = new SyncMetadataService(conn);
    await service.initTable();
  });

  afterAll(() => {
    conn.closeSync();
    db.closeSync();
  });

  beforeEach(async () => {
    await conn.run('DELETE FROM sync_entity_mappings_v2');
    await conn.run('DELETE FROM sync_domain_state_v2');
  });

  it('isolates domain state by scope key', async () => {
    await service.setDomainState(
      {
        domain: 'account',
        domainVersion: 2,
      },
      { scopeKey: 'company:0' }
    );
    await service.setDomainState(
      {
        domain: 'account',
        domainVersion: 9,
      },
      { scopeKey: 'team:7' }
    );

    const companyState = await service.getDomainState('account', { scopeKey: 'company:0' });
    const teamState = await service.getDomainState('account', { scopeKey: 'team:7' });

    expect(companyState?.domainVersion).toBe(2);
    expect(teamState?.domainVersion).toBe(9);

    const companyRows = await service.listDomainStates({ scopeKey: 'company:0' });
    const teamRows = await service.listDomainStates({ scopeKey: 'team:7' });
    expect(companyRows).toHaveLength(1);
    expect(teamRows).toHaveLength(1);
    expect(companyRows[0]?.domain).toBe('account');
    expect(teamRows[0]?.domain).toBe('account');
  });

  it('isolates entity mapping by scope key', async () => {
    await service.upsertEntityMapping(
      {
        domain: 'profile',
        entityType: 'profile',
        localId: 'profile-1',
        globalUid: 'global-company',
        version: 1,
      },
      { scopeKey: 'company:0' }
    );
    await service.upsertEntityMapping(
      {
        domain: 'profile',
        entityType: 'profile',
        localId: 'profile-1',
        globalUid: 'global-team',
        version: 3,
      },
      { scopeKey: 'team:7' }
    );

    const companyByLocal = await service.getEntityMapping('profile', 'profile', 'profile-1', {
      scopeKey: 'company:0',
    });
    const teamByLocal = await service.getEntityMapping('profile', 'profile', 'profile-1', {
      scopeKey: 'team:7',
    });
    expect(companyByLocal?.globalUid).toBe('global-company');
    expect(teamByLocal?.globalUid).toBe('global-team');

    const companyByGlobal = await service.getEntityMappingByGlobalUid(
      'profile',
      'profile',
      'global-company',
      {
        scopeKey: 'company:0',
      }
    );
    const teamByGlobal = await service.getEntityMappingByGlobalUid('profile', 'profile', 'global-team', {
      scopeKey: 'team:7',
    });
    expect(companyByGlobal?.localId).toBe('profile-1');
    expect(teamByGlobal?.localId).toBe('profile-1');
  });
});

