/**
 * M10-5b：私信加密全量备份（D1 密文 + 外层备份口令 AES-GCM）。
 * 明文私钥 / message_key / JWT 永不进入备份文件。
 */
import { derivePasswordHash, PBKDF2_ITERATIONS } from '@hailuo/shared-crypto/password';
import { encodeText } from '@hailuo/shared-utils';
import type { createWorkerAClient, DmMessageItem } from './workerA';

export const DM_BACKUP_FORMAT = 'hailuo-dm-backup-v1' as const;
export const DM_BACKUP_ENCRYPTED_FORMAT = 'hailuo-dm-backup-v1-encrypted' as const;
export const DM_BACKUP_OUTER_SALT = 'hailuo-dm-backup-v1';
export const DM_BACKUP_OUTER_INFO = 'outer';
/** 解密后 JSON 软上限（5 MB） */
export const DM_BACKUP_MAX_PLAINTEXT_BYTES = 5 * 1024 * 1024;
export const DM_IMPORT_BATCH_SIZE = 200;

const FORBIDDEN_BACKUP_KEYS = new Set([
  'private_key_hex',
  'message_key_hex',
  'plaintext',
  'password_hash',
  'jwt',
]);

type WorkerAClient = ReturnType<typeof createWorkerAClient>;

export interface DmBackupMessageRow {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly direction: 'inbox' | 'outbox';
  readonly peer_handle: string;
  readonly peer_worker_b_url: string;
  readonly envelope_json: string;
  readonly created_at: string;
  readonly read_at: string | null;
  readonly delivery_status: string;
}

export interface DmBackupWrappedKeyRow {
  readonly conversation_id: string;
  readonly key_epoch: number;
  readonly peer_handle: string;
  readonly wrapped_key_json: string;
}

export interface DmBackupWrappedIdentityRow {
  readonly public_key_hex: string;
  readonly wrapped_identity_json: string;
}

export interface DmBackupPlaintext {
  readonly meta: {
    readonly format: typeof DM_BACKUP_FORMAT;
    readonly exported_at: string;
    readonly export_origin: string;
    readonly owner_handle: string;
    readonly worker_b_url: string;
    readonly dm_pubkey_hex: string;
    readonly identity_legacy?: boolean;
    readonly counts: {
      readonly messages_inbox: number;
      readonly messages_outbox: number;
      readonly wrapped_keys: number;
      readonly has_wrapped_identity: boolean;
    };
  };
  readonly payload: {
    readonly wrapped_identity: DmBackupWrappedIdentityRow | null;
    readonly wrapped_keys: readonly DmBackupWrappedKeyRow[];
    readonly messages: readonly DmBackupMessageRow[];
  };
}

export interface DmBackupEncryptedWrap {
  readonly v: 1;
  readonly salt_hex: string;
  readonly iterations: number;
  readonly nonce_b64: string;
  readonly ciphertext_b64: string;
}

export interface DmBackupEncryptedFile {
  readonly format: typeof DM_BACKUP_ENCRYPTED_FORMAT;
  readonly wrap: DmBackupEncryptedWrap;
}

export interface DmBackupImportResult {
  readonly messages_inserted: number;
  readonly messages_skipped: number;
  readonly wrapped_keys_upserted: number;
  readonly wrapped_identity_imported: boolean;
}

export class DmBackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomSaltHex(byteLen = 16): string {
  const salt = crypto.getRandomValues(new Uint8Array(byteLen));
  return [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toCryptoBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: toCryptoBytes(salt), info: toCryptoBytes(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** 备份口令 → 外层 AES-256-GCM 密钥（独立于登录 KEK） */
export async function deriveBackupOuterKey(
  backupPassphrase: string,
  saltHex: string,
  iterations: number,
): Promise<Uint8Array> {
  const backupKdf = await derivePasswordHash(backupPassphrase, saltHex, iterations);
  const ikm = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(backupKdf))),
  );
  return hkdfSha256(
    ikm,
    toCryptoBytes(encodeText(DM_BACKUP_OUTER_SALT)),
    toCryptoBytes(encodeText(DM_BACKUP_OUTER_INFO)),
    32,
  );
}

function assertNoForbiddenKeys(value: unknown, path = 'payload'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoForbiddenKeys(value[i], `${path}[${i}]`);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_BACKUP_KEYS.has(key)) {
      throw new DmBackupError('DM_BACKUP_FORBIDDEN_FIELD', `备份内容含禁止字段：${path}.${key}`);
    }
    assertNoForbiddenKeys(nested, `${path}.${key}`);
  }
}

function messageToBackupRow(item: DmMessageItem): DmBackupMessageRow {
  return {
    message_id: item.message_id,
    conversation_id: item.conversation_id,
    direction: item.direction,
    peer_handle: item.peer_handle,
    peer_worker_b_url: item.peer_worker_b_url,
    envelope_json: JSON.stringify(item.envelope),
    created_at: item.created_at,
    read_at: item.read_at,
    delivery_status: item.delivery_status,
  };
}

async function fetchAllDmMessages(
  listFn: (params: { limit?: number; cursor?: string }) => Promise<{ items: readonly DmMessageItem[]; has_more: boolean; cursor: string | null }>,
): Promise<DmMessageItem[]> {
  const byId = new Map<string, DmMessageItem>();
  let cursor: string | undefined;
  for (;;) {
    const page = await listFn({ limit: 50, cursor });
    for (const item of page.items) byId.set(item.message_id, item);
    if (!page.has_more || !page.cursor) break;
    cursor = page.cursor;
  }
  return [...byId.values()];
}

/** 分页拉取 D1 私信密文并组装明文备份结构（未外层加密） */
export async function buildDmBackup(
  client: WorkerAClient,
  options?: { exportOrigin?: string; identityLegacy?: boolean },
): Promise<DmBackupPlaintext> {
  const me = await client.getMe();
  const [wrappedIdentity, wrappedKeys, inboxItems, outboxItems] = await Promise.all([
    client.getDmWrappedIdentity(),
    client.listDmWrappedKeys(),
    fetchAllDmMessages((p) => client.listDmInbox(p)),
    fetchAllDmMessages((p) => client.listDmOutbox(p)),
  ]);

  const messageMap = new Map<string, DmBackupMessageRow>();
  for (const item of inboxItems) messageMap.set(item.message_id, messageToBackupRow(item));
  for (const item of outboxItems) messageMap.set(item.message_id, messageToBackupRow(item));
  const messages = [...messageMap.values()];

  const inboxCount = messages.filter((m) => m.direction === 'inbox').length;
  const outboxCount = messages.filter((m) => m.direction === 'outbox').length;

  const snapshot: DmBackupPlaintext = {
    meta: {
      format: DM_BACKUP_FORMAT,
      exported_at: new Date().toISOString(),
      export_origin: options?.exportOrigin ?? (typeof window !== 'undefined' ? window.location.origin : ''),
      owner_handle: me.handle,
      worker_b_url: me.worker_b_url,
      dm_pubkey_hex: me.dm_pubkey ?? '',
      identity_legacy: options?.identityLegacy === true ? true : undefined,
      counts: {
        messages_inbox: inboxCount,
        messages_outbox: outboxCount,
        wrapped_keys: wrappedKeys.items.length,
        has_wrapped_identity: wrappedIdentity !== null,
      },
    },
    payload: {
      wrapped_identity: wrappedIdentity
        ? {
            public_key_hex: wrappedIdentity.public_key_hex,
            wrapped_identity_json: wrappedIdentity.wrapped_identity_json,
          }
        : null,
      wrapped_keys: wrappedKeys.items.map((row) => ({
        conversation_id: row.conversation_id,
        key_epoch: row.key_epoch,
        peer_handle: row.peer_handle,
        wrapped_key_json: row.wrapped_key_json,
      })),
      messages,
    },
  };

  assertNoForbiddenKeys(snapshot.payload);
  const json = JSON.stringify(snapshot);
  if (json.length > DM_BACKUP_MAX_PLAINTEXT_BYTES) {
    throw new DmBackupError(
      'DM_BACKUP_TOO_LARGE',
      '私信数据过多，超过 5 MB 备份上限。请先清理旧消息或联系后续分卷导出能力。',
    );
  }
  return snapshot;
}

export async function encryptDmBackup(
  snapshot: DmBackupPlaintext,
  backupPassphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<DmBackupEncryptedFile> {
  const saltHex = randomSaltHex();
  const outerKey = await deriveBackupOuterKey(backupPassphrase, saltHex, iterations);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(outerKey), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plainBytes = toCryptoBytes(encodeText(JSON.stringify(snapshot)));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plainBytes),
  );
  return {
    format: DM_BACKUP_ENCRYPTED_FORMAT,
    wrap: {
      v: 1,
      salt_hex: saltHex,
      iterations,
      nonce_b64: bytesToBase64(nonce),
      ciphertext_b64: bytesToBase64(cipher),
    },
  };
}

export function parseDmBackupEncryptedFile(raw: unknown): DmBackupEncryptedFile {
  if (!raw || typeof raw !== 'object') {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份文件格式无效');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== DM_BACKUP_ENCRYPTED_FORMAT) {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份文件格式无效');
  }
  const wrap = obj.wrap;
  if (!wrap || typeof wrap !== 'object') {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份 wrap 段无效');
  }
  const w = wrap as Record<string, unknown>;
  if (
    w.v !== 1 ||
    typeof w.salt_hex !== 'string' ||
    typeof w.iterations !== 'number' ||
    typeof w.nonce_b64 !== 'string' ||
    typeof w.ciphertext_b64 !== 'string'
  ) {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份 wrap 字段不完整');
  }
  return {
    format: DM_BACKUP_ENCRYPTED_FORMAT,
    wrap: {
      v: 1,
      salt_hex: w.salt_hex,
      iterations: w.iterations,
      nonce_b64: w.nonce_b64,
      ciphertext_b64: w.ciphertext_b64,
    },
  };
}

export function parseDmBackupPlaintext(raw: unknown): DmBackupPlaintext {
  if (!raw || typeof raw !== 'object') {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份内容格式无效');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== undefined) {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '请使用加密备份文件导入');
  }
  const meta = obj.meta;
  const payload = obj.payload;
  if (!meta || typeof meta !== 'object' || !payload || typeof payload !== 'object') {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份 meta/payload 无效');
  }
  const m = meta as Record<string, unknown>;
  if (m.format !== DM_BACKUP_FORMAT) {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份 format 不匹配');
  }
  assertNoForbiddenKeys(payload, 'payload');
  return raw as DmBackupPlaintext;
}

export async function decryptDmBackup(
  encrypted: DmBackupEncryptedFile,
  backupPassphrase: string,
): Promise<DmBackupPlaintext> {
  try {
    const outerKey = await deriveBackupOuterKey(
      backupPassphrase,
      encrypted.wrap.salt_hex,
      encrypted.wrap.iterations,
    );
    const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(outerKey), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(encrypted.wrap.nonce_b64)) },
      aesKey,
      toCryptoBytes(base64ToBytes(encrypted.wrap.ciphertext_b64)),
    );
    const text = new TextDecoder().decode(plain);
    if (text.length > DM_BACKUP_MAX_PLAINTEXT_BYTES) {
      throw new DmBackupError('DM_BACKUP_TOO_LARGE', '备份解密后体积超限');
    }
    return parseDmBackupPlaintext(JSON.parse(text) as unknown);
  } catch (err) {
    if (err instanceof DmBackupError) throw err;
    throw new DmBackupError('BACKUP_DECRYPT_FAILED', '备份口令错误或文件已损坏');
  }
}

export async function decryptDmBackupFromJson(
  jsonText: string,
  backupPassphrase: string,
): Promise<DmBackupPlaintext> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    throw new DmBackupError('DM_BACKUP_INVALID_FORMAT', '备份文件不是有效 JSON');
  }
  const encrypted = parseDmBackupEncryptedFile(parsed);
  return decryptDmBackup(encrypted, backupPassphrase);
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** 合并写回 D1：wrapped_identity / wrapped_keys / messages 分批 import */
export async function importDmBackup(
  client: WorkerAClient,
  snapshot: DmBackupPlaintext,
): Promise<DmBackupImportResult> {
  const me = await client.getMe();
  const handle = me.handle.trim().toLowerCase();
  const backupHandle = snapshot.meta.owner_handle.trim().toLowerCase();
  if (backupHandle !== handle) {
    // HANDLE-QUAL-V1：展示用正式名（是否带 :regN 由服务端决定），比较仍用本地短名
    const currentLabel = me.handle_qualified?.trim() || me.handle;
    throw new DmBackupError(
      'DM_BACKUP_HANDLE_MISMATCH',
      `备份属于「${snapshot.meta.owner_handle}」，与当前登录「${currentLabel}」不一致，已拒绝导入。`,
    );
  }
  if (normalizeUrl(snapshot.meta.worker_b_url) !== normalizeUrl(me.worker_b_url)) {
    throw new DmBackupError(
      'DM_BACKUP_HANDLE_MISMATCH',
      '备份的 Worker B 地址与当前节点不一致，已拒绝导入。',
    );
  }

  let wrappedIdentityImported = false;
  if (snapshot.payload.wrapped_identity) {
    const existing = await client.getDmWrappedIdentity();
    const backupPub = snapshot.payload.wrapped_identity.public_key_hex.trim().toLowerCase();
    if (existing) {
      const existingPub = existing.public_key_hex.trim().toLowerCase();
      if (existingPub !== backupPub) {
        throw new DmBackupError(
          'DM_BACKUP_IDENTITY_CONFLICT',
          '节点已有不同私信身份公钥。请先在「私信与隐私」执行重新生成身份，或确认备份文件属于本节点。',
        );
      }
    } else {
      await client.putDmWrappedIdentity({
        public_key_hex: snapshot.payload.wrapped_identity.public_key_hex,
        wrapped_identity_json: snapshot.payload.wrapped_identity.wrapped_identity_json,
      });
      wrappedIdentityImported = true;
    }
  }

  let wrappedKeysUpserted = 0;
  for (const row of snapshot.payload.wrapped_keys) {
    await client.putDmWrappedKey({
      conversation_id: row.conversation_id,
      key_epoch: row.key_epoch,
      peer_handle: row.peer_handle,
      wrapped_key_json: row.wrapped_key_json,
    });
    wrappedKeysUpserted += 1;
  }

  let messagesInserted = 0;
  let messagesSkipped = 0;
  const items = snapshot.payload.messages;
  for (let i = 0; i < items.length; i += DM_IMPORT_BATCH_SIZE) {
    const batch = items.slice(i, i + DM_IMPORT_BATCH_SIZE);
    const result = await client.importDmMessages(batch);
    messagesInserted += result.inserted;
    messagesSkipped += result.skipped;
  }

  return {
    messages_inserted: messagesInserted,
    messages_skipped: messagesSkipped,
    wrapped_keys_upserted: wrappedKeysUpserted,
    wrapped_identity_imported: wrappedIdentityImported,
  };
}

/** 备份口令强度：≥12 字符且含字母、数字、符号 */
export function validateBackupPassphrase(passphrase: string): { ok: true } | { ok: false; reason: string } {
  const p = passphrase;
  if (p.length < 12) return { ok: false, reason: '备份口令需 ≥ 12 字符' };
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p)) {
    return { ok: false, reason: '备份口令需同时包含字母、数字与符号' };
  }
  return { ok: true };
}
