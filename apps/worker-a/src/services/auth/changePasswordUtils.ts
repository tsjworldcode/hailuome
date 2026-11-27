/**
 * NCF-2B-2：改密辅助纯函数（无 Env）。
 */

/** 站主登录用户名格式（与历史 auth 路由一致） */
export function validateOwnerUsername(
  username: string,
): { ok: true } | { ok: false; reason: string } {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(username)) {
    return { ok: false, reason: '用户名仅允许 1-64 个字母/数字/_/-' };
  }
  return { ok: true };
}
