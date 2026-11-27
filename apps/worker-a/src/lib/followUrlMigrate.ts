/**
 * M7-30f-3：粉丝侧识别对方迁址声明，验签后更新 follows 并清 lookup 缓存。
 *
 * 安全：只信签名声明；禁止盲信未签名 Location / 裸响应头 URL。
 * 资源：verify 需 GET /users；Cron 侧由调用方控制子请求预算。
 */

import { resolveIdentityDb } from '../db/bindings';
import {
  NODE_URL_MOVED_HEADER,
  URL_MOVE_CHAIN_MAX_HOPS,
  buildNodeUrlMovedCanonical,
  type NodeUrlMovedDeclaration,
} from '@hailuo/shared-types';
import { verifyMessage } from '@hailuo/shared-crypto';
import type { Env } from '../env';
import type { CronSubrequestBudget } from './cronSubrequestBudget';
import { isManualRedirectStatus, resolveSafeOutboundPeerUrl } from './fetchOutboundPeer';

const NODE_FETCH_TIMEOUT_MS = 8_000;

export { NODE_URL_MOVED_HEADER };

export type VerifiedNodeUrlMovedDeclaration = NodeUrlMovedDeclaration & {
  readonly verified_pubkey?: string;
};

/** M7-30j-4：Cron 迁址 fetch 计入子请求预算；无 budget 时行为与旧版一致 */
function takeSubrequest(budget: CronSubrequestBudget | undefined, n = 1): boolean {
  if (!budget) return true;
  return budget.take(n);
}

export function normalizeFollowNodeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return trimmed;
    return parsed.origin;
  } catch {
    return trimmed;
  }
}

function isNodeUrlMovedDeclaration(value: unknown): value is NodeUrlMovedDeclaration {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.old_node_url === 'string' &&
    typeof row.new_node_url === 'string' &&
    typeof row.changed_at === 'string' &&
    typeof row.grace_until === 'string' &&
    typeof row.handle === 'string' &&
    typeof row.sig === 'string'
  );
}

/** 从响应头解析迁址新址提示（仍须再拉声明并验签，不可单独信任）。 */
export function readMovedHintFromHeaders(headers: Headers): string {
  return normalizeFollowNodeUrl(headers.get(NODE_URL_MOVED_HEADER) ?? '');
}

/**
 * GET `/.well-known/hailuo-node-moved`；404/过期/非法 → null。
 * 消耗 1 次子请求。
 */
export async function fetchNodeUrlMovedDeclaration(
  oldNodeUrl: string,
  budget?: CronSubrequestBudget,
): Promise<NodeUrlMovedDeclaration | null> {
  if (!takeSubrequest(budget, 1)) return null;
  const base = normalizeFollowNodeUrl(oldNodeUrl);
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NODE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${base}/.well-known/hailuo-node-moved?old_url=${encodeURIComponent(base)}`,
      {
      headers: { Accept: 'application/json', 'User-Agent': 'hailuo-node-cron/1.0' },
      signal: controller.signal,
      redirect: 'manual',
    },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; data?: unknown };
    if (json.ok !== true || !isNodeUrlMovedDeclaration(json.data)) return null;
    return json.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 验签 + 语义校验：
 * - grace_until 未过期
 * - old_node_url 与本地 follows 当前 fetch URL 一致
 * - 用新址 /users/:handle 的 pubkey 验 Ed25519
 * 成功返回规范化后的声明；失败返回 null（fail-soft）。
 * 消耗最多 1 次子请求（/users）。
 */
export async function verifyNodeUrlMovedDeclaration(
  env: Env,
  declaration: NodeUrlMovedDeclaration,
  expectedOldUrl: string,
  budget?: CronSubrequestBudget,
): Promise<VerifiedNodeUrlMovedDeclaration | null> {
  const oldUrl = normalizeFollowNodeUrl(declaration.old_node_url);
  const newUrl = normalizeFollowNodeUrl(declaration.new_node_url);
  const expected = normalizeFollowNodeUrl(expectedOldUrl);
  const handle = declaration.handle.trim().toLowerCase();
  const nowIso = new Date().toISOString();

  if (!oldUrl || !newUrl || !handle || !declaration.sig.trim()) return null;
  if (oldUrl === newUrl) return null;
  if (declaration.grace_until < nowIso) return null;
  if (oldUrl !== expected) return null;

  // 声明里的新地址由对端填写。先校验，不通过则 0 连接，也不占子请求预算。
  const profileUrl = resolveSafeOutboundPeerUrl(
    env,
    `${newUrl}/users/${encodeURIComponent(handle)}`,
  );
  if (!profileUrl) return null;

  if (!takeSubrequest(budget, 1)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NODE_FETCH_TIMEOUT_MS);
  let pubkey = '';
  try {
    const res = await fetch(profileUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'hailuo-node-cron/1.0' },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!res.ok || isManualRedirectStatus(res.status)) return null;
    const json = (await res.json()) as { ok?: boolean; data?: { pubkey?: string; handle?: string } };
    if (json.ok !== true || typeof json.data?.pubkey !== 'string') return null;
    pubkey = json.data.pubkey.trim();
    const remoteHandle = typeof json.data.handle === 'string' ? json.data.handle.trim().toLowerCase() : '';
    if (remoteHandle && remoteHandle !== handle) return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!pubkey) return null;

  // 写入侧用 normalizePublicBaseUrl（去尾斜杠）签名；验签同样用规范化 URL
  const canonical = buildNodeUrlMovedCanonical({
    old_node_url: oldUrl,
    new_node_url: newUrl,
    changed_at: declaration.changed_at,
    grace_until: declaration.grace_until,
    handle: declaration.handle.trim(),
  });
  const ok = await verifyMessage(canonical, declaration.sig, pubkey);
  if (!ok) return null;

  return {
    old_node_url: oldUrl,
    new_node_url: newUrl,
    changed_at: declaration.changed_at,
    grace_until: declaration.grace_until,
    handle: declaration.handle.trim(),
    sig: declaration.sig,
    verified_pubkey: pubkey,
  };
}

export type ApplyFollowUrlMigrateResult =
  | { ok: true; new_node_url: string; handle: string }
  | { ok: false; reason: string };

/**
 * 更新 follows URL + 清该 handle 的 cache_entries。
 * UNIQUE 冲突（已关注新址）→ fail-soft。
 */
export async function applyFollowUrlMigration(
  env: Env,
  input: {
    followId: string;
    declaration: NodeUrlMovedDeclaration;
    followedHandle?: string | null;
    verifiedPubkey?: string | null;
  },
): Promise<ApplyFollowUrlMigrateResult> {
  const newUrl = normalizeFollowNodeUrl(input.declaration.new_node_url);
  const handle = (
    input.followedHandle?.trim() ||
    input.declaration.handle.trim()
  ).toLowerCase();
  const verifiedPubkey = input.verifiedPubkey?.trim().toLowerCase() || null;
  if (!newUrl) return { ok: false, reason: 'empty_new_url' };
  // 写入关注表前再查一次，避免其它调用方绕过验签路径把脏地址落库。
  const safeNew = resolveSafeOutboundPeerUrl(env, newUrl);
  if (!safeNew) return { ok: false, reason: 'unsafe_new_url' };
  const storedUrl = normalizeFollowNodeUrl(safeNew);

  try {
    const updated = await resolveIdentityDb(env)
      .prepare(
        `UPDATE follows
            SET follower_node_url = ?,
                followed_worker_b_url = ?,
                followed_handle = COALESCE(NULLIF(followed_handle, ''), ?),
                followed_pubkey = COALESCE(NULLIF(?, ''), followed_pubkey),
                fail_count = 0,
                next_retry_at = NULL
          WHERE id = ?`,
      )
      .bind(storedUrl, storedUrl, handle || null, verifiedPubkey, input.followId)
      .run();
    if (!updated.meta.changes) {
      return { ok: false, reason: 'follow_row_missing' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[followUrlMigrate] UPDATE follows 失败（可能 UNIQUE 冲突）', message);
    return { ok: false, reason: 'update_failed' };
  }

  if (handle) {
    try {
      await resolveIdentityDb(env).prepare(`DELETE FROM cache_entries WHERE handle = ?`).bind(handle).run();
    } catch (err) {
      console.error('[followUrlMigrate] 清 cache_entries 失败', err);
    }
  }

  return { ok: true, new_node_url: storedUrl, handle };
}

/** M7-30h-6：从首跳声明沿 chain 解析最终 new_node_url（防环 + MAX_HOPS）。 */
async function resolveFinalUrlMoveDeclaration(
  env: Env,
  startOldUrl: string,
  first: VerifiedNodeUrlMovedDeclaration,
  budget?: CronSubrequestBudget,
): Promise<VerifiedNodeUrlMovedDeclaration | null> {
  let current: VerifiedNodeUrlMovedDeclaration = first;
  const visited = new Set<string>([normalizeFollowNodeUrl(startOldUrl)]);
  for (let hop = 1; hop < URL_MOVE_CHAIN_MAX_HOPS; hop += 1) {
    const bridgeOld = normalizeFollowNodeUrl(current.new_node_url);
    if (!bridgeOld || visited.has(bridgeOld)) break;
    visited.add(bridgeOld);
    const nextDecl = await fetchNodeUrlMovedDeclaration(bridgeOld, budget);
    if (!nextDecl) break;
    const verified = await verifyNodeUrlMovedDeclaration(env, nextDecl, bridgeOld, budget);
    if (!verified) break;
    current = verified;
  }
  return current;
}

/**
 * 完整迁址闭环：取声明 → 验签 → 写 D1。
 * @param movedHint 来自响应头的新 URL（可选）；有 hint 时仍必须拉 well-known 拿完整签名体。
 * @returns 成功则返回新 URL；否则 null。子请求：well-known(1) + users(1)。
 */
export async function tryMigrateFollowAfterMovedHint(
  env: Env,
  input: {
    followId: string;
    currentFetchUrl: string;
    followedHandle?: string | null;
    /** 响应头提示；空则仍尝试 well-known */
    movedHint?: string;
    /** 失败路径也探测 well-known */
    forceWellKnownProbe?: boolean;
    /** M7-30j-4：Cron 子请求预算 */
    budget?: CronSubrequestBudget;
  },
): Promise<{ new_node_url: string; handle: string } | null> {
  const hint = normalizeFollowNodeUrl(input.movedHint ?? '');
  if (!hint && !input.forceWellKnownProbe) return null;

  const declaration = await fetchNodeUrlMovedDeclaration(input.currentFetchUrl, input.budget);
  if (!declaration) return null;

  // 若仅有 header hint，要求声明 new_url 与 hint 一致，防头被中间人篡改后仍用错声明
  if (hint) {
    const declaredNew = normalizeFollowNodeUrl(declaration.new_node_url);
    if (declaredNew !== hint) {
      console.warn('[followUrlMigrate] 响应头与 well-known new_node_url 不一致，拒绝');
      return null;
    }
  }

  const verified = await verifyNodeUrlMovedDeclaration(
    env,
    declaration,
    input.currentFetchUrl,
    input.budget,
  );
  if (!verified) return null;

  const finalDeclaration = await resolveFinalUrlMoveDeclaration(
    env,
    input.currentFetchUrl,
    verified,
    input.budget,
  );
  if (!finalDeclaration) return null;

  const applied = await applyFollowUrlMigration(env, {
    followId: input.followId,
    declaration: finalDeclaration,
    followedHandle: input.followedHandle,
    verifiedPubkey: (finalDeclaration as { verified_pubkey?: string }).verified_pubkey,
  });
  if (!applied.ok) return null;
  return { new_node_url: applied.new_node_url, handle: applied.handle };
}
