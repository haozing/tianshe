import type { DuckDBConnection } from '@duckdb/node-api';
import { v4 as uuidv4 } from 'uuid';
import {
  PROFILE_LOGIN_STATE_STATUSES,
  PROFILE_LOGIN_STATE_VERIFIED_BY,
  type BrowserRuntimeId,
  type ProfileLoginState,
  type ProfileLoginStateStatus,
  type ProfileLoginStateVerifiedBy,
  type UpsertProfileLoginStateParams,
  isBrowserRuntimeId,
} from '../../types/profile';
import { redactSensitiveValue } from '../../utils/redaction';
import { allPrepared, runPrepared } from './statement-executor';
import { parseRows } from './utils';

const LOGIN_STATE_STATUSES = new Set<string>(PROFILE_LOGIN_STATE_STATUSES);
const VERIFIED_BY_VALUES = new Set<string>(PROFILE_LOGIN_STATE_VERIFIED_BY);

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

const normalizeVerifiedBy = (value: unknown): ProfileLoginStateVerifiedBy | null => {
  const normalized = asOptionalText(value);
  if (!normalized) return null;
  if (VERIFIED_BY_VALUES.has(normalized)) {
    return normalized as ProfileLoginStateVerifiedBy;
  }
  throw new Error(`Unsupported profile login state verifier: ${normalized}`);
};

const normalizeRevision = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
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
  profile_revision: unknown;
  status: unknown;
  verified: unknown;
  verified_by: unknown;
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
        profile_revision     INTEGER DEFAULT 0,
        status               VARCHAR NOT NULL,
        verified             BOOLEAN DEFAULT FALSE,
        verified_by          VARCHAR,
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_login_states_unique_key
      ON profile_login_states(profile_id, site, COALESCE(account_id, ''))
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_profile_login_states_status
      ON profile_login_states(status)
    `);
    await this.ensureLatestSchema();
  }

  private async ensureLatestSchema(): Promise<void> {
    await this.conn.run(`
      ALTER TABLE profile_login_states ADD COLUMN IF NOT EXISTS profile_revision INTEGER DEFAULT 0
    `);
    await this.conn.run(`
      ALTER TABLE profile_login_states ADD COLUMN IF NOT EXISTS verified_by VARCHAR
    `);
    await this.conn.run(`
      UPDATE profile_login_states
      SET profile_revision = 0
      WHERE profile_revision IS NULL
    `);
  }

  private async getProfileSnapshot(profileId: string): Promise<{
    runtimeId: BrowserRuntimeId | null;
    revision: number;
  } | null | undefined> {
    try {
      const result = await allPrepared(
        this.conn,
        `
        SELECT runtime_id, login_state_revision
        FROM browser_profiles
        WHERE id = ?
        LIMIT 1
      `,
        [profileId]
      );
      const rows = parseRows<{ runtime_id: unknown; login_state_revision: unknown }>(result);
      if (!rows[0]) return null;
      return {
        runtimeId: normalizeRuntimeId(rows[0].runtime_id),
        revision: normalizeRevision(rows[0].login_state_revision),
      };
    } catch (error) {
      if (String((error as { message?: unknown })?.message || error).includes('browser_profiles')) {
        return undefined;
      }
      throw error;
    }
  }

  private async resolveWriteSnapshot(params: {
    profileId: string;
    runtimeId?: BrowserRuntimeId | null;
    runtimeIdSnapshot?: BrowserRuntimeId | null;
    profileRevision?: number;
  }): Promise<{ runtimeId: BrowserRuntimeId | null; revision: number }> {
    const profileSnapshot = await this.getProfileSnapshot(params.profileId);
    const runtimeId =
      normalizeRuntimeId(params.runtimeIdSnapshot ?? params.runtimeId) ||
      profileSnapshot?.runtimeId ||
      null;
    const revision =
      params.profileRevision !== undefined
        ? normalizeRevision(params.profileRevision)
        : profileSnapshot?.revision ?? 0;
    return { runtimeId, revision };
  }

  private isStaleForProfile(
    state: ProfileLoginState,
    profileSnapshot: { runtimeId: BrowserRuntimeId | null; revision: number } | null | undefined
  ): boolean {
    if (profileSnapshot === undefined) return false;
    if (!profileSnapshot) return true;
    const stateRuntimeId = state.runtimeIdSnapshot ?? state.runtimeId ?? null;
    if (stateRuntimeId && profileSnapshot.runtimeId && stateRuntimeId !== profileSnapshot.runtimeId) {
      return true;
    }
    return state.profileRevision !== profileSnapshot.revision;
  }

  private markExpired(state: ProfileLoginState, reason: string): ProfileLoginState {
    if (state.status === 'expired' && state.verified === false && state.reason === reason) {
      return state;
    }
    return {
      ...state,
      status: 'expired',
      verified: false,
      verifiedAt: null,
      reason,
    };
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
    if (!rows[0]) return null;

    const state = this.mapRow(rows[0]);
    const profileSnapshot = await this.getProfileSnapshot(profileId);
    if (!this.isStaleForProfile(state, profileSnapshot)) {
      return state;
    }

    const reason = profileSnapshot
      ? 'profile login state expired after profile runtime or revision changed'
      : 'profile login state expired because profile no longer exists';
    await this.expireById(state.id, reason);
    return this.markExpired(state, reason);
  }

  async upsertLoginState(params: UpsertProfileLoginStateParams): Promise<ProfileLoginState> {
    const profileId = assertRequiredText(params.profileId, 'profileId');
    const site = assertRequiredText(params.site, 'site');
    const accountId = asOptionalText(params.accountId);
    const status = normalizeStatus(params.status);
    const snapshot = await this.resolveWriteSnapshot(params);
    const runtimeId = snapshot.runtimeId;
    const profileRevision = snapshot.revision;
    const verifiedBy = normalizeVerifiedBy(params.verifiedBy);
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
            profile_revision = ?,
            status = ?,
            verified = ?,
            verified_by = ?,
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
          profileRevision,
          status,
          verified,
          verifiedBy,
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
        id, profile_id, account_id, site, login_url, runtime_id, profile_revision, status, verified, verified_by,
        last_checked_at, verified_at, evidence_artifact_id, evidence, reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
      [
        id,
        profileId,
        accountId,
        site,
        asOptionalText(params.loginUrl),
        runtimeId,
        profileRevision,
        status,
        verified,
        verifiedBy,
        lastCheckedAt.toISOString(),
        verifiedAt ? verifiedAt.toISOString() : null,
        asOptionalText(params.evidenceArtifactId),
        evidence,
        asOptionalText(params.reason),
      ]
    );

    return (await this.getById(id)) as ProfileLoginState;
  }

  async expireByProfile(profileId: string, reason: string): Promise<number> {
    const normalizedProfileId = assertRequiredText(profileId, 'profileId');
    const existing = await allPrepared(
      this.conn,
      `SELECT id FROM profile_login_states WHERE profile_id = ? AND verified = TRUE`,
      [normalizedProfileId]
    );
    const rows = parseRows(existing);
    await runPrepared(
      this.conn,
      `
      UPDATE profile_login_states
      SET status = 'expired',
          verified = FALSE,
          verified_at = NULL,
          reason = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ?
    `,
      [assertRequiredText(reason, 'reason'), normalizedProfileId]
    );
    return rows.length;
  }

  async expireByAccount(accountId: string, reason: string): Promise<number> {
    const normalizedAccountId = assertRequiredText(accountId, 'accountId');
    const existing = await allPrepared(
      this.conn,
      `SELECT id FROM profile_login_states WHERE account_id = ? AND verified = TRUE`,
      [normalizedAccountId]
    );
    const rows = parseRows(existing);
    await runPrepared(
      this.conn,
      `
      UPDATE profile_login_states
      SET status = 'expired',
          verified = FALSE,
          verified_at = NULL,
          reason = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE account_id = ?
    `,
      [assertRequiredText(reason, 'reason'), normalizedAccountId]
    );
    return rows.length;
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

  async deleteByAccount(accountId: string): Promise<number> {
    const normalizedAccountId = assertRequiredText(accountId, 'accountId');
    const existing = await allPrepared(
      this.conn,
      `SELECT id FROM profile_login_states WHERE account_id = ?`,
      [normalizedAccountId]
    );
    const rows = parseRows(existing);
    await runPrepared(this.conn, `DELETE FROM profile_login_states WHERE account_id = ?`, [
      normalizedAccountId,
    ]);
    return rows.length;
  }

  private async expireById(id: string, reason: string): Promise<void> {
    await runPrepared(
      this.conn,
      `
      UPDATE profile_login_states
      SET status = 'expired',
          verified = FALSE,
          verified_at = NULL,
          reason = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [assertRequiredText(reason, 'reason'), id]
    );
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
      runtimeIdSnapshot: runtimeId,
      runtimeId,
      profileRevision: normalizeRevision(row.profile_revision),
      status: normalizeStatus(row.status),
      verified: row.verified === true,
      verifiedBy: normalizeVerifiedBy(row.verified_by),
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
