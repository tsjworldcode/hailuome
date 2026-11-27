/**
 * M10-4 / M10-5c：私信敏感数据仅存 sessionStorage — 关闭标签页即清除（共用电脑优先）。
 *
 * 身份私钥（X25519）、会话 AES 密钥、已解密明文均不入 IndexedDB；
 * 登出或 clearAll 时显式清除；登录时 purge 旧版 IDB 残留。
 */
import { bytesToHex, hexToBytes } from '@hailuo/shared-utils';
import { DM_VOLATILE_SS_KEYS } from './dmSession';
import { openDb, __STORE__ } from './localDb';

const DM_IDENTITY_ID = 'default';

const SK = DM_VOLATILE_SS_KEYS;

export interface DmIdentityRecord {
  readonly id: typeof DM_IDENTITY_ID;
  readonly public_key_hex: string;
  readonly private_key_hex: string;
}

export interface DmSessionKeyRecord {
  readonly key_id: string;
  readonly conversation_id: string;
  readonly key_epoch: number;
  readonly peer_handle: string;
  readonly message_key_hex: string;
  /**
   * 发送侧 ephemeral 公钥（信封 `ephemeral_pubkey`）。
   * MSG-FIX-3：receive/hydrate/rewrap 写缓存时必须 merge 保留，不可整行覆盖抹掉。
   */
  readonly ephemeral_pubkey_hex?: string;
  /** 发送侧 ephemeral 私钥；与 pubkey 成对，仅本机 sessionStorage。 */
  readonly ephemeral_private_key_hex?: string;
}

export interface DmPlaintextRecord {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly peer_handle: string;
  readonly direction: 'inbox' | 'outbox';
  readonly plaintext: string;
  readonly created_at: string;
  /** MM-4：解密后的图片 blob URL（会话级，关闭标签页失效）。 */
  readonly media?: readonly DmMediaView[];
  /** MSG-FIX-2：出件箱投递态（仅 direction=outbox 有意义）。 */
  readonly delivery_status?: 'pending' | 'sent' | 'failed';
}

export interface DmMediaView {
  readonly media_id: string;
  readonly mime: string;
  readonly width?: number;
  readonly height?: number;
  /** M10-P3：语音条时长（毫秒），仅 audio/*。 */
  readonly duration_ms?: number;
  readonly object_url?: string;
}

function sessionKeyId(conversationId: string, keyEpoch: number): string {
  return `${conversationId}:${keyEpoch}`;
}

function ss(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage;
}

function readJson<T>(key: string, fallback: T): T {
  const store = ss();
  if (!store) return fallback;
  const raw = store.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  const store = ss();
  if (!store) return;
  store.setItem(key, JSON.stringify(value));
}
export async function purgeLegacyDmIdbStores(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(
        [__STORE__.DM_IDENTITY, __STORE__.DM_SESSION_KEYS, __STORE__.DM_PLAINTEXT],
        'readwrite',
      );
      t.objectStore(__STORE__.DM_IDENTITY).clear();
      t.objectStore(__STORE__.DM_SESSION_KEYS).clear();
      t.objectStore(__STORE__.DM_PLAINTEXT).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('purgeLegacyDmIdbStores 失败'));
    });
  } catch {
    // IDB 不可用时不阻断登录
  }
}

export async function getDmIdentity(): Promise<DmIdentityRecord | null> {
  return readJson<DmIdentityRecord | null>(SK.IDENTITY, null);
}

export async function saveDmIdentity(record: Omit<DmIdentityRecord, 'id'>): Promise<void> {
  writeJson(SK.IDENTITY, { id: DM_IDENTITY_ID, ...record });
}

export async function getDmSessionKey(
  conversationId: string,
  keyEpoch: number,
): Promise<DmSessionKeyRecord | null> {
  const map = readJson<Record<string, DmSessionKeyRecord>>(SK.SESSION_KEYS, {});
  return map[sessionKeyId(conversationId, keyEpoch)] ?? null;
}

export async function saveDmSessionKey(record: DmSessionKeyRecord): Promise<void> {
  const map = readJson<Record<string, DmSessionKeyRecord>>(SK.SESSION_KEYS, {});
  map[record.key_id] = record;
  writeJson(SK.SESSION_KEYS, map);
}

export async function listDmSessionKeys(): Promise<DmSessionKeyRecord[]> {
  const map = readJson<Record<string, DmSessionKeyRecord>>(SK.SESSION_KEYS, {});
  return Object.values(map);
}

export async function saveDmPlaintext(record: DmPlaintextRecord): Promise<void> {
  const map = readJson<Record<string, DmPlaintextRecord>>(SK.PLAINTEXT, {});
  map[record.message_id] = record;
  writeJson(SK.PLAINTEXT, map);
}

export async function getDmPlaintext(messageId: string): Promise<DmPlaintextRecord | null> {
  const map = readJson<Record<string, DmPlaintextRecord>>(SK.PLAINTEXT, {});
  return map[messageId] ?? null;
}

export async function listDmPlaintexts(): Promise<DmPlaintextRecord[]> {
  const map = readJson<Record<string, DmPlaintextRecord>>(SK.PLAINTEXT, {});
  return Object.values(map);
}

/** M10-5a：localData 导入时批量写回已解密私信（仅当前标签 sessionStorage） */
export async function bulkPutDmPlaintexts(items: readonly DmPlaintextRecord[]): Promise<void> {
  const map = readJson<Record<string, DmPlaintextRecord>>(SK.PLAINTEXT, {});
  for (const item of items) {
    map[item.message_id] = item;
  }
  writeJson(SK.PLAINTEXT, map);
}

export async function deleteDmPlaintextByConversation(conversationId: string): Promise<void> {
  const map = readJson<Record<string, DmPlaintextRecord>>(SK.PLAINTEXT, {});
  for (const [id, row] of Object.entries(map)) {
    if (row.conversation_id === conversationId) delete map[id];
  }
  writeJson(SK.PLAINTEXT, map);
}

export async function deleteDmSessionKeysByConversation(conversationId: string): Promise<void> {
  const map = readJson<Record<string, DmSessionKeyRecord>>(SK.SESSION_KEYS, {});
  for (const [id, row] of Object.entries(map)) {
    if (row.conversation_id === conversationId) delete map[id];
  }
  writeJson(SK.SESSION_KEYS, map);
}

export function messageKeyToHex(key: Uint8Array): string {
  return bytesToHex(key);
}

export function messageKeyFromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}