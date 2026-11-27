/**
 * NCF-HS-1：注册中心鉴权用本地 handle 解析与规范化。
 *
 * 与中心 §5.1 / Header 路径对齐：trim + 小写 + 去前导 @ / 截断 @regN。
 * ❌ 禁止复用加好友的 normalizeHandleLocalSegment（会 _→-，导致 FNV 错片）。
 */

import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { RegistryFatalError } from './registryErrors';

/**
 * 鉴权 Header / 算片键用的本地段规范化（纯函数）。
 * 空串 → null；保留下划线。
 */
export function normalizeAuthHandleLocal(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  // 中文注释：去掉前导 @（容错）；若仍含 @regN 则只取本地段
  while (s.startsWith('@')) {
    s = s.slice(1).trim();
  }
  const at = s.indexOf('@');
  if (at >= 0) {
    s = s.slice(0, at).trim();
  }
  return s || null;
}

/**
 * 解析本节点对外登记用的本地 handle，供 X-Hailuo-Node-Handle 使用。
 * 优先 users.handle；回退 system_config.handle_qualified 的本地段。
 * 未登记 / 空 → RegistryFatalError（与缺 token 同级 fail-loud）。
 */
export async function resolveAuthHandleForRegistry(env: Env): Promise<string> {
  const identityDb = resolveIdentityDb(env);

  // 中文注释：与 readLocalNodeHandle 同列（users.handle），不经 handlers 以免 lib→handler 反向依赖
  const userRow = await identityDb
    .prepare(`SELECT handle FROM users LIMIT 1`)
    .first<{ handle: string | null }>();
  const fromUsers = normalizeAuthHandleLocal(userRow?.handle ?? '');
  if (fromUsers) return fromUsers;

  const cfg = await identityDb
    .prepare(`SELECT value FROM system_config WHERE key = 'handle_qualified' LIMIT 1`)
    .first<{ value: string | null }>();
  const fromQualified = normalizeAuthHandleLocal(cfg?.value ?? '');
  if (fromQualified) return fromQualified;

  throw new RegistryFatalError(
    'NODE_HANDLE_UNAVAILABLE',
    '本节点尚未登记 handle，无法调用注册中心鉴权接口',
  );
}
