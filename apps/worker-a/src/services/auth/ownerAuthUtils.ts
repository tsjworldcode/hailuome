/**
 * Auth 域共享纯函数（路由与深模块共用）。
 */
import type { OwnerJwtPayload } from '@hailuo/shared-types';

/** JWT 内站主登录名（oun）优先，否则回落 BOOTSTRAP_HANDLE / sub。 */
export function resolveCredentialUsername(
  payload: Pick<OwnerJwtPayload, 'sub' | 'oun'>,
  bootstrapHandle: string,
): string {
  if (payload.oun && payload.oun.length > 0) return payload.oun;
  return bootstrapHandle || payload.sub;
}

export function validateOwnerUsername(
  username: string,
): { ok: true } | { ok: false; reason: string } {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(username)) {
    return { ok: false, reason: '用户名仅允许 1-64 个字母/数字/_/-' };
  }
  return { ok: true };
}
