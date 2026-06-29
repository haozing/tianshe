import type { DuckDBConnection } from '@duckdb/node-api';
import { v4 as uuidv4 } from 'uuid';
import {
  PROFILE_LOGIN_STATE_STATUSES,
  type BrowserRuntimeId,
  type ProfileLoginState,
  type ProfileLoginStateStatus,
  type UpsertProfileLoginStateParams,
  isBrowserRuntimeId,
} from '../../types/profile';
import { redactSensitiveValue } from '../../utils/redaction';
import { allPrepared, runPrepared } from './statement-executor';
import { parseRows } from './utils';

const LOGIN_STATE_STATUSES = new Set<string>(PROFILE_LOGIN_STATE_STATUSES);

const asOptionalText = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
};

const assertRequiredText = (value: unknown, fieldName: string): string => {
  const normalized = asOptionalText(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
};

const normalizeStatus = (value: unknown): ProfileLoginStateStatus => {
  const normalized = String(value ?? '').trim();
  if (LOGIN_STATE_STATUSES.has(normalized)) {
    return normalized as ProfileLoginStateStatus;
  }
  throw new Error(`Unsupported profile login state status: ${normalized || '(empty)'}`);
};

const normalizeRuntimeId = (value: unknown): BrowserRuntimeId | null => {
  const normalized = asOptionalText(value);
  if (!normalized) return null;
  if (!isBrowserRuntimeId(normalized)) {
    throw new Error(`Unsupported profile login runtime: ${normalized}`);
  }
  return normalized;
};

const toDate = (value: unknown): Date => {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value ?? ''));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
};

const serializeEvidence = (value: Record<string, unknown> | null | undefined): string | null => {
  if (!value) return null;
  return JSON.stringify(redactSensitiveValue(value));
};

const parseEvidence = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

interface ProfileLoginStateRow {
  id: unknown;
  profile_id: unknown;
  account_id: unknown;
  site: unknown;
  login_url: unknown;
  runtime_id: unknown;
  status: unknown;
  verified: unknown;
  last_checked_at: unknown;
  verified_at: unknown;
  evidence_artifact_id: unknown;
  evidence: unknown;
  reason: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export class ProfileLoginStateService {
  constructor(private readonly conn: DuckDBConnection) {}

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS profile_login_states (
        id                   VARCHAR PRIMARY KEY,
        profile_id           VARCHAR NOT NULL,
        account_id           VARCHAR,
        site                 VARCHAR NOT NULL,
        login_url            VARCHAR,
        runtime_id           VARCHAR,
        status               VARCHAR NOT NULL,
        verified             BOOLEAN DEFAULT FALSE,
        last_checked_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        verified_at          TIMESTAMP,
        evidence_artifact_id VARCHAR,
        evidence             JSON,
        reason               TEXT,
        created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_profile_login_states_profile_site
      ON profile_login_states(profile_id, site)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_profile_login_states_status
      ON profile_login_states(status)
    `);
  }

  async getLoginState(query: {
    profileId: string;
    site?: string | null;
    accountId?: string | null;
  }): Promise<ProfileLoginState | null> {
    const profileId = assertRequiredText(query.profileId, 'profileId');
    const site = asOptionalText(query.site) || '';
    const accountId = asOptionalText(query.accountId) || '';

    const result = await allPrepared(
      this.conn,
      `
      SELECT *
      FROM profile_login_states
      WHERE profile_id = ?
        AND (? = '' OR site = ?)
        AND (? = '' OR COALESCE(account_id, '') = ?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
      [profileId, site, site, accountId, accountId]
    );
    const rows = parseRows<ProfileLoginStateRow>(result);
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async upsertLoginState(params: UpsertProfileLoginStateParams): Promise<ProfileLoginState> {
    const profileId = assertRequiredText(params.profileId, 'profileId');
    const site = assertRequiredText(params.site, 'site');
    const accountId = asOptionalText(params.accountId);
    const status = normalizeStatus(params.status);
    const runtimeId = normalizeRuntimeId(params.runtimeId);
    const verified = params.verified ?? status === 'logged_in';
    const now = new Date();
    const lastCheckedAt = params.lastCheckedAt ?? now;
    const verifiedAt = verified ? params.verifiedAt ?? now : params.verifiedAt ?? null;
    const evidence = serializeEvidence(params.evidence);
    const existing = await this.getLoginState({ profileId, site, accountId });

    if (existing) {
      await runPrepared(
        this.conn,
        `
        UPDATE profile_login_states
        SET login_url = ?,
            runtime_id = ?,
            status = ?,
            verified = ?,
            last_checked_at = ?,
            verified_at = ?,
            evidence_artifact_id = ?,
            evidence = ?,
            reason = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        [
          asOptionalText(params.loginUrl),
          runtimeId,
          status,
          verified,
          lastCheckedAt.toISOString(),
          verifiedAt ? verifiedAt.toISOString() : null,
          asOptionalText(params.evidenceArtifactId),
          evidence,
          asOptionalText(params.reason),
          existing.id,
        ]
      );
      return (await this.getById(existing.id)) as ProfileLoginState;
    }

    const id = uuidv4();
    await runPrepared(
      this.conn,
      `
      INSERT INTO profile_login_states (
        id, profile_id, account_id, site, login_url, runtime_id, status, verified,
        last_checked_at, verified_at, evidence_artifact_id, evidence, reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
      [
        id,
        profileId,
        accountId,
        site,
        asOptionalText(params.loginUrl),
        runtimeId,
        status,
        verified,
        lastCheckedAt.toISOString(),
        verifiedAt ? verifiedAt.toISOString() : null,
        asOptionalText(params.evidenceArtifactId),
        evidence,
        asOptionalText(params.reason),
      ]
    );

    return (await this.getById(id)) as ProfileLoginState;
  }

  async deleteByProfile(profileId: string): Promise<number> {
    const normalizedProfileId = assertRequiredText(profileId, 'profileId');
    const existing = await allPrepared(
      this.conn,
      `SELECT id FROM profile_login_states WHERE profile_id = ?`,
      [normalizedProfileId]
    );
    const rows = parseRows(existing);
    await runPrepared(this.conn, `DELETE FROM profile_login_states WHERE profile_id = ?`, [
      normalizedProfileId,
    ]);
    return rows.length;
  }

  private async getById(id: string): Promise<ProfileLoginState | null> {
    const result = await allPrepared(
      this.conn,
      `
      SELECT *
      FROM profile_login_states
      WHERE id = ?
      LIMIT 1
    `,
      [id]
    );
    const rows = parseRows<ProfileLoginStateRow>(result);
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: ProfileLoginStateRow): ProfileLoginState {
    const runtimeId = normalizeRuntimeId(row.runtime_id);
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      accountId: asOptionalText(row.account_id),
      site: String(row.site),
      loginUrl: asOptionalText(row.login_url),
      runtimeId,
      status: normalizeStatus(row.status),
      verified: row.verified === true,
      lastCheckedAt: toDate(row.last_checked_at),
      verifiedAt: row.verified_at ? toDate(row.verified_at) : null,
      evidenceArtifactId: asOptionalText(row.evidence_artifact_id),
      evidence: parseEvidence(row.evidence),
      reason: asOptionalText(row.reason),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    };
  }
}
