/**
 * HANDLE-QUAL-V1：Web 正式名展示（对齐注册中心 docs/handle-qualified-format-v1.md）。
 *
 * - HC 认证成功（裸名）：`alice`
 * - 其余（含主中心）：`alice:reg1`
 * - 存量 `alice@regN` 仅作输入兼容，展示统一成 `alice:regN`
 * - 未登记站主短名：仍用 `@handle` 作视觉区分
 */

/** 与节点 / 注册中心 PRIMARY_REGISTRY_ID 对齐（仅历史 `@reg1` 兼容用） */
export const PRIMARY_REGISTRY_ID = 'reg1';

export type HandleDisplaySource = {
  readonly handle: string;
  readonly handle_qualified?: string | null;
};

function stripLeadingAt(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

/** 是否主中心 registry_id（保留导出，展示已不再依赖它） */
export function isPrimaryRegistryId(registryId: string): boolean {
  return registryId.trim().toLowerCase() === PRIMARY_REGISTRY_ID;
}

/**
 * 规范化展示用正式名：`alice@reg1` → `alice:reg1`；`alice:reg1` 原样。
 * HANDLE-QUAL-V1：不再把主中心后缀剥成裸名——存什么就显示什么。
 */
export function canonicalizeHandleQualified(stored: string): string {
  const trimmed = stripLeadingAt(stored).toLowerCase();
  if (!trimmed) return '';
  const colon = trimmed.indexOf(':');
  const legacyAt = trimmed.indexOf('@');
  const sep = colon >= 0 ? colon : legacyAt;
  if (sep < 0) return trimmed;
  const local = trimmed.slice(0, sep);
  const registryId = trimmed.slice(sep + 1);
  if (!local || !registryId) return trimmed;
  if (registryId.includes(':') || registryId.includes('@')) return trimmed;
  return `${local}:${registryId}`;
}

/**
 * Feed / PostCard / 关注列表：公开正式名文案（无额外前缀 @）。
 */
export function formatPublicHandleDisplay(raw: string | null | undefined): string {
  if (!raw?.trim()) return '';
  return canonicalizeHandleQualified(raw);
}

/**
 * 侧栏 / 个人主页：优先 `handle_qualified`；未登记短名仍用 `@handle`。
 */
export function formatOwnerHandleDisplay(source: HandleDisplaySource): string {
  const qualified = source.handle_qualified?.trim();
  if (qualified) return formatPublicHandleDisplay(qualified);
  const handle = stripLeadingAt(source.handle || '');
  if (!handle) return '';
  // 带区域后缀一律走公开口径（不加前导 @，避免 @alice:reg1 被读成两次提及）
  if (handle.includes(':') || handle.includes('@')) return formatPublicHandleDisplay(handle);
  return `@${handle}`;
}
