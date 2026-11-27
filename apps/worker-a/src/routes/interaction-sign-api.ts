/**
 * M9-19：站主 JWT 签发互动 envelope（浏览器经 Owner Gateway / 写层调用）。
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { buildSignedInteractionEnvelope } from '../lib/interactionEnvelope';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const interactionSignApiApp = new Hono<AppEnv>();

async function resolveOwnerActor(env: Env) {
  // M-OPT-SPLIT-A7-2：users → IDENTITY_DB
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT handle, worker_b_url FROM users LIMIT 1`)
    .first<{ handle: string; worker_b_url: string }>();
  if (!row?.handle?.trim() || !row.worker_b_url?.trim()) return null;
  return {
    handle: row.handle.trim(),
    node_url: row.worker_b_url.trim(),
  };
}

interactionSignApiApp.post('/sign-envelope', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    type?: unknown;
    post_id?: unknown;
    content?: unknown;
    reply_id?: unknown;
  } | null;
  if (!body) {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体无效' }, 400);
  }

  const type = body.type;
  if (type !== 'like' && type !== 'unlike' && type !== 'reply' && type !== 'delete_reply') {
    return c.json({ ok: false, error_code: 'TYPE_INVALID', message: '互动类型无效' }, 400);
  }
  const postId = typeof body.post_id === 'string' ? body.post_id.trim() : '';
  if (!postId) {
    return c.json({ ok: false, error_code: 'POST_ID_REQUIRED', message: 'post_id 不能为空' }, 400);
  }

  const actor = await resolveOwnerActor(c.env);
  if (!actor) {
    return c.json({ ok: false, error_code: 'OWNER_PROFILE_MISSING', message: '站主资料未初始化' }, 503);
  }

  const privateKey = c.env.ED25519_PRIVATE_KEY?.trim();
  const publicKey = c.env.ED25519_PUBLIC_KEY?.trim();
  if (!privateKey || !publicKey) {
    return c.json({ ok: false, error_code: 'SIGNING_KEY_MISSING', message: '节点签名密钥未配置' }, 503);
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const replyId = typeof body.reply_id === 'string' ? body.reply_id.trim() : '';
  if (type === 'reply' && !content) {
    return c.json({ ok: false, error_code: 'REPLY_CONTENT_REQUIRED', message: '回复内容不能为空' }, 400);
  }
  if (type === 'delete_reply' && !replyId) {
    return c.json({ ok: false, error_code: 'REPLY_ID_REQUIRED', message: '回复 ID 不能为空' }, 400);
  }

  const envelope = await buildSignedInteractionEnvelope(
    type,
    postId,
    actor,
    privateKey,
    publicKey,
    content,
    replyId,
  );
  return c.json({ ok: true, data: { envelope } });
});
