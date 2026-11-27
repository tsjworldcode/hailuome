/**
 * REL-FIX-6：跨节点管理员代理操作群主待审批入群申请（`GROUP_ADMIN_JOIN_REQUEST_V1`）。
 *
 * 背景：入群 pending 只落**群主** D1；跨节点管理员本机查 `group_members.status=pending`
 * 恒为空。管理员节点需向群主权威节点证明「本机是该群管理员」并代为拉取 / 审批。
 *
 * 签名覆盖：kind / action / group_id / requester_worker_b_url / requester_handle /
 * target_member_worker_b_url / timestamp / nonce。
 * 群主侧用**群主库** `group_members.is_admin=1` 权威判定请求方身份（成员本机 is_admin 常为 0，
 * 不能依赖请求方自证）；nonce 落 `group_nonces` 防重放。
 */
import { encodeText, hexToBytes } from '@hailuo/shared-utils';
import { signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

export const GROUP_ADMIN_JOIN_REQUEST_KIND = 'GROUP_ADMIN_JOIN_REQUEST_V1' as const;

/** 允许的时钟偏移（与退群信令同档，防节点轻微漂移）。 */
export const GROUP_ADMIN_JOIN_REQUEST_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 管理员可代理的动作：列出待审批 / 同意 / 拒绝。 */
export type GroupAdminJoinRequestAction = 'list' | 'approve' | 'reject';

export type GroupAdminJoinRequestUnsigned = {
  kind: typeof GROUP_ADMIN_JOIN_REQUEST_KIND;
  action: GroupAdminJoinRequestAction;
  group_id: string;
  requester_worker_b_url: string;
  requester_handle: string;
  /** 审批目标成员 URL；action=list 时为空串 */
  target_member_worker_b_url: string;
  timestamp: string;
  nonce: string;
};

export type GroupAdminJoinRequestEnvelope = GroupAdminJoinRequestUnsigned & {
  sig: string;
};

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`group-admin-join-request-ed25519-pub:${publicKeyHex}`, () =>
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
export function buildGroupAdminJoinRequestSignatureInput(
  envelope: GroupAdminJoinRequestUnsigned,
): string {
  return [
    GROUP_ADMIN_JOIN_REQUEST_KIND,
    envelope.action,
    envelope.group_id,
    envelope.requester_worker_b_url,
    envelope.requester_handle,
    envelope.target_member_worker_b_url,
    envelope.timestamp,
    envelope.nonce,
  ].join('\n');
}

export async function signGroupAdminJoinRequest(
  envelope: GroupAdminJoinRequestUnsigned,
  privateKeyHex: string,
): Promise<string> {
  return signMessage(
    buildGroupAdminJoinRequestSignatureInput(envelope),
    privateKeyHex,
  );
}

export async function verifyGroupAdminJoinRequest(
  envelope: GroupAdminJoinRequestEnvelope,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const unsigned: GroupAdminJoinRequestUnsigned = {
      kind: GROUP_ADMIN_JOIN_REQUEST_KIND,
      action: envelope.action,
      group_id: envelope.group_id,
      requester_worker_b_url: envelope.requester_worker_b_url,
      requester_handle: envelope.requester_handle,
      target_member_worker_b_url: envelope.target_member_worker_b_url,
      timestamp: envelope.timestamp,
      nonce: envelope.nonce,
    };
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(envelope.sig),
      encodeText(buildGroupAdminJoinRequestSignatureInput(unsigned)),
    );
  } catch {
    return false;
  }
}
