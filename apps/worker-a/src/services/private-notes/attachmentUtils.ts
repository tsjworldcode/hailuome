/**
 * NCF-NOTES-4：私有附件纯工具（无 Env）。
 */
import type { PrivateNotePrivateStorage } from './types';

export const PRIVATE_NOTE_MAX_KV_BYTES = 25 * 1024 * 1024;

export function sanitizeAttachmentName(raw: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return value.replace(/[\\/\r\n\t]/g, '_').slice(0, 160);
}

export function privateKvKey(noteOrPendingId: string, attachmentId: string): string {
  return `private-notes:${noteOrPendingId}:${attachmentId}`;
}

export function privateB2ObjectKey(noteOrPendingId: string, attachmentId: string): string {
  return `notes/${noteOrPendingId}/${attachmentId}`;
}

/** resolveUploadBackend 结果 → 私有附件 storage 标签（R2 回落 KV） */
export function mapUploadBackendToPrivateStorage(
  backend: string,
  contentType: string,
  declaredSize: number | null,
): PrivateNotePrivateStorage | null {
  if (backend === 'filebase') return 'filebase_private';
  if (backend === 'b2') return 'b2_private';
  if (backend === 'kv') return 'kv_private';
  if (backend === 'r2') {
    if (!contentType.startsWith('image/')) return null;
    if (declaredSize != null && declaredSize > PRIVATE_NOTE_MAX_KV_BYTES) return null;
    return 'kv_private';
  }
  return null;
}

export function privateStorageToUsageBackend(
  storage: string,
): 'kv' | 'filebase' | 'b2' | null {
  if (storage === 'kv_private') return 'kv';
  if (storage === 'filebase_private') return 'filebase';
  if (storage === 'b2_private') return 'b2';
  return null;
}

/** serve 响应头字段（路由再装配 Headers） */
export function privateAttachmentCacheHeaderFields(mime: string): {
  contentType: string;
  cacheControl: string;
  vary: string;
} {
  return {
    contentType: mime || 'application/octet-stream',
    cacheControl: 'private, no-store',
    vary: 'Authorization',
  };
}
