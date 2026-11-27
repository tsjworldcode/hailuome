/**
 * M17-FIX-1 · 跨节点 outbox 真投递 — target 用户档案 fetcher。
 *
 * 背景（plan §三.2.1 + §十一.1）：
 *   deliverStatusOutbox 在跨节点场景下，actor.pubkey 必须是 target 节点的 Ed25519 公钥
 *   （用于对端 outbox lib 验签）。但本节点 D1 users 表只存本站站主一行 —— 拿不到对端公钥。
 *   本 lib 走目标节点 Worker B `GET /users/:handle` 公开入口拉取，仅取 4 个字段：
 *     - pubkey (Ed25519 raw, 64 hex) — 用于 envelope.actor.pubkey 验签
 *     - handle — 一致性校验
 *     - display_name — 用于 origin 端 follow 行展示（P1-2）
 *     - avatar_key — 用于 origin 端 follow 行展示（P1-2）
 *
 * 设计约束：
 *   - **不缓存**：result 仅用于当前 envelope 构造 + follow 字段写入；不进 STATE_KV / 内存；
 *     防身份关联留痕（rule 12-anti-deanonymization §硬禁止）。
 *   - **超时 / 解析失败**：返回 null；调用方按 fail-soft 写 outbox_status='pending_retry'
 *     等 friend-request-outbox-gc cron 兜底。
 *   - **不抛**：catch 一切异常返回 null；不污染主流程日志。
 *   - **SSR 守卫**：本 lib 在 waitUntil 中调用，无需 typeof window 守卫；但 fetch 自身
 *     在 Workers edge runtime 始终存在，仅需 AbortController timeout。
 *   - **§F-02 红线**：本文件不出现 worker-a / WORKER_A_URL / localhost:8787 / 127.0.0.1:8787
 *     等字面量（与 lib 全局约定一致）；fetch 目标仅依赖 targetNodeUrl 参数（运行时注入）。
 */

import { assertSafePeerWorkerBUrl, normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import type { Env } from '../env';

// ---- 常量 ------------------------------------------------------------

/** 跨节点 target 公开拉取超时（与 friendRequestDelivery 共用 10s 档）。 */
export const FRIEND_REQUEST_TARGET_FETCH_TIMEOUT_MS = 10_000;

/** 必要字段集合 — 仅 4 个，禁扩展（防身份关联留痕）。 */
export interface TargetUserProfile {
  readonly handle: string;
  readonly pubkey: string;
  readonly display_name: string;
  readonly avatar_key: string;
}

// ---- 内部 helper ------------------------------------------------------

/** raw data → 4 字段裁剪；任一必填字段缺失 / 格式错 → null。 */
function coerceTargetProfile(raw: unknown): TargetUserProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const handle = typeof obj.handle === 'string' ? obj.handle.trim().toLowerCase() : '';
  const pubkey = typeof obj.pubkey === 'string' ? obj.pubkey.trim() : '';
  const displayName = typeof obj.display_name === 'string' ? obj.display_name : '';
  const avatarKey = typeof obj.avatar_key === 'string' ? obj.avatar_key : '';
  if (!handle || !pubkey) return null;
  if (pubkey.length !== 64) return null;
  return { handle, pubkey, display_name: displayName, avatar_key: avatarKey };
}

// ---- 主入口 -----------------------------------------------------------

/**
 * SEC-AUDIT-2026-10-7 · 返回档案 handle 与请求 handle 是否指同一个人。
 *
 * 【为什么必须校验】Worker B 的 `GET /users/:handle` 有两条回落路径：
 *   ① 命中 STATE_KV 公开档 → 返回档里的 handle（可能与请求 handle 不同）；
 *   ② 请求 `BOOTSTRAP_HANDLE` → 可能返回档里的另一条档案。
 * 若不校验就把它当「对方公钥」写进 `follows.followed_pubkey`，
 * 等于把**另一个人的公钥**钉成信任 Pin —— 比没有 Pin 更危险（会误拒真实好友）。
 *
 * 【比对口径】
 *   - 两边都带 `@regN` → 必须全串相等（`alice@reg2` ≠ `alice@reg3`，是不同身份）；
 *   - 任一边不带后缀（本地裸名）→ 比裸本地名段（`alice` ≡ `alice@reg2`）。
 */
export function handlesReferToSameIdentity(requested: string, returned: string): boolean {
  const a = requested.trim().toLowerCase();
  const b = returned.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  // 两边都带 registry 后缀 → 必须是同一个完整身份（防 reg2/reg3 同名混淆）
  if (a.includes('@') && b.includes('@')) return false;
  // 任一边不带后缀 → 比裸本地名段（`alice` ≡ `alice@reg2`）
  const aLocal = a.split('@')[0];
  const bLocal = b.split('@')[0];
  return aLocal === bLocal;
}

/**
 * 拉取 target 节点公开用户档案。失败 / 超时 / 解析错 / handle 不符 → null（fail-soft）。
 *
 * @param targetNodeUrl  对端节点公开基址（Worker B URL；origin / inbox lib 已归一化）
 * @param targetHandle   目标用户 handle（小写；与 origin / inbox lib 入参同口径）
 * @param env            可选 Worker 环境变量（用于出站网关继承私网配置等）
 * @returns TargetUserProfile | null
 */
export async function fetchTargetUserProfile(
  targetNodeUrl: string,
  targetHandle: string,
  env?: Env,
): Promise<TargetUserProfile | null> {
  const target = normalizeWorkerBOrigin(targetNodeUrl);
  const handle = (targetHandle ?? '').trim().toLowerCase();
  if (!target || !target.startsWith('https://') || !handle) return null;

  try {
    // P0-1 / SEC-7 闭环：统一通过 fetchOutboundPeer 出站网关（含 assertSafePeerWorkerBUrl、redirect:manual、中性 UA、超时）
    const res = await fetchOutboundPeer(
      env ?? ({} as Env),
      `${target}/users/${encodeURIComponent(handle)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: FRIEND_REQUEST_TARGET_FETCH_TIMEOUT_MS,
      },
    );
    if (!res.ok) return null;
    const parsed = (await res.response.json().catch(() => null)) as
      | { ok?: boolean; data?: unknown }
      | null;
    if (!parsed || parsed.ok !== true) return null;
    const profile = coerceTargetProfile(parsed.data);
    if (!profile) return null;
    // SEC-7：handle 不符 → 视为取档失败（绝不把他人公钥当成本人 pin）
    if (!handlesReferToSameIdentity(handle, profile.handle)) return null;
    return profile;
  } catch {
    return null;
  }
}
