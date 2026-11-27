/**
 * M17-1e · 加好友跨节点 envelope 投递 helper（站主端发起 → 对端 inbox；接受/拒绝 → 对端 outbox）。
 *
 * 协议（plan §五.2 / §五.3）：
 *   - 入站 inbox envelope：{ request_id, origin:{ node_url, handle, display_name?, avatar_key?, pubkey },
 *                            target:{ node_url, handle }, message?, nonce, sig, ts }
 *   - 回报 outbox envelope：{ request_id, status: 'accepted' | 'rejected' | 'cancelled',
 *                              actor:{ node_url, handle, pubkey }, nonce, sig, ts }
 *     （M17-4-1：cancelled = origin→target 撤回通知；accepted/rejected = target→origin）
 *
 * 投递路径：origin Worker A → target Worker B `POST /friend-requests/inbox`（公开入口
 *   CORS + 频控 + 防御性 envelope 外形校验）→ target Worker B HMAC v2 转发 → target Worker A
 *   内部 `POST /friend-requests/inbox`（本目录 routes/friend-requests-internal.ts）。
 *
 * **签名循环约束（plan §五.4 + §六.1 第 6 步）**：
 *   签名输入 = `HAILUO_FRIEND_REQUEST_V1\n{method} {path}\n{ts}\n{nonce}\n{body_sha256_hex}`
 *   body_sha256_hex 是 **rawBody（含 sig 字段的最终 envelope 字符串）** 的 SHA-256。
 *   接收方 inbox lib（M17-1c）同样用接收到的 HTTP body 算 SHA-256 拼签名输入再 verify。
 *
 *   这构成循环依赖：sig 在 rawBody 里，rawBody 又被 sig 签。解法：
 *     1. 构造 envelope，sig 字段填 **128 字符占位**（与真实 Ed25519 sig hex 等长）
 *     2. JSON.stringify → 算 SHA-256 → 拼 signingInput
 *     3. Ed25519.sign(signingInput, privateKey) → 真实 sig（128 hex）
 *     4. 把占位替换为真实 sig，重新 JSON.stringify（key 顺序与 #1 完全一致）
 *        —— 因为占位与真实 sig 长度相同（128 char），且其他字段未动，
 *        两段 JSON.stringify 输出的字节序列完全相同（接收方 rawBody 即与 #2 字节一致）
 *
 *   本 helper 严格按上述流程实现；任何修改 envelope 字段顺序的改动都会破坏协议。
 *
 * 失败处理：console.warn 静默，不抛异常（与 groupMessage.deliverGroupOutboxToOwner 同模式）；
 *   跨节点失败不阻断主响应；Repair 由 M17-1g Cron 双写（plan §九.2 + §六.4 状态机幂等）兜底。
 */

import { assertSafePeerWorkerBUrl, normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import {
  FRIEND_REQUEST_SIG_HEX_LENGTH,
  FRIEND_REQUEST_SIG_PLACEHOLDER,
  buildFriendRequestEnvelopeSigningInput,
  computeFriendRequestBodySha256Hex,
  signFriendRequestEnvelope,
} from './friendRequestEnvelope';
import type { Env } from '../env';
import { fetchOutboundPeer } from './fetchOutboundPeer';

// ---- 常量 ------------------------------------------------------------

/** 跨节点 envelope 投递超时（与 groupMessage.deliverGroupOutboxToOwner 同档）。 */
export const FRIEND_REQUEST_DELIVERY_TIMEOUT_MS = 10_000;

/** Ed25519 sig hex 长度（64 字节 = 128 hex 字符），与接收方占位 body 对齐。 */
const SIG_HEX_LENGTH = FRIEND_REQUEST_SIG_HEX_LENGTH;

/** rawBody 中 sig 占位（与真实 sig 等长，确保 JSON.stringify 后字节一致）。 */
const SIG_PLACEHOLDER = FRIEND_REQUEST_SIG_PLACEHOLDER;

// ---- 类型 ------------------------------------------------------------

/** 发起方 inbox envelope 的 origin 子结构（plan §五.2 修缮：必含 pubkey）。 */
export interface FriendRequestDeliveryOrigin {
  readonly node_url: string;
  readonly handle: string;
  readonly display_name?: string;
  readonly avatar_key?: string;
  /** Ed25519 raw 公钥 64 hex — 对端 inbox lib 验签用 */
  readonly pubkey: string;
}

/** 发起方 inbox envelope 的 target 子结构。 */
export interface FriendRequestDeliveryTarget {
  readonly node_url: string;
  readonly handle: string;
}

/** 发起方 inbox envelope 完整结构（plan §五.2 修缮 v1.2）。 */
export interface FriendRequestInboxDeliveryEnvelope {
  readonly request_id: string;
  readonly origin: FriendRequestDeliveryOrigin;
  readonly target: FriendRequestDeliveryTarget;
  readonly message?: string;
  readonly nonce: string;
  readonly sig: string;
  readonly ts: string;
}

/** 回报方 outbox envelope 的 actor 子结构（plan §五.3 + M17-FIX-1 §三.2.3 扩 display_name/avatar_key）。 */
export interface FriendRequestDeliveryActor {
  readonly node_url: string;
  readonly handle: string;
  /** Ed25519 raw 公钥 64 hex — 对端 outbox lib 验签用（target 节点公钥） */
  readonly pubkey: string;
  /** 可选 display_name（M17-FIX-1 P1-2：origin 端 follow 行展示非空） */
  readonly display_name?: string;
  /** 可选 avatar_key（M17-FIX-1 P1-2：origin 端 follow 行展示非空） */
  readonly avatar_key?: string;
}

/** 回报方 outbox envelope 完整结构（plan §五.3 + M17-4-1 cancelled）。 */
export interface FriendRequestOutboxDeliveryEnvelope {
  readonly request_id: string;
  readonly status: 'accepted' | 'rejected' | 'cancelled';
  readonly actor: FriendRequestDeliveryActor;
  readonly nonce: string;
  readonly sig: string;
  readonly ts: string;
}

/** 投递结果（与 groupMessage.deliverGroupOutboxToOwner 同形）。 */
export type FriendRequestDeliveryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error_code: string; readonly message: string; readonly status: number };

// ---- 1. inbox envelope 构造 + 签名（plan §五.2 + §五.4） ------------

/**
 * 构造 inbox envelope + Ed25519 签名（envelope 自带 origin.pubkey，对端 lib 验签用）。
 * 返回的 envelope JSON.stringify 后投递到对端 Worker B `/friend-requests/inbox`。
 */
export async function buildSignedFriendRequestInboxEnvelope(
  env: Env,
  args: {
    readonly request_id: string;
    readonly origin: FriendRequestDeliveryOrigin;
    readonly target: FriendRequestDeliveryTarget;
    readonly message?: string;
    readonly nonce: string;
    readonly ts: string;
  },
): Promise<FriendRequestInboxDeliveryEnvelope> {
  const upstreamPath = '/friend-requests/inbox';
  // Step 1：构造 envelope（sig 占位；key 顺序固定）
  const placeholderEnvelope: Record<string, unknown> = {
    request_id: args.request_id,
    origin: args.origin,
    target: args.target,
  };
  if (args.message !== undefined && args.message !== '') {
    placeholderEnvelope.message = args.message;
  }
  placeholderEnvelope.nonce = args.nonce;
  placeholderEnvelope.ts = args.ts;
  placeholderEnvelope.sig = SIG_PLACEHOLDER;

  // Step 2：占位 envelope JSON → SHA-256 → 拼 signingInput
  const placeholderRawBody = JSON.stringify(placeholderEnvelope);
  const bodySha = await computeFriendRequestBodySha256Hex(placeholderRawBody);
  const signingInput = buildFriendRequestEnvelopeSigningInput('POST', upstreamPath, args.ts, args.nonce, bodySha);

  // Step 3：Ed25519 签名
  const sig = await signFriendRequestEnvelope(signingInput, env.ED25519_PRIVATE_KEY);
  if (sig.length !== SIG_HEX_LENGTH) {
    throw new Error(`friendRequestDelivery: Ed25519 sig 长度异常 ${sig.length}（期望 ${SIG_HEX_LENGTH}）`);
  }

  // Step 4：构造返回 envelope（占位 → 真实 sig，key 顺序与 Step 1 完全一致；
  //   JSON.stringify 输出字节与 placeholderRawBody 完全相同）
  const result: FriendRequestInboxDeliveryEnvelope = {
    request_id: args.request_id,
    origin: args.origin,
    target: args.target,
    ...(args.message !== undefined && args.message !== '' ? { message: args.message } : {}),
    nonce: args.nonce,
    ts: args.ts,
    sig,
  };

  // 自检：发送方 envelope 与 placeholderRawBody 字节一致（除 sig 值外）
  const finalRawBody = JSON.stringify(result);
  if (finalRawBody.replace(sig, SIG_PLACEHOLDER) !== placeholderRawBody) {
    throw new Error('friendRequestDelivery: inbox envelope 序列化字节与占位不一致，签名循环将失败');
  }

  return result;
}

// ---- 2. outbox envelope 构造 + 签名（plan §五.3 + §五.4） ------------

/** 构造 outbox envelope + Ed25519 签名（plan §五.3）。 */
export async function buildSignedFriendRequestOutboxEnvelope(
  env: Env,
  args: {
    readonly request_id: string;
    readonly status: 'accepted' | 'rejected' | 'cancelled';
    readonly actor: FriendRequestDeliveryActor;
    readonly nonce: string;
    readonly ts: string;
  },
): Promise<FriendRequestOutboxDeliveryEnvelope> {
  const upstreamPath = '/friend-requests/outbox';

  // M17-FIX-1 §三.2.3：actor 可带 display_name / avatar_key 透传给 origin 端 follow 行
  // 注意 key 顺序固定：node_url → handle → display_name → avatar_key → pubkey
  // （与 placeholder 必须一致，否则 JSON.stringify 字节序列漂移，签名循环失败）
  const actorPlaceholder: Record<string, unknown> = {
    node_url: args.actor.node_url,
    handle: args.actor.handle,
  };
  if (args.actor.display_name !== undefined && args.actor.display_name !== '') {
    actorPlaceholder.display_name = args.actor.display_name;
  }
  if (args.actor.avatar_key !== undefined && args.actor.avatar_key !== '') {
    actorPlaceholder.avatar_key = args.actor.avatar_key;
  }
  actorPlaceholder.pubkey = args.actor.pubkey;

  const placeholderEnvelope: Record<string, unknown> = {
    request_id: args.request_id,
    status: args.status,
    actor: actorPlaceholder,
    nonce: args.nonce,
    ts: args.ts,
    sig: SIG_PLACEHOLDER,
  };

  const placeholderRawBody = JSON.stringify(placeholderEnvelope);
  const bodySha = await computeFriendRequestBodySha256Hex(placeholderRawBody);
  const signingInput = buildFriendRequestEnvelopeSigningInput('POST', upstreamPath, args.ts, args.nonce, bodySha);
  const sig = await signFriendRequestEnvelope(signingInput, env.ED25519_PRIVATE_KEY);
  if (sig.length !== SIG_HEX_LENGTH) {
    throw new Error(`friendRequestDelivery: Ed25519 sig 长度异常 ${sig.length}（期望 ${SIG_HEX_LENGTH}）`);
  }

  // 构造 final actor（与 placeholder 顺序完全一致）
  // ⚠️ key 顺序是签名协议的一部分：placeholder 是 node_url → handle →
  // display_name → avatar_key → pubkey；final 必须逐字一致，否则下面的
  // 「序列化字节与占位不一致」自检会抛错（表现为 OUTBOX_DELIVERY_EXCEPTION）。
  const actorFinal: FriendRequestDeliveryActor = {
    node_url: args.actor.node_url,
    handle: args.actor.handle,
    ...(args.actor.display_name !== undefined && args.actor.display_name !== ''
      ? { display_name: args.actor.display_name }
      : {}),
    ...(args.actor.avatar_key !== undefined && args.actor.avatar_key !== ''
      ? { avatar_key: args.actor.avatar_key }
      : {}),
    pubkey: args.actor.pubkey,
  };

  const result: FriendRequestOutboxDeliveryEnvelope = {
    request_id: args.request_id,
    status: args.status,
    actor: actorFinal,
    nonce: args.nonce,
    ts: args.ts,
    sig,
  };

  const finalRawBody = JSON.stringify(result);
  if (finalRawBody.replace(sig, SIG_PLACEHOLDER) !== placeholderRawBody) {
    throw new Error('friendRequestDelivery: outbox envelope 序列化字节与占位不一致，签名循环将失败');
  }

  return result;
}

// ---- 3. 跨节点 fetch 投递 -------------------------------------------

/**
 * 通用 envelope 投递 helper（inbox / outbox 共用）：
 *   1) JSON.stringify(envelope) → 目标 Worker B 公网入口
 *   2) AbortController 超时 FRIEND_REQUEST_DELIVERY_TIMEOUT_MS
 *   3) parse JSON 响应 → ok → {ok:true}；非 ok → {ok:false, status, error_code, message}
 *
 * 注：远端响应已是 Worker B 极窄转发后的 Worker A lib 权威结果（envelope 验签 +
 *     黑名单 + 频控 + D1 副作用），失败原因可作为 Repair 兜底的诊断线索。
 */
async function postEnvelopeToTargetWorkerB(
  env: Env,
  targetNodeUrl: string,
  upstreamPath: '/friend-requests/inbox' | '/friend-requests/outbox',
  envelope: FriendRequestInboxDeliveryEnvelope | FriendRequestOutboxDeliveryEnvelope,
): Promise<FriendRequestDeliveryResult> {
  const target = normalizeWorkerBOrigin(targetNodeUrl);
  // 写/出站前边界：https + 端口白名单 + 无私网（normalize 不动）
  const safe = assertSafePeerWorkerBUrl(target);
  if (!safe.ok) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: '目标节点 URL 不合法' };
  }

  const fetched = await fetchOutboundPeer(env, `${target}${upstreamPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
    timeoutMs: FRIEND_REQUEST_DELIVERY_TIMEOUT_MS,
  });
  if (!fetched.ok) {
    const aborted = fetched.reason === 'aborted';
    return {
      ok: false,
      status: 502,
      error_code: aborted ? 'FRIEND_REQUEST_DELIVERY_TIMEOUT' : 'FRIEND_REQUEST_DELIVERY_FAILED',
      message: aborted ? '投递超时' : '投递失败',
    };
  }
  const upstream = fetched.response;

  const parsed = (await upstream.json().catch(() => null)) as {
    ok?: boolean;
    error_code?: string;
    message?: string;
  } | null;

  if (!upstream.ok || !parsed?.ok) {
    return {
      ok: false,
      status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
      error_code: parsed?.error_code ?? 'FRIEND_REQUEST_DELIVERY_REJECTED',
      message: parsed?.message ?? '对端拒绝接收',
    };
  }

  return { ok: true };
}

/** 发起方投递 inbox envelope 到目标节点 Worker B 公开入口。 */
export async function deliverFriendRequestInboxToTarget(
  env: Env,
  targetNodeUrl: string,
  envelope: FriendRequestInboxDeliveryEnvelope,
): Promise<FriendRequestDeliveryResult> {
  return postEnvelopeToTargetWorkerB(env, targetNodeUrl, '/friend-requests/inbox', envelope);
}

/** 回报方投递 outbox envelope 到发起方节点 Worker B 公开入口。 */
export async function deliverFriendRequestOutboxToOrigin(
  env: Env,
  originNodeUrl: string,
  envelope: FriendRequestOutboxDeliveryEnvelope,
): Promise<FriendRequestDeliveryResult> {
  return postEnvelopeToTargetWorkerB(env, originNodeUrl, '/friend-requests/outbox', envelope);
}
