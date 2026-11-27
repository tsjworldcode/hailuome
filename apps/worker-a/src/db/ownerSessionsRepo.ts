/**
 * M34-1：站主会话 / 登录审计 D1 读写。
 * M-OPT-SPLIT-7：owner_sessions / owner_login_events / system_config → Identity；
 * revoked_tokens → Governance；跨库禁止单 batch。
 */
import type { Env } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from './bindings';
import type { OwnerLoginMethod } from '../lib/ownerSessionCrypto';

export type OwnerSessionRow = {
  session_id: string;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
  jwt_fingerprint: string;
  /** M34-4：完整 SHA-256(token)；可空（迁移前旧行） */
  token_hash: string | null;
  ip_hash: string | null;
  /** M34-4b：脱敏 IP（如 203.0.113.*）；禁止完整明文 */
  ip_masked: string | null;
  ip_country: string | null;
  user_agent_family: string | null;
  channel: string;
};

/**
 * R-AUDIT-SEP-A3：列表查询行 —— 不含 ip_hash（列表 UI / 投影不需要）。
 * M34-4b：含 ip_masked（脱敏，可出站）。
 * 仍保留 jwt_fingerprint / token_hash，供 sessionAdmin.toPublicItem 算 is_current / can_revoke_jwt。
 * 禁止把本类型直接序列化进 HTTP；对外必须经 toPublicItem → OwnerSessionPublicItem。
 */
export type OwnerSessionListRow = Omit<OwnerSessionRow, 'ip_hash'>;

const ENGAGEMENT_KEY = 'owner_engagement';
const LAST_SEEN_KEY = 'owner_last_seen_at';

export type OwnerEngagementValue = 'active' | 'dormant' | 'unknown';

export function createOwnerSessionsRepo(env: Env) {
  const identityDb = resolveIdentityDb(env);
  const governanceDb = resolveGovernanceDb(env);
  return {
    async insertLoginEvent(input: {
      id: string;
      logged_in_at: string;
      success: boolean;
      login_method: OwnerLoginMethod;
      ip_hash: string | null;
      ip_country: string | null;
      user_agent_family: string | null;
      session_id: string | null;
    }): Promise<void> {
      await identityDb.prepare(
        `INSERT INTO owner_login_events
          (id, logged_in_at, success, login_method, ip_hash, ip_country, user_agent_family, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          input.id,
          input.logged_in_at,
          input.success ? 1 : 0,
          input.login_method,
          input.ip_hash,
          input.ip_country,
          input.user_agent_family,
          input.session_id,
        )
        .run();
    },

    async insertSession(row: OwnerSessionRow): Promise<void> {
      await identityDb.prepare(
        `INSERT INTO owner_sessions
          (session_id, created_at, last_seen_at, ended_at, jwt_fingerprint, token_hash,
           ip_hash, ip_masked, ip_country, user_agent_family, channel)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          row.session_id,
          row.created_at,
          row.last_seen_at,
          row.jwt_fingerprint,
          row.token_hash,
          row.ip_hash,
          row.ip_masked,
          row.ip_country,
          row.user_agent_family,
          row.channel,
        )
        .run();
    },

    async findOpenById(sessionId: string): Promise<OwnerSessionRow | null> {
      return identityDb.prepare(
        `SELECT session_id, created_at, last_seen_at, ended_at, jwt_fingerprint, token_hash,
                ip_hash, ip_masked, ip_country, user_agent_family, channel
         FROM owner_sessions
         WHERE session_id = ? AND ended_at IS NULL
         LIMIT 1`,
      )
        .bind(sessionId)
        .first<OwnerSessionRow>();
    },

    async findById(sessionId: string): Promise<OwnerSessionRow | null> {
      return identityDb.prepare(
        `SELECT session_id, created_at, last_seen_at, ended_at, jwt_fingerprint, token_hash,
                ip_hash, ip_masked, ip_country, user_agent_family, channel
         FROM owner_sessions
         WHERE session_id = ?
         LIMIT 1`,
      )
        .bind(sessionId)
        .first<OwnerSessionRow>();
    },

    async findLatestOpenByFingerprint(fp: string): Promise<OwnerSessionRow | null> {
      return identityDb.prepare(
        `SELECT session_id, created_at, last_seen_at, ended_at, jwt_fingerprint, token_hash,
                ip_hash, ip_masked, ip_country, user_agent_family, channel
         FROM owner_sessions
         WHERE jwt_fingerprint = ? AND ended_at IS NULL
         ORDER BY last_seen_at DESC
         LIMIT 1`,
      )
        .bind(fp)
        .first<OwnerSessionRow>();
    },

    async touchSession(sessionId: string, lastSeenAt: string): Promise<boolean> {
      const r = await identityDb.prepare(
        `UPDATE owner_sessions SET last_seen_at = ?
         WHERE session_id = ? AND ended_at IS NULL`,
      )
        .bind(lastSeenAt, sessionId)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },

    async endSession(sessionId: string, endedAt: string, jwtFingerprint?: string): Promise<boolean> {
      if (jwtFingerprint) {
        const r = await identityDb.prepare(
          `UPDATE owner_sessions SET ended_at = ?
           WHERE session_id = ? AND jwt_fingerprint = ? AND ended_at IS NULL`,
        )
          .bind(endedAt, sessionId, jwtFingerprint)
          .run();
        return (r.meta?.changes ?? 0) > 0;
      }
      const r = await identityDb.prepare(
        `UPDATE owner_sessions SET ended_at = ?
         WHERE session_id = ? AND ended_at IS NULL`,
      )
        .bind(endedAt, sessionId)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },

    /** 设置页「注销此设备」后从列表移除。登录审计仍留在 owner_login_events。 */
    async deleteSession(sessionId: string): Promise<boolean> {
      const r = await identityDb.prepare(
        `DELETE FROM owner_sessions WHERE session_id = ?`,
      )
        .bind(sessionId)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },

    async countOpenSessionsSeenAfter(cutoffIso: string): Promise<number> {
      const row = await identityDb.prepare(
        `SELECT COUNT(*) AS n FROM owner_sessions
         WHERE ended_at IS NULL AND last_seen_at >= ?`,
      )
        .bind(cutoffIso)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    /**
     * M34-4 / R-AUDIT-SEP-A3：最近会话列表（含已结束）。
     * 不 SELECT ip_hash；SELECT ip_masked（脱敏）+ jwt_fingerprint / token_hash 供投影。
     * limit 上限 50。调用方必须经 sessionAdmin.toPublicItem，禁止直接进 HTTP JSON。
     */
    async listRecentSessions(limit: number): Promise<OwnerSessionListRow[]> {
      const capped = Math.min(Math.max(1, Math.floor(limit)), 50);
      const res = await identityDb.prepare(
        `SELECT session_id, created_at, last_seen_at, ended_at, jwt_fingerprint, token_hash,
                ip_masked, ip_country, user_agent_family, channel
         FROM owner_sessions
         ORDER BY COALESCE(ended_at, last_seen_at) DESC
         LIMIT ?`,
      )
        .bind(capped)
        .all<OwnerSessionListRow>();
      return res.results ?? [];
    },

    /** 将站主 JWT 写入 revoked_tokens（node_url 用固定哨兵，非外站节点）。 */
    async revokeOwnerTokenHash(tokenHash: string, revokedAt: string): Promise<void> {
      // revoked_tokens 在 GOVERNANCE_DB；与 owner_sessions 分库，禁止与 Identity 同 batch
      await governanceDb.prepare(
        `INSERT OR IGNORE INTO revoked_tokens (token_hash, node_url, revoked_at)
         VALUES (?, 'owner:local', ?)`,
      )
        .bind(tokenHash, revokedAt)
        .run();
    },

    async putEngagement(engagement: OwnerEngagementValue, lastSeenAt: string | null): Promise<void> {
      const now = new Date().toISOString();
      const stmts = [
        identityDb.prepare(
          `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
        ).bind(ENGAGEMENT_KEY, engagement, now),
      ];
      if (lastSeenAt) {
        stmts.push(
          identityDb.prepare(
            `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
          ).bind(LAST_SEEN_KEY, lastSeenAt, now),
        );
      }
      // system_config 同库，保留单 binding batch
      await identityDb.batch(stmts);
    },

    async readEngagement(): Promise<{
      engagement: OwnerEngagementValue;
      last_seen_at: string | null;
    }> {
      const rows = await identityDb.prepare(
        `SELECT key, value FROM system_config WHERE key IN (?, ?)`,
      )
        .bind(ENGAGEMENT_KEY, LAST_SEEN_KEY)
        .all<{ key: string; value: string }>();
      let engagement: OwnerEngagementValue = 'unknown';
      let last_seen_at: string | null = null;
      for (const r of rows.results ?? []) {
        if (r.key === ENGAGEMENT_KEY) {
          if (r.value === 'active' || r.value === 'dormant' || r.value === 'unknown') {
            engagement = r.value;
          }
        } else if (r.key === LAST_SEEN_KEY) {
          last_seen_at = r.value;
        }
      }
      return { engagement, last_seen_at };
    },
  };
}

export type OwnerSessionsRepo = ReturnType<typeof createOwnerSessionsRepo>;
