/**
 * lookup 路由：正式名为主中心裸名或 handle@registry_id；不做 DID / 指纹搜索。
 *
 * GET /api/lookup/:handle → 校验后委托 `resolveNodeByHandle`（L1→L4）。
 * JWT：index.ts 对 /api/lookup/* 挂 requireOwnerJWT。
 */

import { Hono } from 'hono';
import { normalizeHandleLocalSegment, normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveNodeByHandle } from '../lib/nodeResolve';
import { parseHandleInput, canonicalizeHandleQualified } from '../lib/handleQualified';
import { fetchOutboundPeer, resolveSafeOutboundPeerUrl } from '../lib/fetchOutboundPeer';
import { buildPeerUserProfileUrl, parseDmPeerPubkeyProfile } from '../lib/dmPeerPubkey';

export const lookupApp = new Hono<{ Bindings: Env }>();


function looksLikeDid(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t.startsWith('did:') || t.startsWith('did%3a');
}

/** 搜人入口：主中心裸名或 local@registry_id（M9-PH-1）。 */
function parseQualifiedSearchHandle(raw: string): { ok: true; handle: string } | { ok: false; code: string; message: string } {
  const decoded = (() => {
    try {
      return decodeURIComponent(raw).trim().toLowerCase();
    } catch {
      return raw.trim().toLowerCase();
    }
  })();

  if (!decoded) {
    return {
      ok: false,
      code: 'LOOKUP_HANDLE_REQUIRED',
      message: '请输入正式名（主中心裸名或 handle@注册中心ID）',
    };
  }
  if (looksLikeDid(decoded)) {
    return {
      ok: false,
      code: 'LOOKUP_DID_DISABLED',
      message: '不支持 DID 搜索；请使用正式名（主中心裸名或 handle@注册中心ID）',
    };
  }

  const parsed = parseHandleInput(decoded);
  if (!parsed) {
    return {
      ok: false,
      code: 'LOOKUP_HANDLE_INVALID',
      message: '正式名格式非法（主中心裸名或 handle@注册中心ID）',
    };
  }
  if (parsed.kind === 'local') {
    // 主中心正式名可为裸名；非主中心由注册中心拒绝
    return { ok: true, handle: parsed.handle_local };
  }
  return {
    ok: true,
    handle: canonicalizeHandleQualified(`${parsed.handle_local}@${parsed.registry_id}`),
  };
}

lookupApp.get('/:handle', async (c) => {
  const parsed = parseQualifiedSearchHandle(c.req.param('handle'));
  if (!parsed.ok) {
    return c.json({ ok: false, error_code: parsed.code, message: parsed.message }, 400);
  }

  const result = await resolveNodeByHandle(c.env, parsed.handle, {
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  if (!result.ok) {
    return c.json(
      { ok: false, error_code: result.error_code, message: result.message },
      result.status,
    );
  }

  return c.json({ ok: true, data: result.data });
});

/** DM-PEER-PUBKEY-1：服务端解析对端 dm_pubkey（浏览器不再直连对端 workers.dev）。 */
const DM_PEER_PUBKEY_TIMEOUT_MS = 10_000;

lookupApp.get('/:handle/dm-pubkey', async (c) => {
  // JWT 保护 + 只返回 dm_pubkey / worker_b_url；禁止任何共享缓存。
  c.header('Cache-Control', 'private, no-store');

  const parsed = parseQualifiedSearchHandle(c.req.param('handle'));
  if (!parsed.ok) {
    return c.json({ ok: false, error_code: parsed.code, message: parsed.message }, 400);
  }
  const localHandle = normalizeHandleLocalSegment(parsed.handle);
  if (!localHandle) {
    return c.json(
      { ok: false, error_code: 'LOOKUP_HANDLE_INVALID', message: '正式名格式非法' },
      400,
    );
  }

  // 客户端通常已从 follows / mutual 拿到对端 Worker B，直接传 node_url 省一次 lookup；
  // 没传时回落到注册中心 lookup，仍要过 SSRF 门禁。
  let nodeUrl = (c.req.query('node_url') ?? '').trim();
  if (nodeUrl) {
    const safe = resolveSafeOutboundPeerUrl(c.env, nodeUrl);
    if (!safe) {
      return c.json(
        { ok: false, error_code: 'DM_PEER_NOT_FOUND', message: '对方节点地址无效' },
        400,
      );
    }
    // URL.toString() 会补尾斜杠；先归一，避免 //users 双斜杠 404。
    nodeUrl = normalizeWorkerBOrigin(safe);
  } else {
    const resolved = await resolveNodeByHandle(c.env, parsed.handle, {
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });
    const rawUrl = resolved.ok ? (resolved.data.worker_b_url ?? '').trim() : '';
    const safe = rawUrl ? resolveSafeOutboundPeerUrl(c.env, rawUrl) : null;
    if (!safe) {
      return c.json(
        { ok: false, error_code: 'DM_PEER_NOT_FOUND', message: '找不到对方节点' },
        404,
      );
    }
    nodeUrl = normalizeWorkerBOrigin(safe);
  }

  const fetched = await fetchOutboundPeer(
    c.env,
    buildPeerUserProfileUrl(nodeUrl, localHandle),
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: DM_PEER_PUBKEY_TIMEOUT_MS,
    },
  );
  if (!fetched.ok) {
    return c.json(
      {
        ok: false,
        error_code: 'DM_PEER_UNREACHABLE',
        message: '暂时无法连接对方节点，读不到私信公钥',
      },
      503,
    );
  }
  if (fetched.response.status === 404) {
    return c.json(
      {
        ok: false,
        error_code: 'DM_PEER_PROFILE_NOT_FOUND',
        message: '对方节点上找不到该用户',
      },
      404,
    );
  }
  if (!fetched.response.ok) {
    return c.json(
      {
        ok: false,
        error_code: 'DM_PEER_PROFILE_UNAVAILABLE',
        message: '对方节点暂时无法提供公开资料',
      },
      502,
    );
  }

  const rawProfile = await fetched.response.json().catch(() => null);
  const profile = parseDmPeerPubkeyProfile(rawProfile, nodeUrl);
  if (!profile.ok) {
    if (profile.reason === 'no_pubkey') {
      return c.json(
        {
          ok: false,
          error_code: 'DM_PEER_NO_PUBKEY',
          message: '对方尚未开启私信（未配置 dm_pubkey）',
        },
        404,
      );
    }
    return c.json(
      {
        ok: false,
        error_code: 'DM_PEER_PROFILE_UNAVAILABLE',
        message: '对方节点暂时无法提供公开资料',
      },
      502,
    );
  }

  return c.json({
    ok: true,
    data: {
      dm_pubkey: profile.dm_pubkey,
      worker_b_url: profile.worker_b_url,
    },
  });
});
