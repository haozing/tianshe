import { DuckDBConnection } from '@duckdb/node-api';
import type {
  ObservationSink,
  RuntimeArtifact,
  RuntimeEvent,
} from '../../core/observability/types';
import { createLogger } from '../../core/logger';
import { parseRows } from './utils';
import { allPrepared, runPrepared } from './statement-executor';

const logger = createLogger('RuntimeObservationService');
const DEFAULT_RUNTIME_OBSERVATION_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RuntimeEventRow {
  id: string;
  trace_id: string;
  span_id?: string | null;
  parent_span_id?: string | null;
  timestamp: number;
  seq: number;
  level: RuntimeEvent['level'];
  event: string;
  outcome?: RuntimeEvent['outcome'] | null;
  component: string;
  message?: string | null;
  duration_ms?: number | null;
  source?: string | null;
  capability?: string | null;
  plugin_id?: string | null;
  browser_runtime_id?: RuntimeEvent['browserRuntimeId'] | null;
  session_id?: string | null;
  profile_id?: string | null;
  dataset_id?: string | null;
  browser_id?: string | null;
  attrs?: string | null;
  error?: string | null;
  artifact_refs?: string | null;
}

interface RuntimeArtifactRow {
  id: string;
  trace_id: string;
  span_id?: string | null;
  parent_span_id?: string | null;
  timestamp: number;
  seq: number;
  type: RuntimeArtifact['type'];
  component: string;
  label?: string | null;
  mime_type?: string | null;
  source?: string | null;
  capability?: string | null;
  plugin_id?: string | null;
  browser_runtime_id?: RuntimeArtifact['browserRuntimeId'] | null;
  session_id?: string | null;
  profile_id?: string | null;
  dataset_id?: string | null;
  browser_id?: string | null;
  attrs?: string | null;
  data?: string | null;
}

export interface RuntimeObservationRetentionCleanupOptions {
  daysToKeep?: number;
  now?: number;
}

export interface RuntimeObservationRetentionCleanupResult {
  cutoffTimestamp: number;
  eventsDeleted: number;
  artifactsDeleted: number;
}

function parseJson<T>(
  value: string | null | undefined,
  context?: { rowId: string; table: 'runtime_events' | 'runtime_artifacts'; field: string }
): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logger.warn('Corrupted runtime observation JSON field ignored', {
      ...context,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export class RuntimeObservationService implements ObservationSink {
  private lastSeqTimestamp = 0;
  private lastSeqCounter = 0;

  constructor(private conn: DuckDBConnection) {}

  private nextSeq(): number {
    const now = Date.now();
    if (now === this.lastSeqTimestamp) {
      this.lastSeqCounter = (this.lastSeqCounter + 1) % 1000;
    } else {
      this.lastSeqTimestamp = now;
      this.lastSeqCounter = 0;
    }
    return now * 1000 + this.lastSeqCounter;
  }

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS runtime_events (
        id VARCHAR PRIMARY KEY,
        trace_id VARCHAR NOT NULL,
        span_id VARCHAR,
        parent_span_id VARCHAR,
        timestamp BIGINT NOT NULL,
        seq BIGINT NOT NULL,
        level VARCHAR NOT NULL,
        event VARCHAR NOT NULL,
        outcome VARCHAR,
        component VARCHAR NOT NULL,
        message TEXT,
        duration_ms BIGINT,
        source VARCHAR,
        capability VARCHAR,
        plugin_id VARCHAR,
        browser_runtime_id VARCHAR,
        session_id VARCHAR,
        profile_id VARCHAR,
        dataset_id VARCHAR,
        browser_id VARCHAR,
        attrs JSON,
        error JSON,
        artifact_refs JSON
      )
    `);

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS runtime_artifacts (
        id VARCHAR PRIMARY KEY,
        trace_id VARCHAR NOT NULL,
        span_id VARCHAR,
        parent_span_id VARCHAR,
        timestamp BIGINT NOT NULL,
        seq BIGINT NOT NULL,
        type VARCHAR NOT NULL,
        component VARCHAR NOT NULL,
        label VARCHAR,
        mime_type VARCHAR,
        source VARCHAR,
        capability VARCHAR,
        plugin_id VARCHAR,
        browser_runtime_id VARCHAR,
        session_id VARCHAR,
        profile_id VARCHAR,
        dataset_id VARCHAR,
        browser_id VARCHAR,
        attrs JSON,
        data JSON
      )
    `);

    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_trace_seq ON runtime_events(trace_id, seq)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_event ON runtime_events(event)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_trace_seq ON runtime_artifacts(trace_id, seq)`
    );
    await this.conn.run(
      `CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_type ON runtime_artifacts(type)`
    );
  }

  async recordEvent(event: RuntimeEvent): Promise<void> {
    await runPrepared(this.conn, `
      INSERT INTO runtime_events (
        id, trace_id, span_id, parent_span_id, timestamp, seq, level, event, outcome, component,
        message, duration_ms, source, capability, plugin_id, browser_runtime_id, session_id,
        profile_id, dataset_id, browser_id, attrs, error, artifact_refs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        event.eventId,
        event.traceId,
        event.spanId ?? null,
        event.parentSpanId ?? null,
        event.timestamp,
        this.nextSeq(),
        event.level,
        event.event,
        event.outcome ?? null,
        event.component,
        event.message ?? null,
        event.durationMs ?? null,
        event.source ?? null,
        event.capability ?? null,
        event.pluginId ?? null,
        event.browserRuntimeId ?? null,
        event.sessionId ?? null,
        event.profileId ?? null,
        event.datasetId ?? null,
        event.browserId ?? null,
        event.attrs ? JSON.stringify(event.attrs) : null,
        event.error ? JSON.stringify(event.error) : null,
        event.artifactRefs?.length ? JSON.stringify(event.artifactRefs) : null,
      ]);
  }

  async recordArtifact(artifact: RuntimeArtifact): Promise<void> {
    await runPrepared(this.conn, `
      INSERT INTO runtime_artifacts (
        id, trace_id, span_id, parent_span_id, timestamp, seq, type, component, label, mime_type,
        source, capability, plugin_id, browser_runtime_id, session_id, profile_id, dataset_id,
        browser_id, attrs, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        artifact.artifactId,
        artifact.traceId,
        artifact.spanId ?? null,
        artifact.parentSpanId ?? null,
        artifact.timestamp,
        this.nextSeq(),
        artifact.type,
        artifact.component,
        artifact.label ?? null,
        artifact.mimeType ?? null,
        artifact.source ?? null,
        artifact.capability ?? null,
        artifact.pluginId ?? null,
        artifact.browserRuntimeId ?? null,
        artifact.sessionId ?? null,
        artifact.profileId ?? null,
        artifact.datasetId ?? null,
        artifact.browserId ?? null,
        artifact.attrs ? JSON.stringify(artifact.attrs) : null,
        artifact.data !== undefined ? JSON.stringify(artifact.data) : null,
      ]);
  }

  async listEventsByTrace(traceId: string, limit?: number): Promise<RuntimeEvent[]> {
    const normalizedLimit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : null;
    let query = 'SELECT * FROM runtime_events WHERE trace_id = ? ORDER BY seq ASC';
    const params: any[] = [traceId];

    if (normalizedLimit) {
      query = `
        SELECT * FROM (
          SELECT * FROM runtime_events WHERE trace_id = ? ORDER BY seq DESC LIMIT ?
        ) AS limited_events
        ORDER BY seq ASC
      `;
      params.push(normalizedLimit);
    }

    const result = await allPrepared(this.conn, query, params);
    return parseRows<RuntimeEventRow>(result).map((row) => this.toRuntimeEvent(row));
  }

  async listArtifactsByTrace(traceId: string, limit?: number): Promise<RuntimeArtifact[]> {
    const normalizedLimit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : null;
    let query = 'SELECT * FROM runtime_artifacts WHERE trace_id = ? ORDER BY seq ASC';
    const params: any[] = [traceId];

    if (normalizedLimit) {
      query = `
        SELECT * FROM (
          SELECT * FROM runtime_artifacts WHERE trace_id = ? ORDER BY seq DESC LIMIT ?
        ) AS limited_artifacts
        ORDER BY seq ASC
      `;
      params.push(normalizedLimit);
    }

    const result = await allPrepared(this.conn, query, params);
    return parseRows<RuntimeArtifactRow>(result).map((row) => this.toRuntimeArtifact(row));
  }

  async getArtifactsByIds(ids: string[]): Promise<RuntimeArtifact[]> {
    const normalizedIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
    if (normalizedIds.length === 0) {
      return [];
    }

    const placeholders = normalizedIds.map(() => '?').join(', ');
    const result = await allPrepared(this.conn, `
      SELECT * FROM runtime_artifacts WHERE id IN (${placeholders}) ORDER BY seq ASC
    `, normalizedIds);

    return parseRows<RuntimeArtifactRow>(result).map((row) => this.toRuntimeArtifact(row));
  }

  async listRecentFailureEvents(limit: number): Promise<RuntimeEvent[]> {
    const normalizedLimit = Math.max(1, Math.floor(limit || 20));
    const result = await allPrepared(this.conn, `
      SELECT * FROM runtime_events
      WHERE outcome IN ('failed', 'blocked', 'timeout') OR level = 'error'
      ORDER BY seq DESC
      LIMIT ?
    `, [normalizedLimit]);

    return parseRows<RuntimeEventRow>(result)
      .map((row) => this.toRuntimeEvent(row))
      .reverse();
  }

  async getArtifactCountsByTraceIds(traceIds: string[]): Promise<Map<string, number>> {
    const normalizedTraceIds = Array.from(
      new Set(traceIds.map((traceId) => String(traceId || '').trim()).filter(Boolean))
    );
    if (normalizedTraceIds.length === 0) {
      return new Map();
    }

    const placeholders = normalizedTraceIds.map(() => '?').join(', ');
    const result = await allPrepared(this.conn, `
      SELECT trace_id, COUNT(*) AS artifact_count
      FROM runtime_artifacts
      WHERE trace_id IN (${placeholders})
      GROUP BY trace_id
    `, normalizedTraceIds);

    const rows = parseRows<Array<{ trace_id: string; artifact_count: number }>[number]>(result);
    return new Map(
      rows.map((row) => [String(row.trace_id), Number(row.artifact_count || 0)])
    );
  }

  async clearAll(): Promise<void> {
    await this.conn.run('DELETE FROM runtime_events');
    await this.conn.run('DELETE FROM runtime_artifacts');
  }

  async cleanupRetention(
    options: RuntimeObservationRetentionCleanupOptions = {}
  ): Promise<RuntimeObservationRetentionCleanupResult> {
    const daysToKeep =
      typeof options.daysToKeep === 'number' && Number.isFinite(options.daysToKeep)
        ? Math.max(1, Math.floor(options.daysToKeep))
        : DEFAULT_RUNTIME_OBSERVATION_RETENTION_DAYS;
    const now =
      typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
    const cutoffTimestamp = now - daysToKeep * DAY_MS;

    const artifactRows = parseRows<{ count: number }>(
      await allPrepared(
        this.conn,
        'SELECT COUNT(*) AS count FROM runtime_artifacts WHERE timestamp < ?',
        [cutoffTimestamp]
      )
    );
    const eventRows = parseRows<{ count: number }>(
      await allPrepared(this.conn, 'SELECT COUNT(*) AS count FROM runtime_events WHERE timestamp < ?', [
        cutoffTimestamp,
      ])
    );

    await runPrepared(this.conn, 'DELETE FROM runtime_artifacts WHERE timestamp < ?', [
      cutoffTimestamp,
    ]);
    await runPrepared(this.conn, 'DELETE FROM runtime_events WHERE timestamp < ?', [
      cutoffTimestamp,
    ]);

    return {
      cutoffTimestamp,
      artifactsDeleted: Number(artifactRows[0]?.count || 0),
      eventsDeleted: Number(eventRows[0]?.count || 0),
    };
  }

  private toRuntimeEvent(row: RuntimeEventRow): RuntimeEvent {
    const attrs = row.attrs
      ? parseJson<Record<string, unknown>>(row.attrs, {
          rowId: row.id,
          table: 'runtime_events',
          field: 'attrs',
        })
      : undefined;
    const error = row.error
      ? parseJson<RuntimeEvent['error']>(row.error, {
          rowId: row.id,
          table: 'runtime_events',
          field: 'error',
        })
      : undefined;
    const artifactRefs = row.artifact_refs
      ? parseJson<string[]>(row.artifact_refs, {
          rowId: row.id,
          table: 'runtime_events',
          field: 'artifact_refs',
        })
      : undefined;

    return {
      eventId: row.id,
      timestamp: Number(row.timestamp),
      traceId: row.trace_id,
      ...(row.span_id ? { spanId: row.span_id } : {}),
      ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
      level: row.level,
      event: row.event,
      ...(row.outcome ? { outcome: row.outcome } : {}),
      component: row.component,
      ...(row.message ? { message: row.message } : {}),
      ...(typeof row.duration_ms === 'number' ? { durationMs: Number(row.duration_ms) } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.capability ? { capability: row.capability } : {}),
      ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
      ...(row.browser_runtime_id ? { browserRuntimeId: row.browser_runtime_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.profile_id ? { profileId: row.profile_id } : {}),
      ...(row.dataset_id ? { datasetId: row.dataset_id } : {}),
      ...(row.browser_id ? { browserId: row.browser_id } : {}),
      ...(attrs ? { attrs } : {}),
      ...(error ? { error } : {}),
      ...(artifactRefs ? { artifactRefs } : {}),
    };
  }

  private toRuntimeArtifact(row: RuntimeArtifactRow): RuntimeArtifact {
    const attrs = row.attrs
      ? parseJson<Record<string, unknown>>(row.attrs, {
          rowId: row.id,
          table: 'runtime_artifacts',
          field: 'attrs',
        })
      : undefined;
    const data = row.data
      ? parseJson(row.data, {
          rowId: row.id,
          table: 'runtime_artifacts',
          field: 'data',
        })
      : undefined;

    return {
      artifactId: row.id,
      timestamp: Number(row.timestamp),
      traceId: row.trace_id,
      ...(row.span_id ? { spanId: row.span_id } : {}),
      ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
      type: row.type,
      component: row.component,
      ...(row.label ? { label: row.label } : {}),
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.capability ? { capability: row.capability } : {}),
      ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
      ...(row.browser_runtime_id ? { browserRuntimeId: row.browser_runtime_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.profile_id ? { profileId: row.profile_id } : {}),
      ...(row.dataset_id ? { datasetId: row.dataset_id } : {}),
      ...(row.browser_id ? { browserId: row.browser_id } : {}),
      ...(attrs ? { attrs } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  }
}
