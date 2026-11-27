import type { DmEnvelope, DmSendTicket } from '@hailuo/shared-types';
import { bytesToHex, encodeText, hexToBytes } from '@hailuo/shared-utils';
import { computeBodyHash, signMessage } from './ed25519';
import { getCachedKey } from './keyCache';
import { hashMessagingMediaSigned } from './messagingMedia';

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`dm-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

export function buildDmSendTicketSignatureInput(ticket: Omit<DmSendTicket, 'sig'>): string {
  return [
    'DM_SEND_TICKET_V1',
    ticket.sender_handle,
    ticket.recipient_handle,
    ticket.recipient_worker_b_url,
    String(ticket.exp),
    ticket.nonce,
  ].join('\n');
}

export function canonicalizeDmSendTicket(ticket: DmSendTicket): string {
  return [
    ticket.sender_handle,
    ticket.recipient_handle,
    ticket.recipient_worker_b_url,
    String(ticket.exp),
    ticket.nonce,
    ticket.sig,
  ].join('\n');
}

export function buildDmEnvelopeSignatureInput(
  envelope: Omit<DmEnvelope, 'sig'>,
  ciphertextHashHex: string,
  mediaHashHex?: string,
): string {
  const lines = [
    'DM_ENVELOPE_V1',
    envelope.conversation_id,
    envelope.message_id,
    envelope.sender_handle,
    envelope.sender_worker_b_url,
    envelope.recipient_handle,
    envelope.created_at,
    envelope.nonce,
    String(envelope.key_epoch),
    envelope.ephemeral_pubkey,
    ciphertextHashHex,
    canonicalizeDmSendTicket(envelope.send_ticket),
  ];
  if (mediaHashHex) {
    lines.push(mediaHashHex);
  }
  return lines.join('\n');
}

export async function signDmSendTicket(
  ticket: Omit<DmSendTicket, 'sig'>,
  privateKeyHex: string,
): Promise<string> {
  return signMessage(buildDmSendTicketSignatureInput(ticket), privateKeyHex);
}

export async function verifyDmSendTicket(
  ticket: DmSendTicket,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const { sig: _sig, ...unsigned } = ticket;
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(ticket.sig),
      encodeText(buildDmSendTicketSignatureInput(unsigned)),
    );
  } catch {
    return false;
  }
}

export async function signDmEnvelope(
  envelope: Omit<DmEnvelope, 'sig'>,
  privateKeyHex: string,
): Promise<string> {
  const ciphertextHash = await computeBodyHash(envelope.ciphertext);
  const mediaHash = envelope.media ? await hashMessagingMediaSigned(envelope.media) : undefined;
  return signMessage(buildDmEnvelopeSignatureInput(envelope, ciphertextHash, mediaHash), privateKeyHex);
}

export async function verifyDmEnvelope(
  envelope: DmEnvelope,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const { sig: _sig, ...unsigned } = envelope;
    const ciphertextHash = await computeBodyHash(envelope.ciphertext);
    const mediaHash = envelope.media ? await hashMessagingMediaSigned(envelope.media) : undefined;
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(envelope.sig),
      encodeText(buildDmEnvelopeSignatureInput(unsigned, ciphertextHash, mediaHash)),
    );
  } catch {
    return false;
  }
}

export function randomDmNonceHex(bytes = 16): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
