/**
 * NCF-AUDIT-Y-15-1：群路由共享类型 / 常量 / 小工具。
 * 公开路由（routes/groups.ts）与内部 ingress（routes/groups/internal.ts）共用。
 */
import type { Context } from 'hono';
import { resolveIdentityDb } from '../../db/bindings';
import type { Env, AppVariables } from '../../env';
import type { AcceptInviteInput } from '../../lib/groupInvite';

export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type GroupContext = Context<AppEnv>;

export const GROUP_NAME_MAX = 64;
export const GROUP_ANNOUNCEMENT_MAX = 512;
export const GROUP_ID_RE = /^grp_[a-zA-Z0-9_-]{8,128}$/;
export const GROUP_SYNC_TTL_MS = 5 * 60 * 1000;
export const GMSG_ID_RE = /^gmsg_[a-zA-Z0-9_-]{8,128}$/;
export const GROUP_MSG_PAGE_LIMIT_MAX = 50;
export const GROUP_WRAPPED_KEY_MAX = 8192;

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorJson(
  c: GroupContext,
  status: 400 | 403 | 404 | 409 | 410 | 429 | 500 | 502 | 503,
  code: string,
  message: string,
): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

export async function readRawJson(c: GroupContext): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function getLocalUser(env: Env) {
  return resolveIdentityDb(env)
    .prepare(`SELECT handle, pubkey, worker_b_url FROM users LIMIT 1`)
    .first<{ handle: string; pubkey: string; worker_b_url: string }>();
}

/** 解析 invite-accept / 短码入群 body（公开路由与 internal 共用）。 */
export function parseAcceptInviteBody(body: Record<string, unknown>): AcceptInviteInput | null {
  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
  const inviteToken = typeof body.invite_token === 'string' ? body.invite_token.trim() : '';
  const memberUrl =
    typeof body.member_worker_b_url === 'string' ? body.member_worker_b_url.trim() : '';
  const memberHandle = typeof body.member_handle === 'string' ? body.member_handle.trim() : '';
  const memberPubkey = typeof body.member_pubkey === 'string' ? body.member_pubkey.trim() : '';
  const memberDhPubkey =
    typeof body.member_dh_pubkey === 'string' ? body.member_dh_pubkey.trim() : '';
  const wrappedKeyJson =
    typeof body.wrapped_key_json === 'string' ? body.wrapped_key_json : null;
  // M16-INVITE-SHORT：短码入群可不带 group_id（群主查表还原）
  // SEC-AUDIT-2026-10-15：member_dh_pubkey 必填（权威侧再验 64 hex）
  if (!inviteToken || !memberUrl || !memberHandle || !memberPubkey || !memberDhPubkey) return null;
  return {
    ...(groupId ? { group_id: groupId } : {}),
    invite_token: inviteToken,
    member_worker_b_url: memberUrl,
    member_handle: memberHandle,
    member_pubkey: memberPubkey,
    member_dh_pubkey: memberDhPubkey,
    wrapped_key_json: wrappedKeyJson,
  };
}
