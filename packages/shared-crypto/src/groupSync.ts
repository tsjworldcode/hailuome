import type { GroupSyncRequest } from '@hailuo/shared-types';
import { encodeText, hexToBytes } from '@hailuo/shared-utils';
import { signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`group-sync-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

function canonicalizeSyncAcks(acks: string[]): string {
  return [...acks].sort().join(',');
}

export function buildGroupSyncSignatureInput(
  request: Omit<GroupSyncRequest, 'sig'>,
): string {
  return [
    'GROUP_SYNC_V1',
    request.group_id,
    request.sender_handle,
    request.sender_worker_b_url,
    request.owner_worker_b_url,
    String(request.epoch),
    request.created_at,
    request.expires_at,
    request.nonce,
    request.cursor ?? '',
    canonicalizeSyncAcks(request.acks),
    request.heartbeat ? '1' : '0',
  ].join('\n');
}

export async function signGroupSyncRequest(
  request: Omit<GroupSyncRequest, 'sig'>,
  privateKeyHex: string,
): Promise<string> {
  return signMessage(buildGroupSyncSignatureInput(request), privateKeyHex);
}

export async function verifyGroupSyncRequest(
  request: GroupSyncRequest,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const { sig: _sig, ...unsigned } = request;
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(request.sig),
      encodeText(buildGroupSyncSignatureInput(unsigned)),
    );
  } catch {
    return false;
  }
}
