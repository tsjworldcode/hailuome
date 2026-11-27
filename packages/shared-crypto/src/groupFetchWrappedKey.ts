/** SEC-5 / EPOCH NET-2：快拉身份与取包对象共用唯一成员字段，不支持 unsigned 回退。 */
import { signMessage, verifyMessage } from './ed25519';

export const GROUP_FETCH_WRAPPED_KEY_KIND = 'GROUP_FETCH_WRAPPED_KEY_V1' as const;
export const GROUP_FETCH_WRAPPED_KEY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type GroupFetchWrappedKeyUnsigned = {
  group_id: string;
  member_worker_b_url: string;
  epoch: number;
  timestamp: string;
  nonce: string;
};
export type GroupFetchWrappedKeyEnvelope = GroupFetchWrappedKeyUnsigned & { sig: string };

/** 两层都校验原始字节，不在验签前 trim 字段，防止身份/签名规范化分叉。 */
export function parseGroupFetchWrappedKey(raw: unknown): GroupFetchWrappedKeyEnvelope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.group_id !== 'string' || !/^grp_[a-zA-Z0-9_-]{8,128}$/.test(e.group_id) ||
    typeof e.member_worker_b_url !== 'string' || e.member_worker_b_url.length > 2048 ||
    /[\u0000-\u0020\u007f]/.test(e.member_worker_b_url) || e.member_worker_b_url.endsWith('/') ||
    typeof e.epoch !== 'number' || !Number.isSafeInteger(e.epoch) || e.epoch < 1 ||
    typeof e.timestamp !== 'string' ||
    typeof e.nonce !== 'string' || !/^[0-9a-f]{32,64}$/.test(e.nonce) ||
    typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(e.sig)
  ) return null;
  const timestamp = Date.parse(e.timestamp);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== e.timestamp ||
    Math.abs(Date.now() - timestamp) > GROUP_FETCH_WRAPPED_KEY_CLOCK_SKEW_MS) return null;
  try {
    const url = new URL(e.member_worker_b_url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  } catch {
    return null;
  }
  return {
    group_id: e.group_id, member_worker_b_url: e.member_worker_b_url, epoch: e.epoch,
    timestamp: e.timestamp, nonce: e.nonce, sig: e.sig,
  };
}

/** 六行 canonical，无末尾换行；固定域标签防止其他协议的签名被挪用。 */
export function buildGroupFetchWrappedKeySignatureInput(e: GroupFetchWrappedKeyUnsigned): string {
  return [GROUP_FETCH_WRAPPED_KEY_KIND, e.group_id, e.member_worker_b_url, String(e.epoch), e.timestamp, e.nonce].join('\n');
}

export async function signGroupFetchWrappedKey(e: GroupFetchWrappedKeyUnsigned, privateKeyHex: string): Promise<string> {
  return signMessage(buildGroupFetchWrappedKeySignatureInput(e), privateKeyHex);
}

export async function verifyGroupFetchWrappedKey(e: GroupFetchWrappedKeyEnvelope, publicKeyHex: string): Promise<boolean> {
  return verifyMessage(buildGroupFetchWrappedKeySignatureInput(e), e.sig, publicKeyHex);
}
