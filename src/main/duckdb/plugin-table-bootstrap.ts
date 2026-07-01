import type { DuckDBConnection } from '@duckdb/node-api';
import { SchemaMigrationEngine } from './migration-engine';
import { PLUGIN_TABLE_SCHEMA_MIGRATIONS } from './schema-migrations';
import { runInDuckDbTransaction } from './utils';
import { createLogger } from '../../core/logger';

const logger = createLogger('PluginTableBootstrap');

const PLUGIN_TABLE_CREATE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS json_plugins (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      version VARCHAR NOT NULL,
      config JSON NOT NULL,
      installed_at BIGINT NOT NULL,
      updated_at BIGINT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS js_plugins (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      version VARCHAR NOT NULL,
      author VARCHAR NOT NULL,
      description VARCHAR,
      icon VARCHAR,
      category VARCHAR,
      main VARCHAR NOT NULL,
      path VARCHAR NOT NULL,
      installed_at BIGINT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      dev_mode BOOLEAN DEFAULT FALSE,
      source_path VARCHAR,
      is_symlink BOOLEAN DEFAULT FALSE,
      hot_reload_enabled BOOLEAN DEFAULT TRUE,
      lifecycle_state VARCHAR DEFAULT 'installed',
      uninstall_delete_tables BOOLEAN,
      uninstall_started_at BIGINT,
      source_type VARCHAR DEFAULT 'local_private',
      install_channel VARCHAR DEFAULT 'manual_import',
      cloud_plugin_code VARCHAR,
      cloud_release_version VARCHAR,
      managed_by_policy BOOLEAN DEFAULT FALSE,
      policy_version VARCHAR,
      last_policy_sync_at BIGINT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dataset_plugin_bindings (
      id VARCHAR PRIMARY KEY,
      dataset_id VARCHAR NOT NULL,
      plugin_id VARCHAR NOT NULL,
      binding_type VARCHAR NOT NULL,
      created_by VARCHAR NOT NULL,
      default_parameter_mapping JSON NOT NULL,
      toolbar_order INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT true,
      created_at BIGINT NOT NULL,
      updated_at BIGINT,
      UNIQUE(dataset_id, plugin_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dataset_action_columns (
      id VARCHAR PRIMARY KEY,
      dataset_id VARCHAR NOT NULL,
      column_name VARCHAR NOT NULL,
      plugin_id VARCHAR NOT NULL,
      parameter_mapping JSON NOT NULL,
      display_config JSON,
      column_order INTEGER,
      created_at BIGINT NOT NULL,
      updated_at BIGINT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dataset_folders (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      parent_id VARCHAR,
      plugin_id VARCHAR,
      description VARCHAR,
      icon VARCHAR,
      folder_order INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dataset_query_templates (
      id VARCHAR PRIMARY KEY,
      dataset_id VARCHAR NOT NULL,
      name VARCHAR NOT NULL,
      description VARCHAR,
      icon VARCHAR,
      query_config JSON NOT NULL,
      snapshot_table_name VARCHAR,
      is_default BOOLEAN DEFAULT FALSE,
      template_order INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT,
      last_accessed_at BIGINT,
      access_count INTEGER DEFAULT 0
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS plugin_secure_data (
      plugin_id VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      encrypted_value TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS js_plugin_action_columns (
      id VARCHAR PRIMARY KEY,
      plugin_id VARCHAR NOT NULL,
      contribution_id VARCHAR NOT NULL,
      column_name VARCHAR NOT NULL,
      label VARCHAR NOT NULL,
      icon VARCHAR NOT NULL,
      confirm_message VARCHAR,
      variant VARCHAR DEFAULT 'default',
      command_id VARCHAR NOT NULL,
      parameter_mapping JSON,
      applies_to JSON,
      column_order INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      UNIQUE(plugin_id, contribution_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS js_plugin_toolbar_buttons (
      id VARCHAR PRIMARY KEY,
      plugin_id VARCHAR NOT NULL,
      contribution_id VARCHAR NOT NULL,
      label VARCHAR NOT NULL,
      icon VARCHAR NOT NULL,
      confirm_message VARCHAR,
      command_id VARCHAR NOT NULL,
      requires_selection BOOLEAN DEFAULT false,
      min_selection INTEGER DEFAULT 0,
      max_selection INTEGER,
      applies_to JSON,
      button_order INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      UNIQUE(plugin_id, contribution_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS js_plugin_commands (
      id VARCHAR PRIMARY KEY,
      plugin_id VARCHAR NOT NULL,
      command_id VARCHAR NOT NULL,
      title VARCHAR NOT NULL,
      category VARCHAR,
      description VARCHAR,
      created_at BIGINT NOT NULL,
      UNIQUE(plugin_id, command_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS plugin_configurations (
      plugin_id VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      value TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS plugin_data (
      plugin_id VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      value TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS plugin_relational_state (
      plugin_id VARCHAR NOT NULL,
      namespace VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      value JSON,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (plugin_id, namespace, key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS plugin_state_migrations (
      plugin_id VARCHAR NOT NULL,
      namespace VARCHAR NOT NULL,
      migration_id VARCHAR NOT NULL,
      checksum VARCHAR NOT NULL,
      description TEXT,
      applied_at BIGINT NOT NULL,
      PRIMARY KEY (plugin_id, namespace, migration_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS js_plugin_custom_pages (
      id VARCHAR PRIMARY KEY,
      plugin_id VARCHAR NOT NULL,
      page_id VARCHAR NOT NULL,
      title VARCHAR NOT NULL,
      icon VARCHAR,
      description TEXT,
      display_mode VARCHAR NOT NULL,
      source_type VARCHAR NOT NULL,
      source_path VARCHAR,
      source_url VARCHAR,
      applies_to JSON,
      popup_config JSON,
      security_config JSON,
      communication_config JSON,
      order_index INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      UNIQUE(plugin_id, page_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS recordings (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      description VARCHAR,
      start_url VARCHAR NOT NULL,
      browser_type VARCHAR DEFAULT 'chromium',
      viewport JSON,
      status VARCHAR DEFAULT 'recording',
      created_at BIGINT NOT NULL,
      completed_at BIGINT,
      duration BIGINT,
      metadata JSON
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS pw_actions (
      id VARCHAR PRIMARY KEY,
      recording_id VARCHAR NOT NULL,
      sequence INTEGER NOT NULL,
      action_type VARCHAR NOT NULL,
      locator VARCHAR,
      locator_type VARCHAR,
      value VARCHAR,
      options JSON,
      page_url VARCHAR,
      timestamp BIGINT NOT NULL,
      element_state JSON,
      screenshot_path VARCHAR
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS pw_network_logs (
      id VARCHAR PRIMARY KEY,
      recording_id VARCHAR NOT NULL,
      action_id VARCHAR,
      url VARCHAR NOT NULL,
      method VARCHAR NOT NULL,
      status_code INTEGER,
      request_headers JSON,
      response_headers JSON,
      request_body TEXT,
      response_body TEXT,
      response_time INTEGER,
      timestamp BIGINT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS pw_console_logs (
      id VARCHAR PRIMARY KEY,
      recording_id VARCHAR NOT NULL,
      action_id VARCHAR,
      log_type VARCHAR NOT NULL,
      message TEXT NOT NULL,
      args JSON,
      stack_trace TEXT,
      timestamp BIGINT NOT NULL
    )
  `,
] as const;

const PLUGIN_TABLE_INDEX_STATEMENTS = [
  `
    CREATE INDEX IF NOT EXISTS idx_bindings_dataset
    ON dataset_plugin_bindings(dataset_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_bindings_plugin
    ON dataset_plugin_bindings(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_action_columns_dataset
    ON dataset_action_columns(dataset_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_action_columns_plugin
    ON dataset_action_columns(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_folders_parent
    ON dataset_folders(parent_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_folders_plugin
    ON dataset_folders(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_query_templates_dataset
    ON dataset_query_templates(dataset_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_plugin_secure_data_plugin_id
    ON plugin_secure_data(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_datasets_created_by_plugin
    ON datasets(created_by_plugin)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_js_plugin_action_columns_plugin
    ON js_plugin_action_columns(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_js_plugin_toolbar_buttons_plugin
    ON js_plugin_toolbar_buttons(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_js_plugin_commands_plugin
    ON js_plugin_commands(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_js_plugin_custom_pages_plugin
    ON js_plugin_custom_pages(plugin_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_js_plugin_custom_pages_display_mode
    ON js_plugin_custom_pages(display_mode)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_plugin_relational_state_plugin_namespace
    ON plugin_relational_state(plugin_id, namespace)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_plugin_state_migrations_plugin_namespace
    ON plugin_state_migrations(plugin_id, namespace)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_pw_actions_recording
    ON pw_actions(recording_id, sequence)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_pw_network_recording
    ON pw_network_logs(recording_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_pw_console_recording
    ON pw_console_logs(recording_id)
  `,
] as const;

export async function initPluginTables(conn: DuckDBConnection): Promise<void> {
  try {
    await runInDuckDbTransaction(conn, async () => {
      for (const statement of PLUGIN_TABLE_CREATE_STATEMENTS) {
        await conn.run(statement);
      }
    });
    await new SchemaMigrationEngine(conn).migrate(PLUGIN_TABLE_SCHEMA_MIGRATIONS);
    logger.info('Plugin tables created and migrated');
  } catch (error) {
    logger.error('Plugin tables creation failed', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  try {
    await runInDuckDbTransaction(conn, async () => {
      for (const statement of PLUGIN_TABLE_INDEX_STATEMENTS) {
        await conn.run(statement);
      }
    });
    logger.info('Plugin table indexes created in transaction');
  } catch (error) {
    logger.warn('Plugin table index creation failed', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info('Plugin tables initialized');
}
