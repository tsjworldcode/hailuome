/**
 * M11-6：私有记录主密钥 sessionStorage（关闭标签页即清除）。
 */
const PRIVATE_NOTES_MASTER_KEY_SS = 'hailuo:private-notes-master-key';

export function setPrivateNotesMasterKey(masterKey: Uint8Array): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(PRIVATE_NOTES_MASTER_KEY_SS, bytesToHex(masterKey));
}

export function getPrivateNotesMasterKey(): Uint8Array | null {
  if (typeof window === 'undefined') return null;
  const hex = window.sessionStorage.getItem(PRIVATE_NOTES_MASTER_KEY_SS);
  if (!hex) return null;
  return hexToBytes(hex);
}

export function clearPrivateNotesMasterKey(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(PRIVATE_NOTES_MASTER_KEY_SS);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
