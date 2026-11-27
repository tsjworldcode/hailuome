/**
 * M-OPT-SPLIT-5（A-5）：黑名单跨模块共用 lookup helper。
 *
 * 起源：`blacklist` 表归属 GOVERNANCE_DB（plan §3.3 表 A-2 落地）。A-5 之前
 * 黑名单查询散落在 7 个文件（routes/dm.ts / routes/follower-tokens.ts /
 * services/dm/adapters/production.ts / services/groups/adapters/production.ts
 * / routes/groups.ts 等），全部以 `env.DB.prepare('SELECT 1 AS blocked FROM
 * blacklist ...')` 隐式访问。
 *
 * A-5 抽本 helper：
 *   - 显式 `resolveGovernanceDb(env)` 解析
 *   - 入参 node_url 自动 `normalizeDmPeerUrl` 归一
 *     （与 `normalizeGroupMemberUrl` / `normalizeWorkerBOrigin` 等价：trim + 去尾斜杠）
 *   - 返回 boolean；空结果视未拉黑
 *   - fail-soft：异常时 console.warn + 返回 false，与 DM/群 production adapter 口径一致
 *
 * 例外：`routes/follower-tokens.ts` **不走本 helper**——Token 签发路径必须
 * fail-closed（D1 异常 → 500），签发后 24h 无法回收；该文件直接
 * `resolveGovernanceDb` + try/catch 返 INTERNAL_ERROR。
 *
 * 不做什么：
 *   - 不读 STATE_KV（黑名单权威只在 D1；KV 由 handlers/blacklistSync.ts 同步）
 *   - 不做批量查询（callers 单点查即可）
 *   - 不写 D1（只读）
 */

import type { Env } from '../env';
import { resolveGovernanceDb } from '../db/bindings';
import { normalizeDmPeerUrl } from './dmEnvelope';

/** 判定给定节点 URL 是否被本节点拉黑（黑名单 D1 直读，GOVERNANCE_DB）。 */
export async function isNodeBlacklisted(env: Env, nodeUrl: string): Promise<boolean> {
  try {
    const governanceDb = resolveGovernanceDb(env);
    const normalized = normalizeDmPeerUrl(nodeUrl);
    const row = await governanceDb
      .prepare(`SELECT 1 AS blocked FROM blacklist WHERE node_url = ? LIMIT 1`)
      .bind(normalized)
      .first<{ blocked: number }>()
      .catch(() => null);
    return row !== null;
  } catch (err) {
    console.warn('[blacklistLookup] 黑名单查询失败，fail-soft 视为未拉黑', err);
    return false;
  }
}
