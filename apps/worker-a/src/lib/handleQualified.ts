/**
 * HANDLE-QUAL-V1：正式名拼写 / 规范化（对齐注册中心 docs/handle-qualified-format-v1.md）。
 *
 * - 正式名 = `<local>:<registry_id>`；裸名**只**属于 HC 认证成功（handle_scope=global）
 * - 节点侧只消费注册中心下发的 handle_qualified；本文件负责解析、兼容与兜底拼装
 * - 历史 `alice@reg1` 读路径统一成 `alice:reg1`（**不再**剥成裸名）
 */

import { isPrimaryRegistryId, PRIMARY_REGISTRY_ID } from './primaryRegistryTrustAnchor';
import { HANDLE_LOCAL_RE, HANDLE_LOCAL_RE_LEGACY } from '@hailuo/shared-utils';

export { HANDLE_LOCAL_RE, HANDLE_LOCAL_RE_LEGACY };

/** 正式名分隔符（与注册中心同源）。 */
export const HANDLE_QUALIFIER_SEPARATOR = ':';

/**
 * registry_id：字母数字开头，可含 _ -，3–64。
 * **M9-PH-4c**：须先 `toLowerCase()` 再测（本仓字面量仅小写类；registry 源码允许 A–Z，
 * 但 parse 路径一律小写后再测，跨仓行为等价）。
 */
export const REGISTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export type ParsedHandleInput =
  | { kind: 'local'; handle_local: string }
  | { kind: 'qualified'; handle_local: string; registry_id: string };

/** 拼「带区域」正式名：`<local>:<registry_id>`（不含裸名判断）。 */
export function formatQualifiedHandle(handleLocal: string, registryId: string): string {
  const local = handleLocal.trim().toLowerCase();
  const rid = registryId.trim().toLowerCase();
  if (!local || !rid) return local;
  return `${local}${HANDLE_QUALIFIER_SEPARATOR}${rid}`;
}

/**
 * HANDLE-QUAL-V1：按登记终态拼正式名——只有 `global` 才裸名，其余带 `:regN`。
 * 节点一般直接用注册中心下发的值；此函数只用于兜底与契约对齐。
 */
export function formatRegisteredHandle(
  handleLocal: string,
  registryId: string,
  handleScope: 'global' | 'local_only' | null | undefined,
): string {
  if (handleScope === 'global') return handleLocal.trim().toLowerCase();
  return formatQualifiedHandle(handleLocal, registryId);
}

/**
 * 解析裸名、`local:registry_id`（正式）或 `local@registry_id`（历史兼容）。
 * 空段 / 段内再出现分隔符 / 非法字符 → null。
 */
export function parseHandleInput(raw: string): ParsedHandleInput | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(HANDLE_QUALIFIER_SEPARATOR);
  const legacyAt = trimmed.indexOf('@');
  const sep = colon >= 0 ? colon : legacyAt;
  if (sep < 0) {
    if (!HANDLE_LOCAL_RE_LEGACY.test(trimmed)) return null;
    return { kind: 'local', handle_local: trimmed };
  }
  const handle_local = trimmed.slice(0, sep);
  const registry_id = trimmed.slice(sep + 1);
  if (!handle_local || !registry_id) return null;
  if (registry_id.includes('@') || registry_id.includes(HANDLE_QUALIFIER_SEPARATOR)) return null;
  if (handle_local.includes('@') || handle_local.includes(HANDLE_QUALIFIER_SEPARATOR)) return null;
  if (!HANDLE_LOCAL_RE_LEGACY.test(handle_local) || !REGISTRY_ID_RE.test(registry_id)) return null;
  return { kind: 'qualified', handle_local, registry_id };
}

/** 历史 `alice@reg1` → `alice:reg1`；带区域名统一 `:`；裸名原样。 */
export function canonicalizeHandleQualified(stored: string): string {
  const trimmed = stored.trim().toLowerCase();
  if (!trimmed) return trimmed;
  const parsed = parseHandleInput(trimmed);
  if (!parsed) return trimmed;
  if (parsed.kind === 'local') return parsed.handle_local;
  return formatQualifiedHandle(parsed.handle_local, parsed.registry_id);
}

/**
 * L0 / 缓存命中用：裸名、`local:regN` 与历史 `local@regN` 的等价键。
 */
export function handleQualifiedLookupKeys(raw: string): string[] {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return [];
  const canon = canonicalizeHandleQualified(trimmed);
  const keys = new Set<string>([canon, trimmed]);
  const parsed = parseHandleInput(trimmed);
  if (parsed?.kind === 'qualified') {
    keys.add(`${parsed.handle_local}@${parsed.registry_id}`);
    keys.add(formatQualifiedHandle(parsed.handle_local, parsed.registry_id));
  } else if (parsed?.kind === 'local') {
    // 裸名：既可能命中 HC 认证的全局裸名，也可能命中历史 reg1 存量行
    keys.add(formatQualifiedHandle(parsed.handle_local, PRIMARY_REGISTRY_ID));
    keys.add(`${parsed.handle_local}@${PRIMARY_REGISTRY_ID}`);
  }
  return [...keys];
}

export { PRIMARY_REGISTRY_ID, isPrimaryRegistryId };
