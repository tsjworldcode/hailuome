/**
 * NCF-AUDIT-Y-15-2：DM 路由共享类型 / 常量 / 小工具。
 * 公开面（routes/dm.ts）与内部 ingress（routes/dm/internal.ts）共用。
 */
import type { Context } from 'hono';
import { resolveIdentityDb } from '../../db/bindings';
import type { Env, AppVariables } from '../../env';

export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type DmContext = Context<AppEnv>;

export const DM_TICKET_TTL_SEC = 300;
export const DM_PAGE_LIMIT_MAX = 50;
export const DM_WRAPPED_KEY_MAX = 8192;
export const DM_IMPORT_BATCH_MAX = 200;
export const DM_IMPORT_BODY_MAX_BYTES = 512 * 1024;
export const DM_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function errorJson(
  c: DmContext,
  status: 400 | 403 | 404 | 409 | 429 | 500 | 503,
  code: string,
  message: string,
): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

export async function getLocalUser(env: Env) {
  return resolveIdentityDb(env)
    .prepare(`SELECT handle, pubkey, dm_pubkey, worker_b_url FROM users LIMIT 1`)
    .first<{ handle: string; pubkey: string; dm_pubkey: string; worker_b_url: string }>();
}

/** 公开面读 req.json；internal 优先读 HMAC 中间件缓存的 raw body。 */
export async function readRawJson(c: DmContext): Promise<Record<string, unknown> | null> {
  const rawBody = c.get('internalForwardBody') as string | undefined;
  if (rawBody) {
    try {
      return JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
