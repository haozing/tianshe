import {
  addColumnIfMissingStep,
  type SchemaMigration,
} from './migration-engine';
import { UNBOUND_PROFILE_ID } from '../../types/profile';
import {
  BROWSER_POOL_LIMITS,
  DEFAULT_BROWSER_POOL_CONFIG,
} from '../../constants/browser-pool';

export const ACCOUNT_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'accounts-001-profile-fields',
    description: 'Add profile-bound account identity and credential fields',
    up: [
      addColumnIfMissingStep('accounts', 'platform_id', 'VARCHAR'),
      addColumnIfMissingStep('accounts', 'display_name', 'VARCHAR'),
      addColumnIfMissingStep('accounts', 'shop_id', 'VARCHAR'),
      addColumnIfMissingStep('accounts', 'shop_name', 'VARCHAR'),
      addColumnIfMissingStep('accounts', 'password', 'TEXT'),
      addColumnIfMissingStep('accounts', 'tags', `VARCHAR DEFAULT '[]'`),
    ],
  },
  {
    id: 'accounts-002-sync-fields',
    description: 'Add account sync ownership fields',
    up: [
      addColumnIfMissingStep('accounts', 'sync_source_id', 'VARCHAR'),
      addColumnIfMissingStep('accounts', 'sync_owner_user_id', 'BIGINT'),
      addColumnIfMissingStep('accounts', 'sync_owner_user_name', 'VARCHAR'),
      addColumnIfMissingStep('accounts', 'sync_permission', `VARCHAR DEFAULT 'mine/edit'`),
      addColumnIfMissingStep('accounts', 'sync_scope_type', 'VARCHAR'),
      addColumnIfMissingStep('accounts', 'sync_scope_id', 'BIGINT'),
      addColumnIfMissingStep('accounts', 'sync_managed', 'BOOLEAN DEFAULT FALSE'),
      addColumnIfMissingStep('accounts', 'sync_updated_at', 'TIMESTAMP'),
    ],
  },
];

export const ACCOUNT_SCHEMA_BACKFILLS: string[] = [
  `
    UPDATE accounts
    SET profile_id = '${UNBOUND_PROFILE_ID}'
    WHERE profile_id IS NULL OR TRIM(CAST(profile_id AS VARCHAR)) = ''
  `,
  `
    UPDATE accounts
    SET tags = '[]'
    WHERE tags IS NULL OR TRIM(CAST(tags AS VARCHAR)) = ''
  `,
  `
    UPDATE accounts
    SET sync_managed = FALSE
    WHERE sync_managed IS NULL
  `,
  `
    UPDATE accounts
    SET sync_permission = CASE
      WHEN sync_managed = TRUE THEN 'shared/view_use'
      ELSE 'mine/edit'
    END
    WHERE sync_permission IS NULL OR TRIM(CAST(sync_permission AS VARCHAR)) = ''
  `,
];

export const SAVED_SITE_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'saved-sites-001-sync-fields',
    description: 'Add saved site sync ownership fields',
    up: [
      addColumnIfMissingStep('saved_sites', 'sync_source_id', 'VARCHAR'),
      addColumnIfMissingStep('saved_sites', 'sync_canonical_name', 'VARCHAR'),
      addColumnIfMissingStep('saved_sites', 'sync_owner_user_id', 'BIGINT'),
      addColumnIfMissingStep('saved_sites', 'sync_owner_user_name', 'VARCHAR'),
      addColumnIfMissingStep('saved_sites', 'sync_scope_type', 'VARCHAR'),
      addColumnIfMissingStep('saved_sites', 'sync_scope_id', 'BIGINT'),
      addColumnIfMissingStep('saved_sites', 'sync_managed', 'BOOLEAN DEFAULT FALSE'),
      addColumnIfMissingStep('saved_sites', 'sync_updated_at', 'TIMESTAMP'),
    ],
  },
];

export const SAVED_SITE_SCHEMA_BACKFILLS: string[] = [
  `
    UPDATE saved_sites
    SET usage_count = 0
    WHERE usage_count IS NULL
  `,
  `
    UPDATE saved_sites
    SET sync_managed = FALSE
    WHERE sync_managed IS NULL
  `,
  `
    UPDATE saved_sites
    SET sync_source_id = NULL
    WHERE sync_source_id IS NOT NULL
      AND TRIM(CAST(sync_source_id AS VARCHAR)) = ''
  `,
  `
    UPDATE saved_sites
    SET sync_canonical_name = NULL
    WHERE sync_canonical_name IS NOT NULL
      AND TRIM(CAST(sync_canonical_name AS VARCHAR)) = ''
  `,
];

export const TAG_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'tags-001-sync-fields',
    description: 'Add tag sync ownership fields',
    up: [
      addColumnIfMissingStep('tags', 'sync_owner_user_id', 'BIGINT'),
      addColumnIfMissingStep('tags', 'sync_owner_user_name', 'VARCHAR'),
      addColumnIfMissingStep('tags', 'sync_scope_type', 'VARCHAR'),
      addColumnIfMissingStep('tags', 'sync_scope_id', 'BIGINT'),
      addColumnIfMissingStep('tags', 'sync_managed', 'BOOLEAN DEFAULT FALSE'),
      addColumnIfMissingStep('tags', 'sync_updated_at', 'TIMESTAMP'),
    ],
  },
];

export const TAG_SCHEMA_BACKFILLS: string[] = [
  `
    UPDATE tags
    SET sync_managed = FALSE
    WHERE sync_managed IS NULL
  `,
];

export const BROWSER_PROFILE_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'browser-profiles-001-runtime-pool-fields',
    description: 'Add browser runtime and pool fields',
    up: [
      addColumnIfMissingStep(
        'browser_profiles',
        'runtime_id',
        `VARCHAR DEFAULT 'electron-webcontents'`
      ),
      addColumnIfMissingStep('browser_profiles', 'runtime_source_override', 'JSON'),
      addColumnIfMissingStep('browser_profiles', 'quota', 'INTEGER DEFAULT 1'),
      addColumnIfMissingStep(
        'browser_profiles',
        'idle_timeout_ms',
        'INTEGER DEFAULT 300000'
      ),
      addColumnIfMissingStep(
        'browser_profiles',
        'lock_timeout_ms',
        'INTEGER DEFAULT 300000'
      ),
      addColumnIfMissingStep('browser_profiles', 'is_system', 'BOOLEAN DEFAULT FALSE'),
    ],
  },
  {
    id: 'browser-profiles-002-fingerprint-split',
    description: 'Add split fingerprint configuration fields',
    up: [
      addColumnIfMissingStep('browser_profiles', 'fingerprint_core', 'JSON'),
      addColumnIfMissingStep('browser_profiles', 'fingerprint_source', 'JSON'),
    ],
  },
];

export const BROWSER_PROFILE_SCHEMA_BACKFILLS: string[] = [
  `
    UPDATE browser_profiles
    SET runtime_id = 'electron-webcontents'
    WHERE runtime_id IS NULL OR COALESCE(TRIM(runtime_id), '') = ''
  `,
  `
    UPDATE browser_profiles
    SET quota = 1
    WHERE quota IS NULL OR quota <> 1
  `,
  `
    UPDATE browser_profiles
    SET idle_timeout_ms = ${DEFAULT_BROWSER_POOL_CONFIG.defaultIdleTimeoutMs}
    WHERE idle_timeout_ms IS NULL OR idle_timeout_ms < ${BROWSER_POOL_LIMITS.defaultIdleTimeoutMs.min}
  `,
  `
    UPDATE browser_profiles
    SET lock_timeout_ms = ${DEFAULT_BROWSER_POOL_CONFIG.defaultLockTimeoutMs}
    WHERE lock_timeout_ms IS NULL OR lock_timeout_ms < ${BROWSER_POOL_LIMITS.defaultLockTimeoutMs.min}
  `,
  `
    UPDATE browser_profiles
    SET is_system = FALSE
    WHERE is_system IS NULL
  `,
];

export const SCHEDULED_TASK_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'scheduled-tasks-001-resource-lock-fields',
    description: 'Add resource lock fields to scheduled tasks',
    up: [
      addColumnIfMissingStep('scheduled_tasks', 'resource_keys', 'JSON'),
      addColumnIfMissingStep('scheduled_tasks', 'resource_wait_timeout_ms', 'BIGINT'),
    ],
  },
];

export const DATASET_METADATA_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'datasets-001-folder-and-plugin-fields',
    description: 'Add dataset folder ordering and plugin ownership fields',
    up: [
      addColumnIfMissingStep('datasets', 'folder_id', 'VARCHAR'),
      addColumnIfMissingStep('datasets', 'table_order', 'INTEGER DEFAULT 0'),
      addColumnIfMissingStep('datasets', 'created_by_plugin', 'VARCHAR'),
    ],
  },
  {
    id: 'datasets-002-tab-group-fields',
    description: 'Add dataset tab group fields',
    up: [
      addColumnIfMissingStep('datasets', 'tab_group_id', 'VARCHAR'),
      addColumnIfMissingStep('datasets', 'tab_order', 'INTEGER DEFAULT 0'),
      addColumnIfMissingStep('datasets', 'is_group_default', 'BOOLEAN DEFAULT FALSE'),
    ],
  },
];

export const EXTENSION_PACKAGE_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'extension-packages-001-package-metadata',
    description: 'Add extension package source and runtime metadata',
    up: [
      addColumnIfMissingStep(
        'extension_packages',
        'source_type',
        `VARCHAR DEFAULT 'local'`
      ),
      addColumnIfMissingStep('extension_packages', 'source_url', 'TEXT'),
      addColumnIfMissingStep('extension_packages', 'archive_sha256', 'VARCHAR'),
      addColumnIfMissingStep('extension_packages', 'manifest_json', 'JSON'),
      addColumnIfMissingStep('extension_packages', 'extract_dir', 'VARCHAR'),
      addColumnIfMissingStep('extension_packages', 'enabled', 'BOOLEAN DEFAULT TRUE'),
      addColumnIfMissingStep(
        'extension_packages',
        'created_at',
        'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
      ),
      addColumnIfMissingStep(
        'extension_packages',
        'updated_at',
        'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
      ),
    ],
  },
];

export const EXTENSION_PACKAGE_SCHEMA_BACKFILLS: string[] = [
  `UPDATE extension_packages SET enabled = TRUE WHERE enabled IS NULL`,
  `UPDATE extension_packages SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`,
  `UPDATE extension_packages SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`,
  `
    UPDATE extension_packages
    SET source_type = 'local'
    WHERE source_type IS NULL OR trim(source_type) = ''
  `,
];

export const PROFILE_EXTENSION_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'profile-extensions-001-binding-metadata',
    description: 'Add profile extension binding metadata',
    up: [
      addColumnIfMissingStep('profile_extensions', 'version', 'VARCHAR'),
      addColumnIfMissingStep('profile_extensions', 'install_mode', `VARCHAR DEFAULT 'required'`),
      addColumnIfMissingStep('profile_extensions', 'sort_order', 'INTEGER DEFAULT 0'),
      addColumnIfMissingStep('profile_extensions', 'enabled', 'BOOLEAN DEFAULT TRUE'),
      addColumnIfMissingStep(
        'profile_extensions',
        'created_at',
        'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
      ),
      addColumnIfMissingStep(
        'profile_extensions',
        'updated_at',
        'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
      ),
    ],
  },
];

export const PROFILE_EXTENSION_SCHEMA_BACKFILLS: string[] = [
  `
    UPDATE profile_extensions
    SET install_mode = 'required'
    WHERE install_mode IS NULL OR trim(install_mode) = ''
  `,
  `UPDATE profile_extensions SET sort_order = 0 WHERE sort_order IS NULL`,
  `UPDATE profile_extensions SET enabled = TRUE WHERE enabled IS NULL`,
  `UPDATE profile_extensions SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`,
  `UPDATE profile_extensions SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`,
];

export const PLUGIN_TABLE_SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'plugin-tables-001-legacy-columns',
    description: 'Add plugin table columns introduced after the original bootstrap',
    up: [
      addColumnIfMissingStep('datasets', 'created_by_plugin', 'VARCHAR'),
      addColumnIfMissingStep('js_plugin_toolbar_buttons', 'applies_to', 'JSON'),
      addColumnIfMissingStep('js_plugin_action_columns', 'applies_to', 'JSON'),
      addColumnIfMissingStep('recordings', 'description', 'VARCHAR'),
      addColumnIfMissingStep('recordings', 'start_url', 'VARCHAR'),
      addColumnIfMissingStep('recordings', 'browser_type', `VARCHAR DEFAULT 'chromium'`),
      addColumnIfMissingStep('recordings', 'viewport', 'JSON'),
      addColumnIfMissingStep('recordings', 'status', `VARCHAR DEFAULT 'recording'`),
      addColumnIfMissingStep('recordings', 'completed_at', 'BIGINT'),
      addColumnIfMissingStep('recordings', 'duration', 'BIGINT'),
      addColumnIfMissingStep('recordings', 'metadata', 'JSON'),
    ],
  },
  {
    id: 'plugin-tables-002-uninstall-state',
    description: 'Add plugin uninstall compensation state fields',
    up: [
      addColumnIfMissingStep('js_plugins', 'lifecycle_state', `VARCHAR DEFAULT 'installed'`),
      addColumnIfMissingStep('js_plugins', 'uninstall_delete_tables', 'BOOLEAN'),
      addColumnIfMissingStep('js_plugins', 'uninstall_started_at', 'BIGINT'),
    ],
  },
];

export async function runSchemaBackfills(
  conn: { run(sql: string): Promise<unknown> },
  statements: string[]
): Promise<void> {
  for (const statement of statements) {
    await conn.run(statement);
  }
}
