/**
 * M7-31a：email-certify registry 代理与本地 KV 蓝标同步。
 */
import type { Env } from '../env';
import { setPublicProfileEmailVerified, setPublicProfileEmailVerifiedCas } from './publicProfileKv';

export interface EmailCertifyBody {
  email: string;
  email_verify_token: string;
  /** M7-39：handle 改必带——handle 全域唯一，与 user_id 同级，必须显式随请求上送。 */
  handle: string;
}

/** registry email-certify 成功后写本地公开资料蓝标。 */
export async function syncLocalEmailVerifiedAfterCertify(env: Env): Promise<'updated' | 'skipped' | 'missing'> {
  return setPublicProfileEmailVerifiedCas(env, true);
}

/** M33-v2-5 / v2-7b：从 certification-context 同步蓝标（通道 A 入站成功后无回调）。 */
export async function syncLocalEmailVerifiedFromCertificationContext(
  env: Env,
  ctx: { email_verified?: boolean; email_status?: string },
): Promise<boolean> {
  const verified = ctx.email_verified === true || ctx.email_status === 'verified';
  if (!verified) return false;
  const outcome = await setPublicProfileEmailVerifiedCas(env, true);
  return outcome === 'updated' || outcome === 'skipped';
}

/** PATCH 登记资料变更 email 后清除本地蓝标（registry 侧已降认证态）。 */
export async function syncLocalEmailVerifiedAfterEmailPatch(
  env: Env,
  patch: { email?: unknown },
): Promise<void> {
  if (!('email' in patch)) return;
  await setPublicProfileEmailVerified(env, false);
}
