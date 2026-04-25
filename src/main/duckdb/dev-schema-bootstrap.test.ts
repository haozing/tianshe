import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRows } from './utils';
import { ProfileService } from './profile-service';
import { SavedSiteService } from './saved-site-service';
import { TagService } from './tag-service';
import { AccountService } from './account-service';
import { DEFAULT_BROWSER_PROFILE } from '../../constants/browser-pool';
import { UNBOUND_PROFILE_ID } from '../../types/profile';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => process.cwd()),
  },
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      flushStorageData: vi.fn(),
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
      },
      storagePath: '',
    })),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

describe('DuckDB dev schema bootstrap', () => {
  let db: DuckDBInstance | null = null;
  let conn: DuckDBConnection | null = null;

  afterEach(() => {
    conn?.closeSync();
    db?.closeSync();
    conn = null;
    db = null;
  });

  it('converges legacy profile/account/site/tag tables to the latest schema at startup', async () => {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);

    await conn.run(`
      CREATE TABLE browser_profiles (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        group_id VARCHAR,
        partition VARCHAR NOT NULL UNIQUE,
        proxy_config JSON,
        fingerprint JSON NOT NULL,
        notes TEXT,
        tags JSON DEFAULT '[]',
        color VARCHAR,
        status VARCHAR DEFAULT 'idle',
        last_error TEXT,
        last_active_at TIMESTAMP,
        total_uses INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await conn.run(`
      INSERT INTO browser_profiles (id, name, partition, fingerprint, status)
      VALUES ('legacy-profile', 'Legacy Profile', 'persist:legacy-profile', '{}', 'idle')
    `);

    await conn.run(`
      CREATE TABLE accounts (
        id VARCHAR PRIMARY KEY,
        profile_id VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        login_url VARCHAR NOT NULL,
        notes TEXT,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await conn.run(`
      INSERT INTO accounts (id, profile_id, name, login_url)
      VALUES ('account-1', 'legacy-profile', 'Legacy Account', 'https://example.test/login')
    `);

    await conn.run(`
      CREATE TABLE saved_sites (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        url VARCHAR NOT NULL,
        icon VARCHAR,
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await conn.run(`
      INSERT INTO saved_sites (id, name, url)
      VALUES ('site-1', 'Legacy Site', 'https://example.test')
    `);

    await conn.run(`
      CREATE TABLE tags (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE,
        color VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await conn.run(`
      INSERT INTO tags (id, name, color)
      VALUES ('tag-1', 'legacy-tag', '#000000')
    `);

    const profileService = new ProfileService(conn as never);
    const savedSiteService = new SavedSiteService(conn as never);
    const tagService = new TagService(conn as never);
    const accountService = new AccountService(conn as never);

    await profileService.initTable();
    await savedSiteService.initTable();
    await tagService.initTable();
    await accountService.initTable();

    const browserProfileColumns = parseRows(
      await conn.runAndReadAll(`PRAGMA table_info('browser_profiles')`)
    ).map((row) => String(row.name));
    expect(browserProfileColumns).toEqual(
      expect.arrayContaining([
        'engine',
        'quota',
        'idle_timeout_ms',
        'lock_timeout_ms',
        'is_system',
        'fingerprint_core',
        'fingerprint_source',
      ])
    );

    const accountColumns = parseRows(await conn.runAndReadAll(`PRAGMA table_info('accounts')`)).map(
      (row) => String(row.name)
    );
    expect(accountColumns).toEqual(
      expect.arrayContaining([
        'platform_id',
        'display_name',
        'shop_id',
        'shop_name',
        'password',
        'sync_source_id',
        'sync_owner_user_id',
        'sync_owner_user_name',
        'sync_permission',
        'sync_scope_type',
        'sync_scope_id',
        'sync_managed',
        'sync_updated_at',
      ])
    );

    const savedSiteColumns = parseRows(
      await conn.runAndReadAll(`PRAGMA table_info('saved_sites')`)
    ).map((row) => String(row.name));
    expect(savedSiteColumns).toEqual(
      expect.arrayContaining([
        'sync_source_id',
        'sync_canonical_name',
        'sync_owner_user_id',
        'sync_owner_user_name',
        'sync_scope_type',
        'sync_scope_id',
        'sync_managed',
        'sync_updated_at',
      ])
    );

    const tagColumns = parseRows(await conn.runAndReadAll(`PRAGMA table_info('tags')`)).map((row) =>
      String(row.name)
    );
    expect(tagColumns).toEqual(
      expect.arrayContaining([
        'sync_owner_user_id',
        'sync_owner_user_name',
        'sync_scope_type',
        'sync_scope_id',
        'sync_managed',
        'sync_updated_at',
      ])
    );

    const defaultProfile = await profileService.get(DEFAULT_BROWSER_PROFILE.id);
    expect(defaultProfile).not.toBeNull();
    expect(defaultProfile?.isSystem).toBe(true);
    expect(await profileService.get('legacy-profile')).toBeNull();

    const accountRows = parseRows(
      await conn.runAndReadAll(`
        SELECT profile_id, tags, sync_permission, sync_managed
        FROM accounts
        WHERE id = 'account-1'
      `)
    );
    expect(accountRows[0]?.profile_id).toBe(UNBOUND_PROFILE_ID);
    expect(accountRows[0]?.tags).toBe('[]');
    expect(accountRows[0]?.sync_permission).toBe('mine/edit');
    expect(accountRows[0]?.sync_managed).toBe(false);
  });
});
