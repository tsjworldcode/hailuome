import type { DmMediaFetchTicket } from '@hailuo/shared-types';
import { encodeText, hexToBytes } from '@hailuo/shared-utils';
import { signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`dm-media-ticket-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

export function buildDmMediaFetchTicketSignatureInput(
  ticket: Omit<DmMediaFetchTicket, 'sig'>,
): string {
  return [
    'DM_MEDIA_FETCH_TICKET_V1',
    String(ticket.v),
    ticket.message_id,
    ticket.media_id,
    ticket.conversation_id,
    ticket.sender_storage_key,
    ticket.sender_worker_b_url,
    ticket.requester_worker_b_url,
    String(ticket.exp),
    ticket.nonce,
  ].join('\n');
}

export async function signDmMediaFetchTicket(
  ticket: Omit<DmMediaFetchTicket, 'sig'>,
  privateKeyHex: string,
): Promise<string> {
  return signMessage(buildDmMediaFetchTicketSignatureInput(ticket), privateKeyHex);
}

export async function verifyDmMediaFetchTicket(
  ticket: DmMediaFetchTicket,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    if (ticket.v !== 1) return false;
    const key = await importPublicKey(publicKeyHex);
    const { sig: _sig, ...unsigned } = ticket;
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(ticket.sig),
      encodeText(buildDmMediaFetchTicketSignatureInput(unsigned)),
    );
  } catch {
    return false;
  }
}
