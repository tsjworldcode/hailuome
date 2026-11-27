/**
 * M-OPT-8b/8c：内部 lookup 协助应答（仅 Service Binding + HMAC）。
 * Worker B `GET /lookup-assist/:handle[?fof=1]` 转发至此。
 */
import { Hono } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import type { Env, AppVariables } from '../env';
import {
  answerLookupAssistWithOptionalFof,
  isLookupL2MutualAssistEnabled,
  isLookupL3FofEnabled,
  tryConsumeAssistQuota,
  type AssistAskMode,
} from '../lib/lookupAssist';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const internalLookupAssistApp = new Hono<AppEnv>();

async function verifyInternalGet(
  c: {
    env: Env;
    req: { header: (name: string) => string | undefined };
  },
  path: string,
): Promise<boolean> {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  if (!configured) return false;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (marker !== 'hmac-v2' || !timestamp || !nonce || !signature) return false;
  return verifyRequest(
    { method: 'GET', path },
    '',
    { timestamp, nonce, signature },
    configured,
  );
}

function resolveAssistMode(c: {
  req: { query: (k: string) => string | undefined; header: (n: string) => string | undefined };
}): AssistAskMode {
  const q = (c.req.query('fof') ?? '').trim();
  const h = (c.req.header('X-Hailuo-Assist-Mode') ?? '').trim().toLowerCase();
  if (q === '1' || q.toLowerCase() === 'true' || h === 'fof') return 'fof';
  return 'l1';
}

// GET /internal/lookup-assist/:handle
internalLookupAssistApp.get('/lookup-assist/:handle', async (c) => {
  const handle = c.req.param('handle');
  const path = new URL(c.req.url).pathname;
  if (!(await verifyInternalGet(c, path))) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }

  if (!isLookupL2MutualAssistEnabled(c.env)) {
    return c.json(
      { ok: false, error_code: 'LOOKUP_ASSIST_DISABLED', message: '本节点未开启查找协助' },
      404,
    );
  }

  const mode = resolveAssistMode(c);
  if (mode === 'fof' && !isLookupL3FofEnabled(c.env)) {
    return c.json(
      { ok: false, error_code: 'LOOKUP_ASSIST_FOF_DISABLED', message: '本节点未开启 FoF 协助' },
      404,
    );
  }

  const inScope = mode === 'fof' ? 'l3_fof_in_day' : 'l2_assist_in_day';
  const allowed = await tryConsumeAssistQuota(c.env, inScope);
  if (!allowed) {
    return c.json(
      {
        ok: false,
        error_code: 'LOOKUP_ASSIST_RATE_LIMITED',
        message: '本节点今日查找协助次数已达上限',
      },
      429,
    );
  }

  const answered = await answerLookupAssistWithOptionalFof(c.env, handle, mode);
  if (!answered) {
    return c.json(
      { ok: false, error_code: 'LOOKUP_ASSIST_NOT_FOUND', message: '本节点不认识该 handle' },
      404,
    );
  }

  const { data, via } = answered;
  return c.json({
    ok: true,
    data: {
      user_id: data.user_id,
      handle: data.handle,
      node_url: data.node_url,
      worker_b_url: data.worker_b_url ?? data.node_url,
      registry_status: data.registry_status,
      health_status: data.health_status,
      pubkey_fingerprint: data.pubkey_fingerprint,
      resolve_source: via === 'l2' ? 'l2_via_fof' : 'l1_local',
    },
  });
});
