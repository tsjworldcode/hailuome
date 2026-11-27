/**
 * MM-2：Messaging Media 限额（env / system_config / shared-types 默认对齐）。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import {
  MESSAGING_MEDIA_MAX_BYTES,
  MESSAGING_MEDIA_MAX_PER_MESSAGE,
} from '@hailuo/shared-types';

async function readSystemConfigInt(
  db: D1Database,
  key: string,
  fallback: number,
): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(key)
      .first<{ value: string }>();
    if (!row?.value) return fallback;
    const n = parseInt(row.value.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 单图密文上限（字节）；wrangler var → system_config → 契约默认 10 MB。 */
export async function resolveMessagingMediaMaxBytes(env: Env): Promise<number> {
  const fromEnv = parseEnvInt(env.MESSAGING_MEDIA_MAX_BYTES, 0);
  if (fromEnv > 0) return fromEnv;
  return readSystemConfigInt(resolveIdentityDb(env), 'messaging_media_max_bytes', MESSAGING_MEDIA_MAX_BYTES);
}

/** 单条消息图片数上限。 */
export async function resolveMessagingMediaMaxPerMessage(env: Env): Promise<number> {
  const fromEnv = parseEnvInt(env.MESSAGING_MEDIA_MAX_PER_MESSAGE, 0);
  if (fromEnv > 0) return fromEnv;
  return readSystemConfigInt(
    resolveIdentityDb(env),
    'messaging_media_max_per_message',
    MESSAGING_MEDIA_MAX_PER_MESSAGE,
  );
}

/** 上传前登记 media_id（客户端写入 signed envelope）。 */
export function newMessagingMediaId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
