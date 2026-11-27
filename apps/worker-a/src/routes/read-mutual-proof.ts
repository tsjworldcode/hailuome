/**
 * M14-3：互粉读帖证明签发（JWT + Owner Gateway）。
 */
import { resolveIdentityDb } from '../db/bindings';
import { Hono } from 'hono';
import type { ReadMutualProof } from '@hailuo/shared-types';
import { randomDmNonceHex, signReadMutualProof } from '@hailuo/shared-crypto';
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import type { Env, AppVariables } from '../env';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';

type AppEnv = { Bindings: Env; Variables: AppVariables };

const READ_PROOF_TTL_SEC = 300;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function getLocalUser(env: Env) {
  return resolveIdentityDb(env)
    .prepare(`SELECT handle, pubkey, worker_b_url FROM users LIMIT 1`)
    .first<{ handle: string; pubkey: string; worker_b_url: string }>();
}

async function isFollowingOwner(env: Env, ownerWorkerBUrl: string): Promise<boolean> {
  const normalized = normalizeWorkerBOrigin(ownerWorkerBUrl);
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT 1 AS found FROM follows WHERE follower_node_url = ? LIMIT 1`)
    .bind(normalized)
    .first<{ found: number }>();
  return row !== null;
}

export const readMutualProofApp = new Hono<AppEnv>();

/** POST /api/read/mutual-proof */
readMutualProofApp.post('/mutual-proof', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体必须为 JSON' }, 400);
  }

  const ownerWorkerBUrlRaw =
    typeof body.owner_worker_b_url === 'string' ? body.owner_worker_b_url.trim() : '';
  if (!ownerWorkerBUrlRaw.startsWith('https://')) {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: 'owner_worker_b_url 必须为 https://' },
      400,
    );
  }
  const ownerWorkerBUrl = normalizeWorkerBOrigin(ownerWorkerBUrlRaw);

  const localUser = await getLocalUser(c.env);
  if (!localUser) {
    return c.json({ ok: false, error_code: 'USER_NOT_REGISTERED', message: '节点尚未完成注册' }, 409);
  }

  const readerWorkerBUrl = normalizeWorkerBOrigin(await resolveLocalPublicBaseUrl(c.env));
  if (!readerWorkerBUrl.startsWith('https://')) {
    return c.json(
      { ok: false, error_code: 'USER_NOT_REGISTERED', message: '本节点 Worker B 地址未配置' },
      409,
    );
  }
  if (readerWorkerBUrl === ownerWorkerBUrl) {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '不能向自己申请互粉读帖证明' }, 400);
  }

  if (!(await isFollowingOwner(c.env, ownerWorkerBUrl))) {
    return c.json(
      { ok: false, error_code: 'NOT_MUTUAL_FOLLOW', message: '未关注对方节点，无法生成互粉读帖证明' },
      403,
    );
  }

  const unsigned = {
    reader_worker_b_url: readerWorkerBUrl,
    owner_worker_b_url: ownerWorkerBUrl,
    purpose: 'read-token' as const,
    exp: nowSec() + READ_PROOF_TTL_SEC,
    nonce: randomDmNonceHex(16),
  };
  const sig = await signReadMutualProof(unsigned, c.env.ED25519_PRIVATE_KEY);
  const proof: ReadMutualProof = { ...unsigned, sig };

  return c.json({ ok: true, data: { proof } });
});

/** 供 Cron 等内部模块复用同一证明逻辑（不经 HTTP）。 */
export async function buildReadMutualProofForOwner(
  env: Env,
  ownerWorkerBUrl: string,
): Promise<ReadMutualProof | null> {
  const normalizedOwner = normalizeWorkerBOrigin(ownerWorkerBUrl);
  if (!(await isFollowingOwner(env, normalizedOwner))) return null;
  const localUser = await getLocalUser(env);
  if (!localUser) return null;
  const readerWorkerBUrl = normalizeWorkerBOrigin(await resolveLocalPublicBaseUrl(env));
  if (!readerWorkerBUrl.startsWith('https://') || readerWorkerBUrl === normalizedOwner) return null;
  const unsigned = {
    reader_worker_b_url: readerWorkerBUrl,
    owner_worker_b_url: normalizedOwner,
    purpose: 'read-token' as const,
    exp: nowSec() + READ_PROOF_TTL_SEC,
    nonce: randomDmNonceHex(16),
  };
  const sig = await signReadMutualProof(unsigned, env.ED25519_PRIVATE_KEY);
  return { ...unsigned, sig };
}