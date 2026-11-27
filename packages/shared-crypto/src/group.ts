import type { GroupMessageEnvelope, GroupMessageMedia } from '@hailuo/shared-types';
import { encodeText, hexToBytes } from '@hailuo/shared-utils';
import { computeBodyHash, signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`group-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

/** 发送方 media 块键排序 JSON（纳入 sig 的 canonical 形式）。 */
export function canonicalizeGroupMessageMedia(media: GroupMessageMedia): string {
  const keys = Object.keys(media).sort() as (keyof GroupMessageMedia)[];
  const sorted: Record<string, unknown> = {};
  for (const key of keys) {
    sorted[key] = media[key];
  }
  return JSON.stringify(sorted);
}

export async function hashGroupMessageMedia(media: GroupMessageMedia): Promise<string> {
  return computeBodyHash(canonicalizeGroupMessageMedia(media));
}

export function buildGroupMessageEnvelopeSignatureInput(
  envelope: Omit<GroupMessageEnvelope, 'sig'>,
  ciphertextHashHex: string,
  mediaHashHex?: string,
): string {
  const lines = [
    'GROUP_MESSAGE_ENVELOPE_V1',
    envelope.group_id,
    envelope.message_id,
    String(envelope.epoch),
    envelope.sender_handle,
    envelope.sender_worker_b_url,
    envelope.owner_worker_b_url,
    envelope.created_at,
    envelope.expires_at,
    envelope.nonce,
    envelope.msg_kind,
    ciphertextHashHex,
  ];
  if (mediaHashHex) {
    lines.push(mediaHashHex);
  }
  return lines.join('\n');
}

export async function signGroupMessageEnvelope(
  envelope: Omit<GroupMessageEnvelope, 'sig'>,
  privateKeyHex: string,
): Promise<string> {
  const ciphertextHash = await computeBodyHash(envelope.ciphertext);
  const mediaHash = envelope.media ? await hashGroupMessageMedia(envelope.media) : undefined;
  return signMessage(
    buildGroupMessageEnvelopeSignatureInput(envelope, ciphertextHash, mediaHash),
    privateKeyHex,
  );
}

export async function verifyGroupMessageEnvelope(
  envelope: GroupMessageEnvelope,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const { sig: _sig, ...unsigned } = envelope;
    const ciphertextHash = await computeBodyHash(envelope.ciphertext);
    const mediaHash = envelope.media ? await hashGroupMessageMedia(envelope.media) : undefined;
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(envelope.sig),
      encodeText(buildGroupMessageEnvelopeSignatureInput(unsigned, ciphertextHash, mediaHash)),
    );
  } catch {
    return false;
  }
}
