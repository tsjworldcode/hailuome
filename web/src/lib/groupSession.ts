/**
 * M16-4c：群对称密钥 sessionStorage 缓存（关闭标签页即清除）。
 */
const GROUP_KEYS_SS = 'hailuo:group-session-keys';

function storageKey(groupId: string, epoch: number): string {
  return `${groupId}:${epoch}`;
}

export function setGroupSessionKey(groupId: string, epoch: number, groupKey: Uint8Array): void {
  if (typeof window === 'undefined') return;
  const raw = window.sessionStorage.getItem(GROUP_KEYS_SS);
  const map: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  map[storageKey(groupId, epoch)] = bytesToHexLocal(groupKey);
  window.sessionStorage.setItem(GROUP_KEYS_SS, JSON.stringify(map));
}

export function getGroupSessionKey(groupId: string, epoch: number): Uint8Array | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(GROUP_KEYS_SS);
  if (!raw) return null;
  const map = JSON.parse(raw) as Record<string, string>;
  const hex = map[storageKey(groupId, epoch)];
  if (!hex) return null;
  return hexToBytesLocal(hex);
}

export function clearGroupSessionKeys(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(GROUP_KEYS_SS);
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
