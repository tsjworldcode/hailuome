import type { ReadMutualProof } from '@hailuo/shared-types';
import { encodeText, hexToBytes } from '@hailuo/shared-utils';
import { signMessage } from './ed25519';
import { getCachedKey } from './keyCache';

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`read-proof-ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

export function buildReadMutualProofSignatureInput(
  proof: Omit<ReadMutualProof, 'sig'>,
): string {
  return [
    'READ_MUTUAL_PROOF_V1',
    proof.reader_worker_b_url,
    proof.owner_worker_b_url,
    proof.purpose,
    String(proof.exp),
    proof.nonce,
  ].join('\n');
}

export async function signReadMutualProof(
  proof: Omit<ReadMutualProof, 'sig'>,
  privateKeyHex: string,
): Promise<string> {
  return signMessage(buildReadMutualProofSignatureInput(proof), privateKeyHex);
}

export async function verifyReadMutualProof(
  proof: ReadMutualProof,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    if (proof.purpose !== 'read-token') return false;
    const key = await importPublicKey(publicKeyHex);
    const { sig: _sig, ...unsigned } = proof;
    return crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(proof.sig),
      encodeText(buildReadMutualProofSignatureInput(unsigned)),
    );
  } catch {
    return false;
  }
}
