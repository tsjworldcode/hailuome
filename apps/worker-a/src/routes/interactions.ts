/**
 * M9-19：跨节点互动签名 envelope 硬化（在 M9-18 点赞/回复基础上）。
 *
 * 写操作强制走 envelope（Ed25519 + nonce + 黑名单），不接受未验签的旧格式。
 */
import { resolveContentDb, resolveGovernanceDb } from '../db/bindings';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from '../env';
import { generateId, nowISO } from '@hailuo/shared-utils';
import { verifyRequest } from '@hailuo/shared-crypto';
import {
  buildSignedInteractionEnvelope,
  normalizeEnvelopeActor,
  parseInteractionEnvelope,
  resolveInteractionBodyHash,
  verifyInteractionEnvelope,
} from '../lib/interactionEnvelope';
import { recordLocalNotification, truncatePreview } from '../lib/localNotifications';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type InteractionContext = Context<AppEnv>;

interface ReplyRow {
  readonly id: string;
  readonly post_id: string;
  readonly actor_handle: string;
  readonly actor_node_url: string;
  readonly content: string;
  readonly created_at: string;
}

const MAX_REPLY_LENGTH = 300;

export const interactionsApp = new Hono<AppEnv>();

async function parseJsonBody<T>(c: InteractionContext): Promise<T | null> {
  const rawBody = c.get('internalForwardBody') as string | undefined;
  if (!rawBody) return null;
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    return null;
  }
}

async function requireInternalForward(c: InteractionContext, next: () => Promise<void>): Promise<Response | void> {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!configured || marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }

  const rawBody = await c.req.text();
  const url = new URL(c.req.url);
  const ok = await verifyRequest(
    { method: c.req.method.toUpperCase(), path: `${url.pathname}${url.search}` },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }
  c.set('internalForwardBody', rawBody);
  await next();
}

async function ensurePostExists(env: Env, postId: string): Promise<boolean> {
  const row = await resolveContentDb(env)
    .prepare(`SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL LIMIT 1`)
    .bind(postId)
    .first<{ id: string }>()
    .catch(() => null);
  return row !== null;
}

async function interactionSummary(env: Env, postId: string, actorNodeUrl?: string) {
  const gov = resolveGovernanceDb(env);
  const [likes, replies, myLike] = await Promise.all([
    gov
      .prepare(`SELECT COUNT(*) AS count FROM post_likes WHERE post_id = ?`)
      .bind(postId)
      .first<{ count: number }>(),
    gov
      .prepare(`SELECT COUNT(*) AS count FROM post_replies WHERE post_id = ? AND deleted_at IS NULL`)
      .bind(postId)
      .first<{ count: number }>(),
    actorNodeUrl
      ? gov
          .prepare(`SELECT 1 AS liked FROM post_likes WHERE post_id = ? AND actor_node_url = ? LIMIT 1`)
          .bind(postId, actorNodeUrl)
          .first<{ liked: number }>()
      : Promise.resolve(null),
  ]);
  return {
    post_id: postId,
    like_count: likes?.count ?? 0,
    reply_count: replies?.count ?? 0,
    liked_by_me: myLike !== null,
  };
}

function envelopeValidationError(
  validation: { ok: false; error_code: string; message: string },
): Response {
  const status = validation.error_code === 'BLACKLISTED' ? 403 : 400;
  return Response.json(validation, { status });
}

interactionsApp.use('*', requireInternalForward);

/** 内部：为本节点 actor 签发互动 envelope（Worker B 代粉丝节点调用）。 */
interactionsApp.post('/sign-envelope', async (c) => {
  const body = await parseJsonBody<{
    type?: unknown;
    post_id?: unknown;
    actor?: unknown;
    content?: unknown;
    reply_id?: unknown;
  }>(c);
  if (!body) {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体无效' }, 400);
  }
  const type = body.type;
  if (type !== 'like' && type !== 'unlike' && type !== 'reply' && type !== 'delete_reply') {
    return c.json({ ok: false, error_code: 'TYPE_INVALID', message: '互动类型无效' }, 400);
  }
  const postId = typeof body.post_id === 'string' ? body.post_id.trim() : '';
  const actor = normalizeEnvelopeActor(body.actor);
  if (!postId || !actor) {
    return c.json({ ok: false, error_code: 'ACTOR_INVALID', message: '互动身份无效' }, 400);
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

interactionsApp.post('/posts/:postId/like', async (c) => {
  const postId = c.req.param('postId');
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体无效' }, 400);
  }

  const envelope = parseInteractionEnvelope(body.envelope);
  // 内部 HMAC 只证明转发来源，不能替代互动者签名；解析失败也不得回退。
  if (!envelope) {
    return c.json({ ok: false, error_code: 'ENVELOPE_REQUIRED', message: '互动需要有效的签名 envelope' }, 400);
  }
  if (envelope.post_id !== postId) {
    return c.json({ ok: false, error_code: 'POST_ID_MISMATCH', message: '帖子 ID 不匹配' }, 400);
  }
  if (envelope.type !== 'like') {
    return c.json({ ok: false, error_code: 'TYPE_MISMATCH', message: '期望 like 类型' }, 400);
  }
  if (!(await ensurePostExists(c.env, postId))) {
    return c.json({ ok: false, error_code: 'POST_NOT_FOUND', message: '帖子不存在或已删除' }, 404);
  }
  const validation = await verifyInteractionEnvelope(c.env, envelope);
  if (!validation.ok) return envelopeValidationError(validation);

  const likeResult = await resolveGovernanceDb(c.env)
    .prepare(
      `INSERT OR IGNORE INTO post_likes
       (post_id, actor_handle, actor_node_url, actor_pubkey, created_at, sig)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      postId,
      envelope.actor.handle,
      envelope.actor.node_url,
      envelope.actor.pubkey ?? '',
      envelope.created_at,
      envelope.sig,
    )
    .run();
  if ((likeResult.meta.changes ?? 0) > 0) {
    await recordLocalNotification(c.env, {
      type: 'like',
      post_id: postId,
      actor_handle: envelope.actor.handle,
      actor_node_url: envelope.actor.node_url,
    });
  }

  return c.json({ ok: true, data: await interactionSummary(c.env, postId, envelope.actor.node_url) });
});

interactionsApp.delete('/posts/:postId/like', async (c) => {
  const postId = c.req.param('postId');
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体无效' }, 400);
  }

  const envelope = parseInteractionEnvelope(body.envelope);
  // 即使有旧版 actor 字段，也必须先通过 envelope 验证才能删除点赞。
  if (!envelope) {
    return c.json({ ok: false, error_code: 'ENVELOPE_REQUIRED', message: '互动需要有效的签名 envelope' }, 400);
  }
  if (envelope.post_id !== postId || envelope.type !== 'unlike') {
    return c.json({ ok: false, error_code: 'ENVELOPE_INVALID', message: 'envelope 与取消点赞不匹配' }, 400);
  }
  const validation = await verifyInteractionEnvelope(c.env, envelope);
  if (!validation.ok) return envelopeValidationError(validation);

  await resolveGovernanceDb(c.env)
    .prepare(`DELETE FROM post_likes WHERE post_id = ? AND actor_node_url = ?`)
    .bind(postId, envelope.actor.node_url)
    .run();
  return c.json({ ok: true, data: await interactionSummary(c.env, postId, envelope.actor.node_url) });
});

interactionsApp.post('/posts/:postId/replies', async (c) => {
  const postId = c.req.param('postId');
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体无效' }, 400);
  }

  const envelope = parseInteractionEnvelope(body.envelope);
  // 缺失或畸形 envelope 在任何数据库访问、通知写入之前拒绝。
  if (!envelope) {
    return c.json({ ok: false, error_code: 'ENVELOPE_REQUIRED', message: '互动需要有效的签名 envelope' }, 400);
  }
  if (envelope.post_id !== postId || envelope.type !== 'reply') {
    return c.json({ ok: false, error_code: 'ENVELOPE_INVALID', message: 'envelope 与回复不匹配' }, 400);
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return c.json({ ok: false, error_code: 'REPLY_CONTENT_REQUIRED', message: '回复内容不能为空' }, 400);
  }
  if ([...content].length > MAX_REPLY_LENGTH) {
    return c.json({ ok: false, error_code: 'REPLY_CONTENT_TOO_LONG', message: `回复不能超过 ${MAX_REPLY_LENGTH} 字符` }, 400);
  }
  if (!(await ensurePostExists(c.env, postId))) {
    return c.json({ ok: false, error_code: 'POST_NOT_FOUND', message: '帖子不存在或已删除' }, 404);
  }
  const expectedBodyHash = await resolveInteractionBodyHash('reply', content);
  const validation = await verifyInteractionEnvelope(c.env, envelope, expectedBodyHash);
  if (!validation.ok) return envelopeValidationError(validation);

  const id = generateId('reply');
  await resolveGovernanceDb(c.env)
    .prepare(
      `INSERT INTO post_replies
       (id, post_id, actor_handle, actor_node_url, content, created_at, sig)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, postId, envelope.actor.handle, envelope.actor.node_url, content, envelope.created_at, envelope.sig)
    .run();
  await recordLocalNotification(c.env, {
    type: 'reply',
    post_id: postId,
    actor_handle: envelope.actor.handle,
    actor_node_url: envelope.actor.node_url,
    reply_id: id,
    content_preview: truncatePreview(content),
  });

  return c.json({
    ok: true,
    data: {
      reply: {
        id,
        post_id: postId,
        actor_handle: envelope.actor.handle,
        actor_node_url: envelope.actor.node_url,
        content,
        created_at: envelope.created_at,
      },
      summary: await interactionSummary(c.env, postId, envelope.actor.node_url),
    },
  });
});

interactionsApp.delete('/posts/:postId/replies/:replyId', async (c) => {
  const postId = c.req.param('postId');
  const replyId = c.req.param('replyId');
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体无效' }, 400);
  }

  const envelope = parseInteractionEnvelope(body.envelope);
  if (!envelope || envelope.post_id !== postId || envelope.type !== 'delete_reply') {
    return c.json({ ok: false, error_code: 'ENVELOPE_INVALID', message: 'envelope 与删除回复不匹配' }, 400);
  }

  const expectedBodyHash = await resolveInteractionBodyHash('delete_reply', '', replyId);
  const validation = await verifyInteractionEnvelope(c.env, envelope, expectedBodyHash);
  if (!validation.ok) return envelopeValidationError(validation);

  const row = await resolveGovernanceDb(c.env)
    .prepare(
      `SELECT id, actor_node_url FROM post_replies
        WHERE id = ? AND post_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(replyId, postId)
    .first<{ id: string; actor_node_url: string }>();
  if (!row) {
    return c.json({ ok: false, error_code: 'REPLY_NOT_FOUND', message: '回复不存在或已删除' }, 404);
  }
  if (row.actor_node_url !== envelope.actor.node_url) {
    return c.json({ ok: false, error_code: 'REPLY_FORBIDDEN', message: '只能删除自己的回复' }, 403);
  }

  const deletedAt = nowISO();
  await resolveGovernanceDb(c.env)
    .prepare(`UPDATE post_replies SET deleted_at = ? WHERE id = ? AND post_id = ?`)
    .bind(deletedAt, replyId, postId)
    .run();

  return c.json({
    ok: true,
    data: {
      reply_id: replyId,
      deleted_at: deletedAt,
      summary: await interactionSummary(c.env, postId, envelope.actor.node_url),
    },
  });
});

interactionsApp.post('/posts/:postId/summary', async (c) => {
  const postId = c.req.param('postId');
  const body = await parseJsonBody<{ actor?: unknown }>(c);
  const actor = normalizeEnvelopeActor(body?.actor);
  return c.json({ ok: true, data: await interactionSummary(c.env, postId, actor?.node_url) });
});

interactionsApp.get('/posts/:postId/replies', async (c) => {
  const postId = c.req.param('postId');
  const limitParam = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = isNaN(limitParam) ? 20 : Math.min(Math.max(limitParam, 1), 50);
  const rows = await resolveGovernanceDb(c.env)
    .prepare(
      `SELECT id, post_id, actor_handle, actor_node_url, content, created_at
         FROM post_replies
        WHERE post_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(postId, limit)
    .all<ReplyRow>();
  return c.json({ ok: true, data: { items: rows.results ?? [] } });
});
