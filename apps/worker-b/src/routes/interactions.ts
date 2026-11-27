/**
 * M9-19：Worker B 公开互动入口（跨节点签名 envelope 代理）。
 *
 * 写操作流程：
 *   1. 客户端先调本节点 Worker B `/interactions/sign-envelope` 获取签名 envelope
 *   2. 再调原帖节点 Worker B 写接口，携带 envelope + content（回复时）
 *   3. Worker B 校验粉丝 Token 与 envelope.actor 一致后，HMAC 转发 Worker A
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { InteractionEnvelope } from '@hailuo/shared-types';
import { signRequest } from '@hailuo/shared-crypto';
import {
  PUBLIC_PROFILE_KV_KEY,
  PUBLIC_WORKER_B_URL_KV_KEY,
  type PublicOwnerProfile,
} from '@hailuo/shared-types';
import type { Env } from '../env.d';
import type { FollowerTokenVars } from '../middleware/follower-token';
import {
  assertWorkerABinding,
  forwardJsonToWorkerA,
  readJsonBodyWithLimit,
} from '../lib/publicIngress';
import { passthroughResponse } from './follower-tokens';

type AppEnv = { Bindings: Env; Variables: FollowerTokenVars };
type InteractionContext = Context<AppEnv>;

/** SDH-5：互动写请求 body 上限（含 envelope + 回复 content） */
const MAX_INTERACTION_BODY_BYTES = 32 * 1024;

export const interactionsApp = new Hono<AppEnv>();

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorJson(c: InteractionContext, status: 400 | 403 | 503, code: string, message: string): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

async function forwardInteraction(
  c: InteractionContext,
  upstreamPath: string,
  body: Record<string, unknown>,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<Response> {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) {
    return errorJson(c, 503, 'WORKER_A_BINDING_MISSING', '互动服务暂不可用，请稍后再试');
  }
  return forwardJsonToWorkerA(c.env, { upstreamPath, method, body });
}

async function readInteractionJsonBody(
  c: InteractionContext,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const parsed = await readJsonBodyWithLimit(c.req.raw, MAX_INTERACTION_BODY_BYTES);
  if (!parsed.ok) {
    if (parsed.status === 413) {
      return {
        ok: false,
        response: errorJson(c, 400, 'INTERACTION_BODY_TOO_LARGE', '互动请求体超过大小限制'),
      };
    }
    return { ok: false, response: errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON') };
  }
  return { ok: true, body: parsed.body };
}

async function readLocalWorkerBUrl(c: InteractionContext): Promise<string> {
  // M7-30g-4：优先专用 canonical key，再回落公开资料快照
  try {
    const canonical = await c.env.STATE_KV.get(PUBLIC_WORKER_B_URL_KV_KEY);
    if (typeof canonical === 'string' && canonical.trim()) {
      return stripTrailingSlash(canonical);
    }
  } catch {
    /* ignore */
  }
  const cached = await c.env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json').catch(() => null) as PublicOwnerProfile | null;
  return cached?.worker_b_url ? stripTrailingSlash(cached.worker_b_url) : '';
}

/** 从粉丝 Token 构造互动 actor（handle + node_url）。 */
async function actorFromToken(c: InteractionContext) {
  const token = c.get('followerToken');
  if (!token) return null;

  let handle = typeof token.fan === 'string' ? token.fan.trim() : '';
  if (!handle) {
    const localUrl = await readLocalWorkerBUrl(c);
    const sub = stripTrailingSlash(token.sub);
    const cached = await c.env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json').catch(() => null) as PublicOwnerProfile | null;
    if (localUrl && sub === localUrl && cached?.handle) {
      handle = cached.handle.trim();
    }
  }
  if (!handle) {
    console.warn('[interactions] 粉丝 Token 缺少 fan，无法确定互动者 handle');
    return null;
  }
  return {
    handle,
    node_url: stripTrailingSlash(token.sub),
  };
}

function assertEnvelopeActorMatchesToken(
  c: InteractionContext,
  envelope: InteractionEnvelope,
): Response | null {
  const token = c.get('followerToken');
  if (!token) return errorJson(c, 400, 'ACTOR_INVALID', '互动身份无效');
  const sub = stripTrailingSlash(token.sub);
  if (envelope.actor.node_url !== sub) {
    return errorJson(c, 403, 'ENVELOPE_ACTOR_MISMATCH', 'envelope actor 与粉丝 Token 不一致');
  }
  const fan = typeof token.fan === 'string' ? token.fan.trim() : '';
  if (fan && envelope.actor.handle !== fan) {
    return errorJson(c, 403, 'ENVELOPE_ACTOR_MISMATCH', 'envelope actor 与粉丝 Token 不一致');
  }
  return null;
}

interactionsApp.post('/posts/:postId/like', async (c) => {
  const actor = await actorFromToken(c);
  if (!actor) return errorJson(c, 400, 'ACTOR_INVALID', '互动身份无效');

  const parsedBody = await readInteractionJsonBody(c);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  const envelope = body.envelope as InteractionEnvelope | undefined;
  if (!envelope) {
    return errorJson(c, 400, 'ENVELOPE_REQUIRED', '互动写操作需要签名 envelope');
  }
  const mismatch = assertEnvelopeActorMatchesToken(c, envelope);
  if (mismatch) return mismatch;

  return forwardInteraction(c, `/interactions/posts/${encodeURIComponent(c.req.param('postId'))}/like`, { envelope });
});

interactionsApp.delete('/posts/:postId/like', async (c) => {
  const actor = await actorFromToken(c);
  if (!actor) return errorJson(c, 400, 'ACTOR_INVALID', '互动身份无效');

  const parsedBody = await readInteractionJsonBody(c);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  const envelope = body.envelope as InteractionEnvelope | undefined;
  if (!envelope) {
    return errorJson(c, 400, 'ENVELOPE_REQUIRED', '互动写操作需要签名 envelope');
  }
  const mismatch = assertEnvelopeActorMatchesToken(c, envelope);
  if (mismatch) return mismatch;

  return forwardInteraction(
    c,
    `/interactions/posts/${encodeURIComponent(c.req.param('postId'))}/like`,
    { envelope },
    'DELETE',
  );
});

interactionsApp.post('/posts/:postId/replies', async (c) => {
  const actor = await actorFromToken(c);
  if (!actor) return errorJson(c, 400, 'ACTOR_INVALID', '互动身份无效');

  const parsedBody = await readInteractionJsonBody(c);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  const envelope = body.envelope as InteractionEnvelope | undefined;
  if (!envelope) {
    return errorJson(c, 400, 'ENVELOPE_REQUIRED', '互动写操作需要签名 envelope');
  }
  const mismatch = assertEnvelopeActorMatchesToken(c, envelope);
  if (mismatch) return mismatch;

  return forwardInteraction(c, `/interactions/posts/${encodeURIComponent(c.req.param('postId'))}/replies`, {
    envelope,
    content: body.content,
  });
});

interactionsApp.delete('/posts/:postId/replies/:replyId', async (c) => {
  const actor = await actorFromToken(c);
  if (!actor) return errorJson(c, 400, 'ACTOR_INVALID', '互动身份无效');

  const parsedBody = await readInteractionJsonBody(c);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  const envelope = body.envelope as InteractionEnvelope | undefined;
  if (!envelope) {
    return errorJson(c, 400, 'ENVELOPE_REQUIRED', '互动写操作需要签名 envelope');
  }
  const mismatch = assertEnvelopeActorMatchesToken(c, envelope);
  if (mismatch) return mismatch;

  return forwardInteraction(
    c,
    `/interactions/posts/${encodeURIComponent(c.req.param('postId'))}/replies/${encodeURIComponent(c.req.param('replyId'))}`,
    { envelope },
    'DELETE',
  );
});

interactionsApp.post('/posts/:postId/summary', async (c) => {
  const actor = await actorFromToken(c);
  return forwardInteraction(c, `/interactions/posts/${encodeURIComponent(c.req.param('postId'))}/summary`, {
    actor,
  });
});

interactionsApp.get('/posts/:postId/replies', async (c) => {
  if (!c.env.WORKER_A || !c.env.INTERNAL_FORWARD_SECRET) {
    return errorJson(c, 503, 'WORKER_A_BINDING_MISSING', '互动服务暂不可用，请稍后再试');
  }
  const limit = c.req.query('limit');
  const upstreamPath =
    `/interactions/posts/${encodeURIComponent(c.req.param('postId'))}/replies` +
    (limit ? `?limit=${encodeURIComponent(limit)}` : '');
  const signedHeaders = await signRequest(
    { method: 'GET', path: upstreamPath },
    '',
    c.env.INTERNAL_FORWARD_SECRET,
  );
  const upstream = await c.env.WORKER_A.fetch(
    new Request(`https://worker-a.internal${upstreamPath}`, {
      method: 'GET',
      headers: {
        'X-Internal-Forward': 'hmac-v2',
        ...signedHeaders,
      },
    }),
  );
  return passthroughResponse(upstream);
});
