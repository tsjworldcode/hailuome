/**
 * M34-4：Settings「最近登录设备」列表 + 注销会话。
 * 响应禁止含 ip_hash / token_hash / jwt_fingerprint / 完整明文 IP。
 * M34-4b：可含脱敏 ip_masked（如 203.0.113.*）。
 * R-AUDIT-SEP-A3：listRecentSessions 仅经 toPublicItem 投影后出站。
 */
import type { Env } from '../../env';
import {
  createOwnerSessionsRepo,
  type OwnerSessionListRow,
} from '../../db/ownerSessionsRepo';
import { forgetNotRevoked } from '../../middleware/auth';
import {
  jwtFingerprint,
  jwtTokenHash,
  resolveOwnerSessionTtlSec,
} from '../../lib/ownerSessionCrypto';

export type OwnerSessionPublicItem = {
  session_id: string;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
  ip_country: string | null;
  /** M34-4b：脱敏 IP；禁止完整明文 */
  ip_masked: string | null;
  user_agent_family: string | null;
  channel: string;
  /** 是否为本请求所持 JWT 对应会话 */
  is_current: boolean;
  /** 未结束且仍在心跳 TTL 内 */
  is_active: boolean;
  /** 是否具备可吊销的 token_hash（迁移前旧行为 false） */
  can_revoke_jwt: boolean;
};

function toPublicItem(
  row: OwnerSessionListRow,
  opts: { currentFp: string; cutoffIso: string },
): OwnerSessionPublicItem {
  const open = row.ended_at == null;
  const isActive = open && row.last_seen_at >= opts.cutoffIso;
  return {
    session_id: row.session_id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    ended_at: row.ended_at,
    ip_country: row.ip_country,
    ip_masked: row.ip_masked,
    user_agent_family: row.user_agent_family,
    channel: row.channel,
    is_current: open && row.jwt_fingerprint === opts.currentFp,
    is_active: isActive,
    can_revoke_jwt: Boolean(row.token_hash && row.token_hash.length >= 32),
  };
}

/** 列出最近会话（默认 20，上限 50）。 */
export async function listOwnerSessionsForSettings(
  env: Env,
  input: { token: string; limit?: number },
): Promise<{ items: OwnerSessionPublicItem[] }> {
  const repo = createOwnerSessionsRepo(env);
  const fp = await jwtFingerprint(input.token);
  const ttlSec = resolveOwnerSessionTtlSec(env.OWNER_SESSION_TTL_SEC);
  const cutoffIso = new Date(Date.now() - ttlSec * 1000).toISOString();
  const limit = input.limit ?? 20;
  const rows = await repo.listRecentSessions(limit);
  return {
    items: rows.map((r) => toPublicItem(r, { currentFp: fp, cutoffIso })),
  };
}

export type RevokeOwnerSessionResult =
  | {
      ok: true;
      ended: boolean;
      jwt_revoked: boolean;
      is_current: boolean;
      owner_engagement: 'active' | 'dormant';
    }
  | { ok: false; error_code: string; message: string; httpStatus: number };

/**
 * 结束指定会话；若有 token_hash 则写入 revoked_tokens。
 * 踢本机会话时 is_current=true，前端应清 JWT。
 */
export async function revokeOwnerSessionById(
  env: Env,
  input: { token: string; sessionId: string },
): Promise<RevokeOwnerSessionResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return {
      ok: false,
      error_code: 'SESSION_ID_REQUIRED',
      message: '缺少会话编号',
      httpStatus: 400,
    };
  }

  const repo = createOwnerSessionsRepo(env);
  const row = await repo.findById(sessionId);
  if (!row) {
    return {
      ok: false,
      error_code: 'SESSION_NOT_FOUND',
      message: '会话不存在',
      httpStatus: 404,
    };
  }

  const now = new Date().toISOString();
  const currentFp = await jwtFingerprint(input.token);
  const currentHash = await jwtTokenHash(input.token);
  // 已结束的历史行不是本机当前登录，避免删旧记录时把站主踢下线
  const isCurrent = row.ended_at == null
    && (row.jwt_fingerprint === currentFp || row.token_hash === currentHash);

  let ended = false;
  if (row.ended_at == null) {
    // M34-4d：D1 UPDATE 失败抛错 → 路由层接 500 → 行未标 ended 但行也未删；
    // 重试时再次走 endSession 仍可成功。无静默吞错。
    ended = await repo.endSession(sessionId, now);
  }

  let jwtRevoked = false;
  const hashToRevoke = row.token_hash?.trim() || (isCurrent ? currentHash : '');
  if (hashToRevoke) {
    // M34-4d：强一致点。revoked_tokens 写入必须成功，否则列表行不能删除、调用方不能返 ok。
    // 失败 → 阻断后续（不调 endSession 已结束、不调 putEngagement、不调 deleteSession），
    // 返回 SESSION_REVOKE_FAILED 503，让前端提示用户「吊销失败请重试」。
    try {
      await repo.revokeOwnerTokenHash(hashToRevoke, now);
      forgetNotRevoked(hashToRevoke);
      jwtRevoked = true;
    } catch (err) {
      console.error(
        `[sessionAdmin] revokeOwnerTokenHash 失败，阻断后续；sessionId=${sessionId} field=${err instanceof Error ? err.message : String(err)}`,
        err,
      );
      return {
        ok: false,
        error_code: 'SESSION_REVOKE_FAILED',
        message: '吊销登录凭证失败，请稍后重试',
        httpStatus: 503,
      };
    }
  }

  // M34-4d：putEngagement 仅做统计；失败不影响吊销动作与列表行删除（下次心跳自愈会更新）。
  // 计算放在 try 外，return 需要用它。
  let engagement: 'active' | 'dormant' = 'dormant';
  try {
    const ttlSec = resolveOwnerSessionTtlSec(env.OWNER_SESSION_TTL_SEC);
    const cutoff = new Date(Date.now() - ttlSec * 1000).toISOString();
    const openCount = await repo.countOpenSessionsSeenAfter(cutoff);
    engagement = openCount > 0 ? 'active' : 'dormant';
    await repo.putEngagement(engagement, engagement === 'active' ? now : null);
  } catch (err) {
    console.error('[sessionAdmin] putEngagement 失败，不影响吊销', err);
  }

  // M34-4d：吊销完成后再删列表行；登录事件表不删。
  // DELETE 失败 → 抛错让路由层接 500，下次再试依然能查到该 session_id 完成删除。
  // 这与之前 revoked_tokens 写入失败的处理是分离的：此分支只可能在吊销成功后进入。
  await repo.deleteSession(sessionId);

  return {
    ok: true,
    ended: ended || row.ended_at != null,
    jwt_revoked: jwtRevoked,
    is_current: isCurrent,
    owner_engagement: engagement,
  };
}
