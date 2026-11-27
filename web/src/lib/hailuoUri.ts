/**
 * M17-2 / M17-FIX-4 / QR-compact：海螺加好友 URI（客户端解析，不入 D1 / IDB / sessionStorage）
 *
 * 规范唯一形态：hailuo://add-friend?v=1&...
 * 生成（紧凑）：v=1&h=...&n=...（pubkey / display_name 默认省略）
 * 解析：兼容长键 handle/node/pubkey 与短键 h/n/p；pubkey 可选（无则由对端 Worker B 查档）
 * 其他形态（hailuo:add-friend / path=//add-friend 等）一律拒绝。
 */

export const HAILUO_ADD_FRIEND_SCHEME = 'hailuo://add-friend';
export const HAILUO_ADD_FRIEND_VERSION = '1';
/** 仅接受 `hailuo://add-friend?...` 唯一前缀（M17-FIX-4 / P1-4）。 */
const HAILUO_ADD_FRIEND_REGEX = /^hailuo:\/\/add-friend\?(.+)$/i;
/**
 * 与登记 handle 对齐：允许连字符（如 hailuo-7ax89bns）。
 * 放宽到 1–32 字母数字下划线连字符，避免扫码侧过严拒收已登记 handle。
 */
const HANDLE_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const PUBKEY_HEX_RE = /^[0-9a-fA-F]{64}$/;
const DISPLAY_NAME_MAX = 64;

export type HailuoAddFriendUriError =
  | 'uri_invalid'
  | 'missing_fields'
  | 'invalid_handle'
  | 'invalid_node'
  | 'invalid_pubkey'
  | 'display_name_too_long';

export interface HailuoAddFriendPayload {
  readonly handle: string;
  readonly node: string;
  /** 可选：省略时扫码方按 handle 向 node 拉公开档案。 */
  readonly pubkey?: string;
  readonly display_name?: string;
}

export type ParseAddFriendUriResult =
  | { readonly ok: true; readonly data: HailuoAddFriendPayload }
  | { readonly ok: false; readonly error: HailuoAddFriendUriError };

function isHttpsWorkerBUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    if (!u.hostname) return false;
    // 二维码紧凑编码要求：query 中不出现未编码的 & / # / ?
    if (/[&#?]/.test(raw)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 紧凑 query：https URL 的 : / 不必百分号编码（省字符、QR 更疏）。
 * handle / display_name / pubkey 仍 encodeURIComponent。
 */
function buildCompactQuery(parts: ReadonlyArray<readonly [string, string]>): string {
  return parts
    .map(([k, v]) => {
      if (k === 'n' || k === 'node') {
        return `${k}=${v}`;
      }
      return `${k}=${encodeURIComponent(v)}`;
    })
    .join('&');
}

/** 构造可分享 / 可扫码的加好友 URI（默认紧凑：短键、省略 pubkey）。 */
export function buildAddFriendUri(
  input: HailuoAddFriendPayload,
  options?: { readonly includePubkey?: boolean },
): string {
  const handle = input.handle.trim();
  const node = input.node.trim().replace(/\/+$/, '');
  const parts: Array<readonly [string, string]> = [
    ['v', HAILUO_ADD_FRIEND_VERSION],
    ['h', handle],
    ['n', node],
  ];
  const pubkey = input.pubkey?.trim().toLowerCase() ?? '';
  if (options?.includePubkey && pubkey) {
    parts.push(['p', pubkey]);
  }
  if (input.display_name?.trim()) {
    parts.push(['display_name', input.display_name.trim().slice(0, DISPLAY_NAME_MAX)]);
  }
  return `${HAILUO_ADD_FRIEND_SCHEME}?${buildCompactQuery(parts)}`;
}

function paramGet(params: URLSearchParams, longKey: string, shortKey: string): string {
  return (params.get(shortKey) ?? params.get(longKey) ?? '').trim();
}

/** 解析加好友 URI；失败返回稳定 error 码供 i18n。仅接受规范唯一形态。 */
export function parseAddFriendUri(raw: string): ParseAddFriendUriResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'uri_invalid' };

  const m = HAILUO_ADD_FRIEND_REGEX.exec(text);
  if (!m) return { ok: false, error: 'uri_invalid' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(m[1] ?? '');
  } catch {
    return { ok: false, error: 'uri_invalid' };
  }

  const v = params.get('v')?.trim() ?? '';
  const handle = paramGet(params, 'handle', 'h');
  const node = paramGet(params, 'node', 'n');
  const pubkey = paramGet(params, 'pubkey', 'p');
  const displayNameRaw = params.get('display_name');

  if (v !== HAILUO_ADD_FRIEND_VERSION) return { ok: false, error: 'uri_invalid' };
  if (!handle || !node) return { ok: false, error: 'missing_fields' };
  if (!HANDLE_RE.test(handle)) return { ok: false, error: 'invalid_handle' };
  if (!isHttpsWorkerBUrl(node)) return { ok: false, error: 'invalid_node' };
  if (pubkey && !PUBKEY_HEX_RE.test(pubkey)) return { ok: false, error: 'invalid_pubkey' };
  if (displayNameRaw != null && [...displayNameRaw].length > DISPLAY_NAME_MAX) {
    return { ok: false, error: 'display_name_too_long' };
  }

  return {
    ok: true,
    data: {
      handle,
      node,
      ...(pubkey ? { pubkey: pubkey.toLowerCase() } : {}),
      ...(displayNameRaw?.trim() ? { display_name: displayNameRaw.trim() } : {}),
    },
  };
}

/** 批量导入：每行 handle@https://node…；返回解析项与错误行号。 */
export const FRIEND_IMPORT_MAX = 50;

export interface ParsedFriendImportLine {
  readonly handle: string;
  readonly node_url: string;
  readonly line: number;
}

export function parseFriendImportBatch(text: string): {
  readonly items: readonly ParsedFriendImportLine[];
  readonly errors: readonly { readonly line: number; readonly reason: string }[];
  readonly truncated: boolean;
} {
  const lines = text.split(/\r?\n/);
  const items: ParsedFriendImportLine[] = [];
  const errors: { line: number; reason: string }[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith('#')) continue;
    if (items.length >= FRIEND_IMPORT_MAX) {
      truncated = true;
      break;
    }
    const at = raw.lastIndexOf('@');
    if (at <= 0) {
      errors.push({ line: i + 1, reason: 'format' });
      continue;
    }
    const handle = raw.slice(0, at).trim();
    const node_url = raw.slice(at + 1).trim();
    if (!HANDLE_RE.test(handle)) {
      errors.push({ line: i + 1, reason: 'handle' });
      continue;
    }
    if (!isHttpsWorkerBUrl(node_url)) {
      errors.push({ line: i + 1, reason: 'node' });
      continue;
    }
    items.push({ handle, node_url, line: i + 1 });
  }
  return { items, errors, truncated };
}
