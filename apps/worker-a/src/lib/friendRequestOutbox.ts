/**
 * M17-1c · 加好友跨节点 outbox 回报 lib（Worker A 内部 `/friend-requests/outbox` 入口的逻辑层）。
 *
 * 流程（计划 §六.2 第 7～10 步）：
 *   1) JSON 解析 + 字段类型校验（actor.pubkey 是 target 节点的 Ed25519 公钥）
 *   2) 时间窗口校验（±5 分钟）
 *   3) Ed25519 envelope 验签（用 envelope.actor.pubkey）
 *   4) 读本地 friend_requests 行（必须是我发出的 — origin_handle == local handle）
 *   5) 状态机校验（必须 pending；已 accept/reject → ALREADY_RESOLVED 幂等）
 *   6) accepted → UPDATE status='accepted' + INSERT INTO follows（origin 端互粉闭环）
 *      + 写通知 friend_request_accepted
 *   7) rejected → UPDATE status='rejected' + 写通知 friend_request_rejected
 *
 * lib 输出 discriminated union（与 friendRequests.FriendRequestResult 同形）。
 *
 * 注：路由层（M17-1d）负责 Service Binding + HMAC v2 验签（X-Internal-Forward）；
 *     本 lib 只负责 envelope 验签 + D1 副作用。
 *
 * ────────────────────────────────────────────────────────────────────────
 * M-OPT-SPLIT-A6-3 · 补偿语义方案 C 落定（accepted 跨库双写拆两步串行）
 *
 * **A-6-3 方案 C 落定**：`applyFriendRequestOutbox.accepted` 分支双写
 * `UPDATE friend_requests` + `INSERT OR IGNORE INTO follows` 拆为两步串行
 * （先 CONTENT UPDATE → 后 IDENTITY INSERT OR IGNORE），与 `friendRequests.acceptRequest` 同模式。
 * 由 `friendRequestRetention.repairFriendRequestFollows` ≤10min cron 兜底补齐
 * 「friend_requests accepted 但本端 follows 缺」的孤儿行。
 *
 * 4) 读 friend_requests 行 + rejected 分支 UPDATE 已在 A-6-2 切到
 * `resolveContentDb(env)`（CONTENT 单表单库）；本步只将 accepted 分支迁移到方案 C。
 *
 * M-OPT-SPLIT-5c-4b 的旧 `env.DB.batch([...])` 说明保留为历史边界，不能再当作当前实现契约。
 */

import { generateId, nowISO } from '@hailuo/shared-utils';
import { normalizeWorkerBOrigin, normalizeHandleLocalSegment } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveLocalNodeUrlAliases, isLocalNodeUrlMatch } from './localPublicBaseUrl';
import { recordFriendRequestNotification } from './friendRequestNotify';
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';
import {
  buildFriendRequestEnvelopeSigningInput,
  buildFriendRequestPlaceholderRawBody,
  checkFriendRequestEnvelopeWindow,
  computeFriendRequestBodySha256Hex,
  verifyFriendRequestEnvelope,
} from './friendRequestEnvelope';

// ---- 类型 ------------------------------------------------------------

/** outbox envelope actor 子结构 — target 节点的身份与签名公钥（plan §六.2 第 7 步）。 */
export interface FriendRequestOutboxActor {
  readonly node_url: string;
  readonly handle: string;
  /** Ed25519 raw 公钥（64 hex 字符）— target 节点的 Ed25519 公钥。 */
  readonly pubkey: string;
  /** 可选 display_name（M17-FIX-1 §三.2.3 P1-2：origin 端 follow 行展示非空） */
  readonly display_name?: string;
  /** 可选 avatar_key（M17-FIX-1 §三.2.3 P1-2：origin 端 follow 行展示非空） */
  readonly avatar_key?: string;
}

export interface FriendRequestOutboxBody {
  readonly request_id: string;
  readonly status: 'accepted' | 'rejected' | 'cancelled';
  readonly actor: FriendRequestOutboxActor;
  readonly nonce: string;
  readonly sig: string;
  /** unix sec 字符串 */
  readonly ts: string;
}

export type FriendRequestOutboxErrorCode =
  | 'FRIEND_REQUEST_INVALID_PARAMS'
  | 'FRIEND_REQUEST_INVALID_SIG'
  | 'FRIEND_REQUEST_SIGNATURE_EXPIRED'
  | 'FRIEND_REQUEST_NOT_FOUND'
  | 'NOT_ORIGIN'
  | 'ALREADY_RESOLVED'
  | 'INTERNAL_ERROR';

export type FriendRequestOutboxResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error_code: FriendRequestOutboxErrorCode;
      readonly status: 400 | 401 | 403 | 404 | 409 | 500;
      readonly message: string;
    };

export interface ApplyFriendRequestOutboxSuccess {
  /** 本地 friend_requests.id（与 envelope.request_id 同值） */
  readonly id: string;
  /** 最终状态 — 幂等情况下也返回当前状态 */
  readonly status: 'accepted' | 'rejected' | 'cancelled' | 'pending';
  /** 'applied' = 状态变更；'idempotent' = 已是目标状态（无副作用） */
  readonly mode: 'applied' | 'idempotent';
  /** 若本次 INSERT 了 follows 行（仅 accepted 时）— ISO 时间戳；否则 null */
  readonly followed_at: string | null;
}

// ---- 1. 解析 envelope body -----------------------------------------

/**
 * 解析 outbox raw body + 字段类型校验；非对象 / 缺必填字段 / 类型不符 → 返回 null。
 */
export function parseFriendRequestOutboxBody(raw: unknown): FriendRequestOutboxBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const requestId = typeof obj.request_id === 'string' ? obj.request_id.trim() : '';
  if (!requestId) return null;

  const statusRaw = typeof obj.status === 'string' ? obj.status.trim() : '';
  if (statusRaw !== 'accepted' && statusRaw !== 'rejected' && statusRaw !== 'cancelled') return null;

  const actorRaw = obj.actor;
  if (!actorRaw || typeof actorRaw !== 'object') return null;
  const actorObj = actorRaw as Record<string, unknown>;
  const actorNodeUrl = typeof actorObj.node_url === 'string' ? actorObj.node_url.trim() : '';
  // M-F2：限定名（alice@reg2）归一化为裸本地名
  const actorHandle = normalizeHandleLocalSegment(
    typeof actorObj.handle === 'string' ? actorObj.handle : '',
  );
  const actorPubkey = typeof actorObj.pubkey === 'string' ? actorObj.pubkey.trim() : '';
  const actorDisplayName = typeof actorObj.display_name === 'string' ? actorObj.display_name : '';
  const actorAvatarKey = typeof actorObj.avatar_key === 'string' ? actorObj.avatar_key : '';
  if (!actorNodeUrl || !actorHandle || !actorPubkey) return null;
  if (actorPubkey.length !== 64) return null;

  const nonce = typeof obj.nonce === 'string' ? obj.nonce.trim() : '';
  const sig = typeof obj.sig === 'string' ? obj.sig.trim() : '';
  const ts = typeof obj.ts === 'string' ? obj.ts.trim() : '';
  if (!nonce || !sig || !ts) return null;

  const actor: FriendRequestOutboxActor = {
    node_url: actorNodeUrl,
    handle: actorHandle,
    pubkey: actorPubkey,
    ...(actorDisplayName ? { display_name: actorDisplayName } : {}),
    ...(actorAvatarKey ? { avatar_key: actorAvatarKey } : {}),
  };

  return {
    request_id: requestId,
    status: statusRaw as 'accepted' | 'rejected' | 'cancelled',
    actor,
    nonce,
    sig,
    ts,
  };
}

// ---- 2. 完整 apply 入口 --------------------------------------------

/**
 * 回报方完整流程入口（origin 端 — 自己发出去的请求被对方 accept/reject）。
 * 路由层（M17-1d）只需：
 *   - 解析 raw body（c.req.text()）
 *   - 调 applyFriendRequestOutbox(env, rawBody, expectedPath)
 *   - 把 Result 序列化为 JSON 返回
 *
 * expectedPath 必须与 envelope 签名输入里的 path 一致。
 */
export async function applyFriendRequestOutbox(
  env: Env,
  rawBody: string,
  expectedPath: string,
  now: Date = new Date(),
): Promise<FriendRequestOutboxResult<ApplyFriendRequestOutboxSuccess>> {
  // ---- 1) JSON 解析 + 字段校验 --------------------------------------
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'envelope body 必须为 JSON' };
  }
  const body = parseFriendRequestOutboxBody(parsedJson);
  if (!body) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'envelope 字段缺失或类型不符' };
  }

  // ---- 2) 时间窗口校验 --------------------------------------------
  const window = checkFriendRequestEnvelopeWindow(body.ts, now);
  if (!window.ok) {
    const status = window.error_code === 'FRIEND_REQUEST_SIGNATURE_EXPIRED' ? 403 : 401;
    return { ok: false, status, error_code: window.error_code, message: 'envelope 签名时间窗口外' };
  }

  // ---- 3) Ed25519 envelope 验签（用 actor.pubkey = target 节点公钥） --
  // 与 inbox 同口径：签名针对 sig 占位 body，接收方先重建占位 body 再复算 SHA-256。
  const placeholderRawBody = buildFriendRequestPlaceholderRawBody(parsedJson);
  if (!placeholderRawBody) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'envelope body 必须为 JSON 对象' };
  }
  const bodySha = await computeFriendRequestBodySha256Hex(placeholderRawBody);
  const signingInput = buildFriendRequestEnvelopeSigningInput(
    'POST',
    expectedPath,
    body.ts,
    body.nonce,
    bodySha,
  );
  const sigOk = await verifyFriendRequestEnvelope(signingInput, body.sig, body.actor.pubkey);
  if (!sigOk) {
    return { ok: false, status: 403, error_code: 'FRIEND_REQUEST_INVALID_SIG', message: 'envelope 签名验证失败' };
  }

  // ---- 4) 读本地 friend_requests 行 --------------------------------
  // M-OPT-SPLIT-A6-2：friend_requests 在 CONTENT_DB（migration 0060），切 resolveContentDb(env)。
  const contentDb = resolveContentDb(env);
  const row = await contentDb
    .prepare(
      `SELECT id, origin_handle, origin_node_url, target_node_url, target_handle, status
         FROM friend_requests WHERE id = ? LIMIT 1`,
    )
    .bind(body.request_id)
    .first<{
      id: string;
      origin_handle: string;
      origin_node_url: string;
      target_node_url: string;
      target_handle: string;
      status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
    }>();
  if (!row) {
    return { ok: false, status: 404, error_code: 'FRIEND_REQUEST_NOT_FOUND', message: '本地不存在该请求' };
  }

  const localAliases = await resolveLocalNodeUrlAliases(env);
  const actorNodeUrlNorm = normalizeWorkerBOrigin(body.actor.node_url);
  const nowIso = now.toISOString();

  // ---- M17-4-1：cancelled = origin→target 撤回通知（本站是 target） ----
  // REL-FIX-2：本地行 target 与本机别名成员判定（归一 origin 级；落库原文不动）。
  if (body.status === 'cancelled') {
    if (localAliases.length === 0 || !isLocalNodeUrlMatch(row.target_node_url, localAliases)) {
      return {
        ok: false,
        status: 400,
        error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
        message: '本地该请求不是发给本站的（target_node_url 不匹配）',
      };
    }
    if (!actorNodeUrlNorm || actorNodeUrlNorm !== normalizeWorkerBOrigin(row.origin_node_url)) {
      return {
        ok: false,
        status: 400,
        error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
        message: 'envelope.actor.node_url 与该请求的 origin_node_url 不一致',
      };
    }
    if (normalizeHandleLocalSegment(body.actor.handle) !== normalizeHandleLocalSegment(row.origin_handle)) {
      return {
        ok: false,
        status: 400,
        error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
        message: 'envelope.actor.handle 与该请求的 origin_handle 不一致',
      };
    }
    if (row.status === 'cancelled') {
      return {
        ok: true,
        data: { id: row.id, status: 'cancelled', mode: 'idempotent', followed_at: null },
      };
    }
    if (row.status !== 'pending') {
      return {
        ok: false,
        status: 409,
        error_code: 'ALREADY_RESOLVED',
        message: `该请求已被处理为 ${row.status}`,
      };
    }
    try {
      const upd = await contentDb
        .prepare(
          `UPDATE friend_requests
              SET status = 'cancelled', updated_at = ?, cancelled_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .bind(nowIso, nowIso, body.request_id)
        .run();
      if ((upd.meta.changes ?? 0) === 0) {
        return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理' };
      }
      await recordFriendRequestNotification(env, {
        type: 'friend_request_cancelled',
        request_id: body.request_id,
        actor_handle: body.actor.handle,
        actor_node_url: actorNodeUrlNorm,
        related_node_url: actorNodeUrlNorm,
        content_preview: body.actor.display_name || undefined,
      });
      return { ok: true, data: { id: body.request_id, status: 'cancelled', mode: 'applied', followed_at: null } };
    } catch (err) {
      console.error('[friendRequestOutbox] cancelled 应用失败', err);
      return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '应用 cancelled 失败' };
    }
  }

  // ---- 5) 一致性校验：accepted/rejected 必须是 origin 端 -------------------------------
  // REL-FIX-2：本地行 origin 与本机别名成员判定（归一 origin 级；落库原文不动）。
  if (localAliases.length === 0 || !isLocalNodeUrlMatch(row.origin_node_url, localAliases)) {
    // 本地该行的 origin_node_url 不是本站 → 该请求不是本站发出的，拒收
    return {
      ok: false,
      status: 400,
      error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
      message: '本地该请求不是本站发出（origin_node_url 不匹配）',
    };
  }
  if (!actorNodeUrlNorm || actorNodeUrlNorm !== normalizeWorkerBOrigin(row.target_node_url)) {
    // envelope actor.node_url 必须等于该行的 target_node_url（防 envelope 错投）
    return {
      ok: false,
      status: 400,
      error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
      message: 'envelope.actor.node_url 与该请求的 target_node_url 不一致',
    };
  }
  if (normalizeHandleLocalSegment(body.actor.handle) !== normalizeHandleLocalSegment(row.target_handle)) {
    return {
      ok: false,
      status: 400,
      error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
      message: 'envelope.actor.handle 与该请求的 target_handle 不一致',
    };
  }

  // ---- 6) 状态机校验 -----------------------------------------------
  // 已是目标状态 → 幂等返回（plan §六.4 状态机幂等）
  if (row.status === body.status) {
    return {
      ok: true,
      data: {
        id: row.id,
        status: row.status,
        mode: 'idempotent',
        followed_at: null,
      },
    };
  }
  // 已被其它路径 accept / reject → ALREADY_RESOLVED（不强行覆盖）
  if (row.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      error_code: 'ALREADY_RESOLVED',
      message: `该请求已被处理为 ${row.status}`,
    };
  }

  // ---- 7) 应用状态变更 ----------------------------------------------
  // nowIso 已在上方定义

  if (body.status === 'accepted') {
    try {
      // accepted → 写本地 follows（origin 端互粉闭环；与 friendRequests.acceptRequest 同模式）
      // M-OPT-SPLIT-A6-3 · 补偿语义方案 C 落定（accepted 跨库两步串行 + Repair 兜底）
      //
      // 修前：env.DB.batch([INSERT OR IGNORE INTO follows, UPDATE friend_requests]) 单 binding batch 同步原子；
      //       CONTENT + IDENTITY 物理分库后单 binding 不可见另一库表。
      // 修后：拆两步串行（先 CONTENT UPDATE friend_requests → 后 IDENTITY INSERT OR IGNORE INTO follows），
      //       任一失败 → 留「friend_requests accepted 但本端 follows 缺」行 →
      //       `friendRequestRetention.repairFriendRequestFollows` ≤10min cron 扫描补 INSERT OR IGNORE。
      //
      // 语义等价 M17-FIX-3 P0-3 守护（eventual atomicity ≤10min）；前端不感知；
      // A-7 alias 退役后禁止改回单 binding batch。
      // contentDb 复用第 201 行函数级绑定（值相同，仅 block scope shadow，可删）。
      const identityDb = resolveIdentityDb(env);

      // step 1: 推进 friend_requests 状态机（CONTENT_DB · migration 0060）
      const upd = await contentDb
        .prepare(
          `UPDATE friend_requests
              SET status = 'accepted', updated_at = ?, accepted_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .bind(nowIso, nowIso, body.request_id)
        .run();
      if ((upd.meta.changes ?? 0) === 0) {
        return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理' };
      }

      // step 2: 写本地 follows（IDENTITY_DB · migration 0001，幂等 INSERT OR IGNORE）
      // 与 Repair 路径同源；本步异常退出时 row.status='accepted' + 本端无 follow 行的孤儿状态
      // 由 Repair cron ≤10min 补齐。
      const followId = generateId('follow');
      await identityDb
        .prepare(
          `INSERT OR IGNORE INTO follows
             (id, follower_node_url, followed_at,
              followed_handle, followed_display_name, followed_avatar_key, followed_worker_b_url, followed_pubkey)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''))`,
        )
        .bind(
          followId,
          actorNodeUrlNorm,
          nowIso,
          body.actor.handle,
          body.actor.display_name ?? '',
          body.actor.avatar_key ?? '',
          actorNodeUrlNorm,
          body.actor.pubkey ?? '',
        )
        .run();

      // 通知 origin 端（自己看：刚刚谁接受了我发出的请求）— fail-soft
      await recordFriendRequestNotification(env, {
        type: 'friend_request_accepted',
        request_id: body.request_id,
        actor_handle: body.actor.handle,
        actor_node_url: actorNodeUrlNorm,
        related_node_url: actorNodeUrlNorm,
      });

      return { ok: true, data: { id: body.request_id, status: 'accepted', mode: 'applied', followed_at: nowIso } };
    } catch (err) {
      console.error('[friendRequestOutbox] accepted 应用失败', err);
      return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '应用 accepted 失败' };
    }
  }

  // rejected 路径：不写 follows，仅 UPDATE + 通知
  // A-6-2：rejected 单表单库走 CONTENT_DB；accepted 路径已在上方落方案 C。
  try {
    const contentDb = resolveContentDb(env);
    const upd = await contentDb
      .prepare(
        `UPDATE friend_requests
            SET status = 'rejected', updated_at = ?, rejected_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(nowIso, nowIso, body.request_id)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理' };
    }

    await recordFriendRequestNotification(env, {
      type: 'friend_request_rejected',
      request_id: body.request_id,
      actor_handle: body.actor.handle,
      actor_node_url: actorNodeUrlNorm,
      related_node_url: actorNodeUrlNorm,
    });

    return { ok: true, data: { id: body.request_id, status: 'rejected', mode: 'applied', followed_at: null } };
  } catch (err) {
    console.error('[friendRequestOutbox] rejected 应用失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '应用 rejected 失败' };
  }
}
