/**
 * OWNER-KEY-2：群主节点持钥表读写 + at-rest AES-GCM 包裹。
 * - 仅群主节点有意义；禁止 sync / Worker B 外泄
 * - 日志禁止打印 group_key / key_material 明文
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import {
  isValidGroupKeyFingerprint,
  normalizeGroupKeyFingerprint,
} from './groupRekeyPolicy';

const WRAP_PREFIX = 'gokw1';
const HKDF_INFO = 'hailuo-group-owner-epoch-key-wrap-v1';
/** 与 KEY-1 / deploy 约定一致 */
const SECRET_MIN_LEN = 32;

export class GroupOwnerKeyWrapError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'GROUP_OWNER_KEY_WRAP_SECRET_MISSING'
      | 'GROUP_OWNER_KEY_MALFORMED'
      | 'GROUP_OWNER_KEY_UNWRAP_FAILED',
  ) {
    super(message);
    this.name = 'GroupOwnerKeyWrapError';
  }
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return new Uint8Array(bytes);
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function resolveGroupOwnerKeyWrapSecret(env: Env): string | null {
  const s = env.GROUP_OWNER_KEY_WRAP_SECRET?.trim() ?? '';
  return s.length >= SECRET_MIN_LEN ? s : null;
}

export function requireGroupOwnerKeyWrapSecret(env: Env): string {
  const s = resolveGroupOwnerKeyWrapSecret(env);
  if (!s) {
    throw new GroupOwnerKeyWrapError(
      '节点未配置 GROUP_OWNER_KEY_WRAP_SECRET（≥32 字节），无法写入群主持钥表',
      'GROUP_OWNER_KEY_WRAP_SECRET_MISSING',
    );
  }
  return s;
}

export function isValidGroupKeyHex(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw.trim());
}

export function normalizeGroupKeyHex(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 与浏览器 fingerprintGroupKey 同源：SHA-256(raw 32 bytes) → 64 hex */
export async function fingerprintGroupKeyHex(groupKeyHex: string): Promise<string> {
  const hex = normalizeGroupKeyHex(groupKeyHex);
  if (!isValidGroupKeyHex(hex)) {
    throw new GroupOwnerKeyWrapError('group_key_hex 无效', 'GROUP_OWNER_KEY_MALFORMED');
  }
  const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', asBufferSource(hexToBytes(hex))));
  return bytesToHex(dig);
}

async function deriveWrapKey(wrapSecret: string): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(wrapSecret),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/** 落盘形态：`gokw1:<ivB64>:<ctB64>`，明文为 64 hex group_key */
export async function wrapGroupOwnerKeyMaterial(
  groupKeyHex: string,
  wrapSecret: string,
): Promise<string> {
  const hex = normalizeGroupKeyHex(groupKeyHex);
  if (!isValidGroupKeyHex(hex)) {
    throw new GroupOwnerKeyWrapError('group_key_hex 无效', 'GROUP_OWNER_KEY_MALFORMED');
  }
  if (wrapSecret.trim().length < SECRET_MIN_LEN) {
    throw new GroupOwnerKeyWrapError(
      'GROUP_OWNER_KEY_WRAP_SECRET 过弱',
      'GROUP_OWNER_KEY_WRAP_SECRET_MISSING',
    );
  }
  const keyBytes = await deriveWrapKey(wrapSecret.trim());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, [
    'encrypt',
  ]);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(iv) },
    aesKey,
    new TextEncoder().encode(hex),
  );
  return `${WRAP_PREFIX}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`;
}

export async function unwrapGroupOwnerKeyMaterial(
  keyMaterial: string,
  wrapSecret: string,
): Promise<string> {
  const parts = keyMaterial.trim().split(':');
  if (parts.length !== 3 || parts[0] !== WRAP_PREFIX) {
    throw new GroupOwnerKeyWrapError('持钥密文形态无效', 'GROUP_OWNER_KEY_UNWRAP_FAILED');
  }
  if (wrapSecret.trim().length < SECRET_MIN_LEN) {
    throw new GroupOwnerKeyWrapError(
      'GROUP_OWNER_KEY_WRAP_SECRET 过弱',
      'GROUP_OWNER_KEY_WRAP_SECRET_MISSING',
    );
  }
  const iv = base64ToBytes(parts[1]!);
  const ct = base64ToBytes(parts[2]!);
  const keyBytes = await deriveWrapKey(wrapSecret.trim());
  const aesKey = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, [
    'decrypt',
  ]);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBufferSource(iv) },
      aesKey,
      asBufferSource(ct),
    );
    const hex = new TextDecoder().decode(plain).trim().toLowerCase();
    if (!isValidGroupKeyHex(hex)) {
      throw new GroupOwnerKeyWrapError('持钥解密结果无效', 'GROUP_OWNER_KEY_UNWRAP_FAILED');
    }
    return hex;
  } catch (err) {
    if (err instanceof GroupOwnerKeyWrapError) throw err;
    throw new GroupOwnerKeyWrapError('持钥密文无法解密', 'GROUP_OWNER_KEY_UNWRAP_FAILED');
  }
}

export type OwnerEpochKeyMeta = {
  epoch: number;
  key_fingerprint: string;
  updated_at: string;
};

export async function getGroupOwnerEpochKeyMeta(
  env: Env,
  groupId: string,
  epoch: number,
): Promise<OwnerEpochKeyMeta | null> {
  const row = await messagingDb(env)
    .prepare(
      `SELECT epoch, key_fingerprint, updated_at FROM group_owner_epoch_keys
        WHERE group_id = ? AND epoch = ? LIMIT 1`,
    )
    .bind(groupId, epoch)
    .first<{ epoch: number; key_fingerprint: string; updated_at: string }>();
  if (!row) return null;
  const fp = normalizeGroupKeyFingerprint(row.key_fingerprint);
  if (!fp) return null;
  return { epoch: row.epoch, key_fingerprint: fp, updated_at: row.updated_at };
}

/**
 * OWNER-KEY-3+：读持钥表并 unwrap 出明文 group_key_hex（仅内存短用；禁止打日志）。
 * 缺行 / 缺 secret / 解密失败 → null。
 */
export async function loadUnwrappedGroupOwnerEpochKey(
  env: Env,
  groupId: string,
  epoch: number,
): Promise<{ group_key_hex: string; key_fingerprint: string } | null> {
  const secret = resolveGroupOwnerKeyWrapSecret(env);
  if (!secret) return null;
  const row = await messagingDb(env)
    .prepare(
      `SELECT key_material, key_fingerprint FROM group_owner_epoch_keys
        WHERE group_id = ? AND epoch = ? LIMIT 1`,
    )
    .bind(groupId, epoch)
    .first<{ key_material: string; key_fingerprint: string }>();
  if (!row?.key_material) return null;
  const fp = normalizeGroupKeyFingerprint(row.key_fingerprint);
  if (!fp) return null;
  try {
    const groupKeyHex = await unwrapGroupOwnerKeyMaterial(row.key_material, secret);
    return { group_key_hex: groupKeyHex, key_fingerprint: fp };
  } catch {
    return null;
  }
}

export type UpsertOwnerEpochKeyResult =
  | { ok: true; data: { group_id: string; epoch: number; key_fingerprint: string; created: boolean } }
  | {
      ok: false;
      status: 400 | 409 | 503;
      error_code: string;
      message: string;
    };

/**
 * 写入 / 幂等对齐持钥表。已有同行指纹相同 → created:false；不同 → 409。
 */
export async function upsertGroupOwnerEpochKey(
  env: Env,
  input: { groupId: string; epoch: number; groupKeyHex: string },
): Promise<UpsertOwnerEpochKeyResult> {
  const groupId = input.groupId.trim();
  const epoch = input.epoch;
  if (!groupId || !Number.isSafeInteger(epoch) || epoch < 1) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'epoch 无效' };
  }
  if (!isValidGroupKeyHex(input.groupKeyHex)) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: 'group_key_hex 须为 64 位 hex',
    };
  }

  let secret: string;
  try {
    secret = requireGroupOwnerKeyWrapSecret(env);
  } catch (err) {
    if (err instanceof GroupOwnerKeyWrapError) {
      return { ok: false, status: 503, error_code: err.code, message: err.message };
    }
    throw err;
  }

  const hex = normalizeGroupKeyHex(input.groupKeyHex);
  const fingerprint = await fingerprintGroupKeyHex(hex);
  if (!isValidGroupKeyFingerprint(fingerprint)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '指纹计算失败' };
  }

  const existing = await getGroupOwnerEpochKeyMeta(env, groupId, epoch);
  if (existing) {
    if (existing.key_fingerprint === fingerprint) {
      return {
        ok: true,
        data: {
          group_id: groupId,
          epoch,
          key_fingerprint: fingerprint,
          created: false,
        },
      };
    }
    return {
      ok: false,
      status: 409,
      error_code: 'GROUP_OWNER_KEY_MISMATCH',
      message: '该 epoch 已有不同指纹的持钥，拒绝覆盖',
    };
  }

  const keyMaterial = await wrapGroupOwnerKeyMaterial(hex, secret);
  const now = nowIso();
  await messagingDb(env)
    .prepare(
      `INSERT INTO group_owner_epoch_keys
         (group_id, epoch, key_material, key_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(groupId, epoch, keyMaterial, fingerprint, now, now)
    .run();

  return {
    ok: true,
    data: {
      group_id: groupId,
      epoch,
      key_fingerprint: fingerprint,
      created: true,
    },
  };
}

/** 建群时若已配 wrap secret：服务端生成 epoch 钥并写入持钥表；缺 secret 则跳过（legacy）。 */
export async function trySeedOwnerEpochKeyOnCreate(
  env: Env,
  groupId: string,
  epoch: number,
): Promise<
  | { ok: true; group_key_hex: string; key_fingerprint: string }
  | { ok: false; reason: 'secret_missing' | 'write_failed' }
> {
  if (!resolveGroupOwnerKeyWrapSecret(env)) {
    return { ok: false, reason: 'secret_missing' };
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const groupKeyHex = bytesToHex(raw);
  const result = await upsertGroupOwnerEpochKey(env, { groupId, epoch, groupKeyHex });
  if (!result.ok) {
    console.warn('[owner-key] 建群写入持钥表失败', result.error_code);
    return { ok: false, reason: 'write_failed' };
  }
  return {
    ok: true,
    group_key_hex: groupKeyHex,
    key_fingerprint: result.data.key_fingerprint,
  };
}
