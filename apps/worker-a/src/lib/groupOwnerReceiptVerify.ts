/**
 * GRP-RELAY-AUTH-3：relay 收端校验 owner_receipt。
 * 收端**恒强制**（`GROUP_RELAY_RECEIPT_REQUIRED === true` 程序内常量，不读 env）：
 *   - 缺 receipt → 403 GROUP_RECEIPT_REQUIRED
 *   - 无群主 pin / 验签失败 / 篡改密文 → 403 GROUP_RECEIPT_INVALID
 * 单测仍可对 `checkOwnerReceiptAgainstEnvelope(..., { required: false })` 测软放行分支。
 */
import {
  hashOwnerReceiptCiphertext,
  verifyOwnerReceipt,
} from '@hailuo/shared-crypto';
import type { GroupMessageEnvelope, OwnerReceiptV1 } from '@hailuo/shared-types';
import { normalizeGroupMemberUrl } from './groupMemberUrl';

export const GROUP_RECEIPT_REQUIRED = 'GROUP_RECEIPT_REQUIRED';
export const GROUP_RECEIPT_INVALID = 'GROUP_RECEIPT_INVALID';

/**
 * 群 relay 是否强制要求合法 owner_receipt。
 * 无生产存量灰度压力：程序内恒 true，**不**读 wrangler / env。
 */
export const GROUP_RELAY_RECEIPT_REQUIRED = true as const;

/** 签发/过期时钟允许偏差（防节点时钟轻微漂移） */
export const OWNER_RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type OwnerReceiptCheckResult =
  | { ok: true; shadowedMissing?: boolean; epochLocalMismatch?: boolean }
  | {
      ok: false;
      error_code: typeof GROUP_RECEIPT_REQUIRED | typeof GROUP_RECEIPT_INVALID;
      message: string;
    };

/** 生产路径用；恒返回 `GROUP_RELAY_RECEIPT_REQUIRED`（true）。 */
export function isGroupRelayReceiptRequired(): boolean {
  return GROUP_RELAY_RECEIPT_REQUIRED;
}

function urlsEqual(a: string, b: string): boolean {
  return normalizeGroupMemberUrl(a) === normalizeGroupMemberUrl(b);
}

/**
 * 对照 envelope + 本机群行校验 receipt（纯逻辑，可单测）。
 * - receipt.epoch 必须与 envelope.epoch 一致（防包体/副签错配）。
 * - 不与 localGroup.epoch 硬等比对：树中继异步 + 成员侧 groups.epoch 常滞后，硬拒会误杀在途/新 epoch 消息。
 * - `required: false` 仅供单测；生产调用恒传 true。
 */
export async function checkOwnerReceiptAgainstEnvelope(
  receipt: OwnerReceiptV1 | undefined,
  envelope: GroupMessageEnvelope,
  localGroup: { owner_worker_b_url: string; epoch: number },
  ownerPublicKeyHex: string | null,
  opts: { required: boolean; nowMs?: number },
): Promise<OwnerReceiptCheckResult> {
  const required = opts.required;
  const nowMs = opts.nowMs ?? Date.now();

  if (!receipt) {
    if (required) {
      return {
        ok: false,
        error_code: GROUP_RECEIPT_REQUIRED,
        message: '群消息 relay 须带群主 owner_receipt',
      };
    }
    return { ok: true, shadowedMissing: true };
  }

  if (receipt.v !== 1) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 版本无效' };
  }
  if (receipt.group_id !== envelope.group_id || receipt.message_id !== envelope.message_id) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 与消息不匹配' };
  }
  // 只绑 envelope：群主签发已证明受理时 epoch；本机 epoch 可能滞后/超前，不作硬拒
  if (receipt.epoch !== envelope.epoch) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt epoch 与信封不匹配' };
  }
  const epochLocalMismatch = receipt.epoch !== localGroup.epoch;
  if (!urlsEqual(receipt.sender_worker_b_url, envelope.sender_worker_b_url)) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 发送者 URL 不匹配' };
  }
  if (receipt.sender_handle.trim().toLowerCase() !== envelope.sender_handle.trim().toLowerCase()) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 发送者 handle 不匹配' };
  }
  if (!urlsEqual(receipt.owner_worker_b_url, envelope.owner_worker_b_url)) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 群主 URL 与信封不匹配' };
  }
  if (!urlsEqual(receipt.owner_worker_b_url, localGroup.owner_worker_b_url)) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 群主 URL 与本机群不匹配' };
  }

  const digest = await hashOwnerReceiptCiphertext(envelope.ciphertext);
  if (digest !== receipt.ciphertext_sha256.trim().toLowerCase()) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 密文摘要不匹配' };
  }

  // MSG-FIX-5：recv_seq（权威入库序）由群主签名背书；形状非法一律拒收，
  // 防止中继塞入负数 / 非整数 / 0 破坏 sync 游标单调性。
  if (receipt.recv_seq !== undefined) {
    if (
      typeof receipt.recv_seq !== 'number' ||
      !Number.isInteger(receipt.recv_seq) ||
      receipt.recv_seq < 1
    ) {
      return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt recv_seq 无效' };
    }
  }

  const issuedMs = Date.parse(receipt.issued_at);
  const expMs = Date.parse(receipt.exp);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expMs)) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 时间无效' };
  }
  if (issuedMs > nowMs + OWNER_RECEIPT_CLOCK_SKEW_MS) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 签发时间异常' };
  }
  if (expMs < nowMs - OWNER_RECEIPT_CLOCK_SKEW_MS) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 已过期' };
  }
  if (expMs < issuedMs) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 过期早于签发' };
  }

  const pub = (ownerPublicKeyHex ?? '').trim();
  if (!pub) {
    // required=false（仅单测）：无 pin 无法验签 ≈ 缺 receipt
    if (!required) {
      return { ok: true, shadowedMissing: true, ...(epochLocalMismatch ? { epochLocalMismatch } : {}) };
    }
    return {
      ok: false,
      error_code: GROUP_RECEIPT_INVALID,
      message: '本机无群主公钥 pin，无法校验 owner_receipt',
    };
  }
  if (!(await verifyOwnerReceipt(receipt, pub))) {
    return { ok: false, error_code: GROUP_RECEIPT_INVALID, message: 'owner_receipt 签名无效' };
  }
  return epochLocalMismatch ? { ok: true, epochLocalMismatch: true } : { ok: true };
}
