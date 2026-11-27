/**
 * M9-PH-3：搜人 / 联邦试解析入参校验（主中心可裸名）。
 */

import { canonicalizeHandleQualified, PRIMARY_REGISTRY_ID } from './handleDisplay';
import { HANDLE_LOCAL_RE_LEGACY } from '@hailuo/shared-utils';

/** 搜人 / lookup 用存量兼容规则（可短于 5、可数字开头）。 */
export const HANDLE_LOCAL_RE = HANDLE_LOCAL_RE_LEGACY;

/** registry_id：字母数字开头，可含 _ -，3–64；须先 toLowerCase 再测（M9-PH-4c）。 */
export const REGISTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/** 仅规范化大小写与下划线；保留中间的 @。 */
export function normalizeSearchHandleInput(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-').replace(/^@+/, '');
}

export type SearchHandleOk = {
  ok: true;
  /** 已 canonicalize（alice@reg1 → alice）的查找键 */
  handle: string;
  kind: 'local' | 'qualified';
};

export type SearchHandleErr = {
  ok: false;
  reason: 'empty' | 'did' | 'invalid';
};

/**
 * 解析搜人入参：裸名（主中心语义）或 local@registry_id。
 * 非法 / DID → ok:false。
 */
export function parseSearchHandle(raw: string): SearchHandleOk | SearchHandleErr {
  const handle = normalizeSearchHandleInput(raw);
  if (!handle) return { ok: false, reason: 'empty' };
  if (handle.startsWith('did:')) return { ok: false, reason: 'did' };

  const at = handle.indexOf('@');
  if (at < 0) {
    if (!HANDLE_LOCAL_RE.test(handle)) return { ok: false, reason: 'invalid' };
    return { ok: true, handle, kind: 'local' };
  }

  const local = handle.slice(0, at);
  const registryId = handle.slice(at + 1);
  if (!local || !registryId || registryId.includes('@')) return { ok: false, reason: 'invalid' };
  if (!HANDLE_LOCAL_RE.test(local) || !REGISTRY_ID_RE.test(registryId)) {
    return { ok: false, reason: 'invalid' };
  }

  const canon = canonicalizeHandleQualified(`${local}@${registryId}`);
  return {
    ok: true,
    handle: canon,
    kind: canon.includes('@') ? 'qualified' : 'local',
  };
}

/** 是否官方注册中心账号（裸名或 @任意中心）。 */
export function isOfficialRegistrySearchHandle(
  handle: string,
  officialLocal: string,
): boolean {
  const h = normalizeSearchHandleInput(handle);
  if (h === officialLocal) return true;
  const at = h.indexOf('@');
  if (at < 0) return false;
  return h.slice(0, at) === officialLocal;
}

export { PRIMARY_REGISTRY_ID };
