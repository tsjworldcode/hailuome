/**
 * EPOCH SEC-1：`GROUP_MEMBER_LEFT_V1` 退群权威信令（对齐 M16 canonical 换行签名输入）。
 * 权威用 pin 的 `member_pubkey` 验签；`group_nonces` 防重放由调用方落库。
 */
import { encodeText, hexToBytes } from '@hailuo/shared-utils';
import { signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

export const GROUP_MEMBER_LEFT_KIND = 'GROUP_MEMBER_LEFT_V1' as const;

export type GroupMemberLeftUnsigned = {
  kind: typeof GROUP_MEMBER_LEFT_KIND;
  group_id: string;
  member_worker_b_url: string;
  timestamp: string;
  nonce: string;
};

export type GroupMemberLeftEnvelope = GroupMemberLeftUnsigned & {
  sig: string;
  /** 展示用；不纳入签名 */
  member_handle?: string;
};

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`group-member-left-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

/** 换行签名输入：kind / group_id / member_worker_b_url / timestamp / nonce */
export function buildGroupMemberLeftSignatureInput(
  envelope: GroupMemberLeftUnsigned,
): string {
  return [
    GROUP_MEMBER_LEFT_KIND,
    envelope.group_id,
    envelope.member_worker_b_url,
    envelope.timestamp,
    envelope.nonce,
  ].join('\n');
}

export async function signGroupMemberLeft(
  envelope: GroupMemberLeftUnsigned,
  privateKeyHex: string,
): Promise<string> {
  return signMessage(buildGroupMemberLeftSignatureInput(envelope), privateKeyHex);
}

export async function verifyGroupMemberLeft(
  envelope: GroupMemberLeftEnvelope,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const unsigned: GroupMemberLeftUnsigned = {
      kind: GROUP_MEMBER_LEFT_KIND,
      group_id: envelope.group_id,
      member_worker_b_url: envelope.member_worker_b_url,
      timestamp: envelope.timestamp,
      nonce: envelope.nonce,
    };
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(envelope.sig),
      encodeText(buildGroupMemberLeftSignatureInput(unsigned)),
    );
  } catch {
    return false;
  }
}
