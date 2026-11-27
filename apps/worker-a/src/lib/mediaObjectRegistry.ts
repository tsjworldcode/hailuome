/**
 * M5-SR-P2：公开帖媒体对象登记与释放（删帖减 media_storage_usage 计数）。
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { deleteB2Object } from './b2upload';
import { parseB2ImageObjectKey } from './b2fetch';
import { deleteFilebaseObject } from './filebaseupload';
import { parseFilebaseImageObjectKey } from './filebasefetch';
import {
  resolveB2Config,
  resolveFilebaseConfig,
  toB2UploadConfig,
  toFilebaseUploadConfig,
} from './mediaStorage';
import {
  decrementUsage,
  finalizeMediaUpload,
  type MediaUsageBackend,
  type UsageAfterSnapshot,
} from './mediaStorageUsage';
import {
  takeExternalDeleteSlot,
  type ExternalDeleteBudget,
} from './mediaGcBudget';

export type MessagingUploadPurpose = 'dm' | 'group';

interface RegistryRow {
  object_key: string;
  backend: MediaUsageBackend;
  size_bytes: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 从 posts.image_keys 项解析用量后端 */
export function parsePublicImageKeyBackend(objectKey: string): MediaUsageBackend | null {
  if (objectKey.startsWith('filebase:')) return 'filebase';
  if (objectKey.startsWith('b2:')) return 'b2';
  if (objectKey.startsWith('r2:')) return 'r2';
  if (objectKey.startsWith('kv:')) return 'kv';
  return null;
}

/** 解析 posts.image_keys JSON */
export function parsePostImageKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}

/** 上传成功后登记对象（fail-soft，不阻断上传响应） */
export async function registerMediaObject(
  env: Env,
  objectKey: string,
  backend: MediaUsageBackend,
  sizeBytes: number,
): Promise<void> {
  if (sizeBytes <= 0) return;
  // media_object_registry 在 IDENTITY_DB
  const db = resolveIdentityDb(env);
  const iso = nowIso();
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO media_object_registry (object_key, backend, size_bytes, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(objectKey, backend, sizeBytes, iso)
      .run();
  } catch (err) {
    console.error('[mediaObjectRegistry] register 失败', objectKey, err);
  }
}

/** 公开帖上传：记账 + 登记对象 */
export async function finalizePublicMediaUpload(
  env: Env,
  backend: MediaUsageBackend,
  objectKey: string,
  sizeBytes: number,
): Promise<UsageAfterSnapshot | null> {
  const usage_after = await finalizeMediaUpload(env, backend, sizeBytes);
  await registerMediaObject(env, objectKey, backend, sizeBytes);
  return usage_after;
}

/** MM-2：Messaging Media 上传登记（scope=messaging；message_id 发信时再补）。 */
export async function registerMessagingMediaBlob(
  env: Env,
  params: {
    objectKey: string;
    backend: MediaUsageBackend;
    sizeBytes: number;
    mediaId: string;
    purpose: MessagingUploadPurpose;
    senderWorkerBUrl: string;
  },
): Promise<void> {
  if (params.sizeBytes <= 0) return;
  // media_object_registry 在 IDENTITY_DB
  const db = resolveIdentityDb(env);
  const iso = nowIso();
  const ownerKind = params.purpose === 'group' ? 'group_sender' : 'dm_sender';
  const retainUntil =
    params.purpose === 'group'
      ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
      : null;
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO media_object_registry (
           object_key, backend, size_bytes, created_at,
           scope, owner_kind, media_id, storage_state, sender_worker_b_url, retain_until
         ) VALUES (?, ?, ?, ?, 'messaging', ?, ?, 'active', ?, ?)`,
      )
      .bind(
        params.objectKey,
        params.backend,
        params.sizeBytes,
        iso,
        ownerKind,
        params.mediaId,
        params.senderWorkerBUrl,
        retainUntil,
      )
      .run();
  } catch (err) {
    console.error('[mediaObjectRegistry] registerMessagingMediaBlob 失败', params.objectKey, err);
  }
}

/**
 * M-AUDIT-FIX-1：预占式两阶段提交第一步。
 *
 * 上传真实 bytes 之前先在 IDENTITY_DB 登记一行 storage_state='pending'，
 * 防止「上传成功 + 后续 register 失败」造成孤儿 blob。
 *
 * - INSERT OR IGNORE：相同 object_key 重复 reserve 视为已存在，调用方应继续按 active 路径处理
 * - 返回 { ok: false, reason: 'ALREADY_RESERVED' } 表示行已存在但 storage_state 未知；
 *   调用方可选择放弃上传（保守）或继续按 active 处理
 */
export async function reserveMessagingMediaUpload(
  env: Env,
  params: {
    objectKey: string;
    backend: MediaUsageBackend;
    sizeBytes: number;
    mediaId: string;
    purpose: MessagingUploadPurpose;
    senderWorkerBUrl: string;
  },
): Promise<{ ok: true } | { ok: false; reason: 'ALREADY_RESERVED' }> {
  if (params.sizeBytes <= 0) return { ok: false, reason: 'ALREADY_RESERVED' };
  const db = resolveIdentityDb(env);
  const iso = nowIso();
  const ownerKind = params.purpose === 'group' ? 'group_sender' : 'dm_sender';
  const retainUntil =
    params.purpose === 'group'
      ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
      : null;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO media_object_registry (
         object_key, backend, size_bytes, created_at,
         scope, owner_kind, media_id, storage_state, sender_worker_b_url, retain_until
       ) VALUES (?, ?, ?, ?, 'messaging', ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      params.objectKey,
      params.backend,
      params.sizeBytes,
      iso,
      ownerKind,
      params.mediaId,
      params.senderWorkerBUrl,
      retainUntil,
    )
    .run();
  // meta.changes === 0 → 行已存在（之前 reserve 过或已是 active）
  if ((result.meta?.changes ?? 0) === 0) {
    return { ok: false, reason: 'ALREADY_RESERVED' };
  }
  return { ok: true };
}

/**
 * M-AUDIT-FIX-1：预占式两阶段提交第二步。
 *
 * 上传 bytes 成功 + finalizeMediaUpload 成功后调用，把 pending 行升级为 active。
 * 若 UPDATE 影响行数 = 0（行不存在或已是 active/abandoned），视为幂等成功。
 */
export async function activateMessagingMediaBlob(env: Env, objectKey: string): Promise<void> {
  const db = resolveIdentityDb(env);
  await db
    .prepare(
      `UPDATE media_object_registry
          SET storage_state = 'active'
        WHERE object_key = ?
          AND storage_state = 'pending'`,
    )
    .bind(objectKey)
    .run();
}

/**
 * M-AUDIT-FIX-1：预占式两阶段提交失败回滚。
 *
 * 上传 bytes 失败 / activate 失败 / finalizeMediaUpload 失败时调用，
 * 把 pending 行标记 abandoned + 设置 released_at，由 gcMessagingMediaBlobs 回收。
 */
export async function abandonMessagingMediaBlob(env: Env, objectKey: string): Promise<void> {
  const db = resolveIdentityDb(env);
  await db
    .prepare(
      `UPDATE media_object_registry
          SET storage_state = 'abandoned',
              released_at = ?
        WHERE object_key = ?
          AND storage_state = 'pending'`,
    )
    .bind(nowIso(), objectKey)
    .run();
}

/**
 * M-AUDIT-FIX-1：Messaging Media 上传 — 两阶段提交薄壳（向下兼容）。
 *
 * - reserve → upload bytes → activate + finalizeMediaUpload
 * - 任一失败由调用方 / gcMessagingMediaBlobs 兜底回收 abandoned 行
 * - 返回 usage_after 给调用方用于响应体
 */
export async function finalizeMessagingMediaUpload(
  env: Env,
  backend: MediaUsageBackend,
  objectKey: string,
  sizeBytes: number,
  meta: {
    mediaId: string;
    purpose: MessagingUploadPurpose;
    senderWorkerBUrl: string;
  },
): Promise<UsageAfterSnapshot | null> {
  // ① 预占：先写 IDENTITY_DB 'pending' 行
  const reserved = await reserveMessagingMediaUpload(env, {
    objectKey,
    backend,
    sizeBytes,
    mediaId: meta.mediaId,
    purpose: meta.purpose,
    senderWorkerBUrl: meta.senderWorkerBUrl,
  });
  // ALREADY_RESERVED → 行已存在（之前 reserve 过或 active）；保守起见继续走激活路径
  // 不重复 reserve，但 activate 单条 UPDATE 幂等

  // ②③ 激活 + 记账（bytes 已上传，由调用方保证）
  //    activate 抛错 → abandon 兜底
  //    finalizeMediaUpload 抛错 → bytes 已在 storage 但配额未加，abandon 标行，
  //                            由 gcMessagingMediaBlobs 释放 bytes（不 decrement，因配额未加）
  let usage_after: UsageAfterSnapshot | null = null;
  try {
    await activateMessagingMediaBlob(env, objectKey);
    usage_after = await finalizeMediaUpload(env, backend, sizeBytes);
  } catch (err) {
    await abandonMessagingMediaBlob(env, objectKey).catch((e) => {
      console.error('[mediaObjectRegistry] abandon 失败', objectKey, e);
    });
    throw err;
  }
  // 若 reserve ALREADY_RESERVED（行已存在），上面的 activate 实际没改行（条件 storage_state='pending'）；
  // 此时调用方应已把 bytes 视作 active 返回；不破坏现有行为
  void reserved;
  return usage_after;
}

/** MM-2：校验 storage_key 为本站主 messaging blob 且未释放。 */
export async function assertMessagingMediaReadable(
  env: Env,
  storageKey: string,
): Promise<boolean> {
  // media_object_registry 在 IDENTITY_DB
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(
        `SELECT 1 FROM media_object_registry
          WHERE object_key = ?
            AND scope = 'messaging'
            AND released_at IS NULL
          LIMIT 1`,
      )
      .bind(storageKey)
      .first();
    return row != null;
  } catch {
    return false;
  }
}

export async function deleteMediaObjectFromStorage(
  env: Env,
  objectKey: string,
  backend: MediaUsageBackend,
): Promise<void> {
  if (backend === 'kv') {
    await env.IMAGE_KV.delete(objectKey);
    return;
  }
  if (backend === 'r2') {
    if (!env.HAILUO_IMAGE_R2) throw new Error('R2 binding 未配置');
    await env.HAILUO_IMAGE_R2.delete(objectKey);
    return;
  }
  if (backend === 'filebase') {
    const objectName = parseFilebaseImageObjectKey(objectKey);
    if (!objectName) throw new Error('无效 Filebase key');
    const cfg = await resolveFilebaseConfig(env);
    if (!cfg) throw new Error('Filebase 未配置');
    await deleteFilebaseObject(toFilebaseUploadConfig(cfg), objectName);
    return;
  }
  if (backend === 'b2') {
    const objectName = parseB2ImageObjectKey(objectKey);
    if (!objectName) throw new Error('无效 B2 key');
    const cfg = await resolveB2Config(env);
    if (!cfg) throw new Error('B2 未配置');
    await deleteB2Object(toB2UploadConfig(cfg), objectName);
  }
}

/** 释放单个公开媒体对象：删存储 + decrementUsage（与私有附件删除对齐） */
export async function releaseRegisteredMediaObject(
  env: Env,
  objectKey: string,
  /** CRON-SCHEDULE-AUDIT：GC 轮次外部删除预算；B2/Filebase 超限时返回 false 并保留登记。 */
  budget?: ExternalDeleteBudget,
): Promise<boolean> {
  // media_object_registry 在 IDENTITY_DB
  const db = resolveIdentityDb(env);
  const row = await db
    .prepare(
      `SELECT object_key, backend, size_bytes
         FROM media_object_registry
        WHERE object_key = ?
          AND released_at IS NULL
        LIMIT 1`,
    )
    .bind(objectKey)
    .first<RegistryRow>();
  if (!row) return true;
  if (!takeExternalDeleteSlot(budget, row.backend)) return false;

  try {
    await deleteMediaObjectFromStorage(env, objectKey, row.backend);
    if (row.size_bytes > 0) {
      await decrementUsage(env, row.backend, row.size_bytes);
    }
    await db
      .prepare(
        `UPDATE media_object_registry SET released_at = ? WHERE object_key = ? AND released_at IS NULL`,
      )
      .bind(nowIso(), objectKey)
      .run();
  } catch (err) {
    console.warn('[mediaObjectRegistry] 释放公开媒体失败，保留登记待重试', objectKey, err);
  }
  // 失败与成功都返回 true：失败由既有「保留登记待重试」路径处理，不阻塞 GC 队列。
  return true;
}

/** 删帖后批量释放 image_keys（waitUntil 调用，fail-soft） */
export async function releasePostImageKeys(env: Env, imageKeys: readonly string[]): Promise<void> {
  for (const key of imageKeys) {
    if (!parsePublicImageKeyBackend(key)) continue;
    await releaseRegisteredMediaObject(env, key);
  }
}
