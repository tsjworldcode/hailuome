/**
 * GRP-RELAY-AUTH-2：群主 inbound 成功后签发 owner_receipt。
 * 私钥仅来自 env.ED25519_PRIVATE_KEY；缺钥时 fail-soft 返回 null（不挡受理，影子阶段）。
 *
 * MSG-FIX-5：`recvSeq` 是群主权威入库时分配的单调序（`group_messages.recv_seq`）。
 * 它**必须**由群主签名背书——中继节点是任意第三方，若允许 relay 载荷自带序号，
 * 恶意中继即可伪造乱序 / 空洞（把真实消息挤出 sync 游标窗口）。
 */
import {
  hashOwnerReceiptCiphertext,
  signOwnerReceipt,
} from '@hailuo/shared-crypto';
import type { GroupMessageEnvelope, OwnerReceiptUnsigned, OwnerReceiptV1 } from '@hailuo/shared-types';
import { normalizeGroupMemberUrl } from './groupMemberUrl';

/** 计划 §3.1：issued_at + 7d，再与消息 expires_at 取严 */
export const OWNER_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function pickOwnerReceiptExp(issuedAtIso: string, envelopeExpiresAt: string): string {
  const issuedMs = Date.parse(issuedAtIso);
  if (!Number.isFinite(issuedMs)) return envelopeExpiresAt;
  const ttlMs = issuedMs + OWNER_RECEIPT_TTL_MS;
  const envMs = Date.parse(envelopeExpiresAt);
  // 毫秒比较再输出 UTC ISO，避免不同时区/毫秒位数下字符串字典序偏离真实时间
  if (!Number.isFinite(envMs)) return new Date(ttlMs).toISOString();
  return new Date(Math.min(ttlMs, envMs)).toISOString();
}

export async function issueOwnerReceiptForEnvelope(
  envelope: GroupMessageEnvelope,
  ownerWorkerBUrl: string,
  ownerPrivateKeyHex: string,
  recvSeq?: number | null,
): Promise<OwnerReceiptV1> {
  const issued_at = new Date().toISOString();
  const unsigned: OwnerReceiptUnsigned = {
    v: 1,
    group_id: envelope.group_id,
    message_id: envelope.message_id,
    epoch: envelope.epoch,
    sender_worker_b_url: normalizeGroupMemberUrl(envelope.sender_worker_b_url),
    sender_handle: envelope.sender_handle.trim().toLowerCase(),
    ciphertext_sha256: await hashOwnerReceiptCiphertext(envelope.ciphertext),
    owner_worker_b_url: normalizeGroupMemberUrl(ownerWorkerBUrl),
    issued_at,
    exp: pickOwnerReceiptExp(issued_at, envelope.expires_at),
    // MSG-FIX-5：权威入库序进签名（缺失则不写字段，回执按「无序号」处理）
    ...(typeof recvSeq === 'number' && Number.isFinite(recvSeq)
      ? { recv_seq: recvSeq }
      : {}),
  };
  const sig = await signOwnerReceipt(unsigned, ownerPrivateKeyHex);
  return { ...unsigned, sig };
}
