/**
 * REL-FIX-7：群主把「入群审批结果」回推给申请人节点（`GROUP_JOIN_DECISION_V1`）。
 *
 * 背景：群主同意 / 拒绝后，申请人节点本机 `group_members.status` 永远停在
 * `pending`，申请人既看不到结果也收不到通知（REL-FIX-7 目标）。
 *
 * 签名覆盖：kind / group_id / decision / group_name / owner_worker_b_url /
 * owner_handle / owner_pubkey / member_worker_b_url / timestamp / nonce。
 *
 * 安全：
 * - 签名方是**群主**（群主节点身份钥），验签方是申请人节点；申请人用本地
 *   `group_members` 里 role='owner' 的 pin 公钥验签（**不**采信信封自带的公钥）。
 * - nonce 落 `group_nonces` 防重放；时间窗 ±5 分钟（与退群 / 管理员代理同档）。
 * - 决策只对 `member_worker_b_url` 指定的节点生效，其它节点收件即拒。
 */
import { encodeText, hexToBytes } from '@hailuo/shared-utils';
import { signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

export const GROUP_JOIN_DECISION_KIND = 'GROUP_JOIN_DECISION_V1' as const;

/** 允许的时钟偏移（与退群信令 / 管理员代理同档，防节点轻微漂移）。 */
export const GROUP_JOIN_DECISION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 审批结果：同意 / 拒绝。 */
export type GroupJoinDecision = 'approved' | 'rejected';

export type GroupJoinDecisionUnsigned = {
  kind: typeof GROUP_JOIN_DECISION_KIND;
  group_id: string;
  decision: GroupJoinDecision;
  group_name: string;
  owner_worker_b_url: string;
  owner_handle: string;
  /** 群主公钥（信息位；验签以接收端本地 pin 为准） */
  owner_pubkey: string;
  /** 申请人节点 Worker B URL（决策只对此节点生效） */
  member_worker_b_url: string;
  timestamp: string;
  nonce: string;
};

export type GroupJoinDecisionEnvelope = GroupJoinDecisionUnsigned & {
  sig: string;
};

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`group-join-decision-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

/** 换行签名输入（顺序固定，跨节点同源）。 */
export function buildGroupJoinDecisionSignatureInput(
  envelope: GroupJoinDecisionUnsigned,
): string {
  return [
    GROUP_JOIN_DECISION_KIND,
    envelope.group_id,
    envelope.decision,
    envelope.group_name,
    envelope.owner_worker_b_url,
    envelope.owner_handle,
    envelope.owner_pubkey,
    envelope.member_worker_b_url,
    envelope.timestamp,
    envelope.nonce,
  ].join('\n');
}

export async function signGroupJoinDecision(
  envelope: GroupJoinDecisionUnsigned,
  privateKeyHex: string,
): Promise<string> {
  return signMessage(
    buildGroupJoinDecisionSignatureInput(envelope),
    privateKeyHex,
  );
}

export async function verifyGroupJoinDecision(
  envelope: GroupJoinDecisionEnvelope,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const unsigned: GroupJoinDecisionUnsigned = {
      kind: GROUP_JOIN_DECISION_KIND,
      group_id: envelope.group_id,
      decision: envelope.decision,
      group_name: envelope.group_name,
      owner_worker_b_url: envelope.owner_worker_b_url,
      owner_handle: envelope.owner_handle,
      owner_pubkey: envelope.owner_pubkey,
      member_worker_b_url: envelope.member_worker_b_url,
      timestamp: envelope.timestamp,
      nonce: envelope.nonce,
    };
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(envelope.sig),
      encodeText(buildGroupJoinDecisionSignatureInput(unsigned)),
    );
  } catch {
    return false;
  }
}
