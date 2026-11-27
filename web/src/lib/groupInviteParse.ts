/**
 * M16-JOIN-POLICY / INVITE-SHORT：解析与格式化群分享 / 邀请。
 *
 * 分享主形态（JOIN-POLICY）：
 *   https://<owner-worker-b>/#g/<group_id>
 * 兼容临时邀请：
 *   https://<owner-worker-b>/#c/<8位短码>
 * 以及旧 JSON、#i/<base64>、?g=&t=。
 */

export interface ParsedGroupInvite {
  /** 短码分享时可能为空；入群成功后以服务端返回为准 */
  readonly groupId: string;
  readonly ownerWorkerBUrl: string;
  /** 短码或 ginv_… */
  readonly inviteToken: string;
}

/** 固定群号分享（无临时 invite）。 */
export interface ParsedGroupShare {
  readonly groupId: string;
  readonly ownerWorkerBUrl: string;
}

const HEX32_RE = /^[0-9a-fA-F]{32}$/;
const INVITE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/** 短群号后缀：Crockford 8；亦兼容旧长 UUID hex */
const GROUP_ID_BODY_RE = /^[0-9A-HJKMNP-TV-Z]{8}$|^[0-9a-fA-F]{32}$|^[a-zA-Z0-9_-]{8,128}$/;

function pickInviteFields(
  groupId: unknown,
  ownerWorkerBUrl: unknown,
  inviteToken: unknown,
): ParsedGroupInvite | null {
  if (typeof ownerWorkerBUrl !== 'string' || typeof inviteToken !== 'string') {
    return null;
  }
  const owner = ownerWorkerBUrl.trim().replace(/\/+$/, '');
  const token = inviteToken.trim();
  if (!owner || !token) return null;
  try {
    const u = new URL(owner);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const gidRaw = typeof groupId === 'string' ? groupId.trim() : '';
  if (INVITE_CODE_RE.test(token.toUpperCase())) {
    return {
      groupId: gidRaw ? normalizeGroupId(gidRaw) ?? '' : '',
      ownerWorkerBUrl: owner,
      inviteToken: token.toUpperCase(),
    };
  }

  const gid = gidRaw ? normalizeGroupId(gidRaw) : null;
  const tok = normalizeInviteToken(token);
  if (!gid || !tok) return null;
  return { groupId: gid, ownerWorkerBUrl: owner, inviteToken: tok };
}

function normalizeGroupId(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('grp_')) {
    const body = raw.slice(4);
    if (HEX32_RE.test(body)) return `grp_${body.toLowerCase()}`;
    // 短群号：保留字母表形态（服务端存 Crockford）
    if (GROUP_ID_BODY_RE.test(body) && body.length >= 8) return `grp_${body}`;
    return raw.length >= 12 ? raw : null;
  }
  if (HEX32_RE.test(raw)) return `grp_${raw.toLowerCase()}`;
  return raw.length >= 12 ? raw : null;
}

function normalizeInviteToken(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('ginv_')) {
    const body = raw.slice(5);
    return HEX32_RE.test(body) ? `ginv_${body.toLowerCase()}` : raw.length >= 12 ? raw : null;
  }
  if (HEX32_RE.test(raw)) return `ginv_${raw.toLowerCase()}`;
  return raw.length >= 12 ? raw : null;
}

function ownerBaseFromInviteUrl(url: URL): string {
  const base = new URL(url.origin);
  const path = url.pathname.replace(/\/+$/, '');
  if (path && path !== '/' && !path.startsWith('/i/')) {
    base.pathname = path;
  }
  return base.toString().replace(/\/+$/, '');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!HEX32_RE.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  const padded = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  try {
    const bin = atob(padded + '='.repeat(padLen));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function packInvitePayload(groupId: string, inviteToken: string): string | null {
  const gid = normalizeGroupId(groupId);
  const tok = normalizeInviteToken(inviteToken);
  if (!gid || !tok) return null;
  const gHex = gid.startsWith('grp_') ? gid.slice(4) : gid;
  const tHex = tok.startsWith('ginv_') ? tok.slice(5) : tok;
  const gBytes = hexToBytes(gHex);
  const tBytes = hexToBytes(tHex);
  if (!gBytes || !tBytes) return null;
  const packed = new Uint8Array(32);
  packed.set(gBytes, 0);
  packed.set(tBytes, 16);
  return bytesToBase64Url(packed);
}

export function unpackInvitePayload(packed: string): { groupId: string; inviteToken: string } | null {
  const bytes = base64UrlToBytes(packed);
  if (!bytes || bytes.length !== 32) return null;
  return {
    groupId: `grp_${bytesToHex(bytes.subarray(0, 16))}`,
    inviteToken: `ginv_${bytesToHex(bytes.subarray(16, 32))}`,
  };
}

/** M16-JOIN-POLICY：固定群号分享链 `#g/grp_…` */
export function formatGroupShareLink(input: {
  group_id: string;
  owner_worker_b_url: string;
}): string {
  const owner = input.owner_worker_b_url.trim().replace(/\/+$/, '');
  const gid = normalizeGroupId(input.group_id.trim()) ?? input.group_id.trim();
  const url = new URL(owner);
  url.search = '';
  url.pathname = '/';
  url.hash = `g/${gid}`;
  return url.toString();
}

/**
 * 格式化可分享短链。优先 8 位短码 `#c/`；否则回落 `#i/` 压缩包。
 * （JOIN-POLICY 主路径请用 formatGroupShareLink）
 */
export function formatGroupInvitePayload(input: {
  group_id: string;
  owner_worker_b_url: string;
  invite_token: string;
  invite_code?: string;
}): string {
  const owner = input.owner_worker_b_url.trim().replace(/\/+$/, '');
  const url = new URL(owner);
  url.search = '';
  url.pathname = '/';

  const code = (input.invite_code ?? '').trim().toUpperCase();
  if (INVITE_CODE_RE.test(code)) {
    url.hash = `c/${code}`;
    return url.toString();
  }

  const packed = packInvitePayload(input.group_id, input.invite_token);
  if (packed) {
    url.hash = `i/${packed}`;
    return url.toString();
  }

  url.hash = '';
  url.searchParams.set('g', input.group_id.trim());
  url.searchParams.set('t', input.invite_token.trim());
  return url.toString();
}

export function truncateInviteDisplay(text: string, head = 36, tail = 18): string {
  const s = text.trim();
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function parsePackedFromUrl(url: URL): ParsedGroupInvite | null {
  let packed: string | null = null;
  if (url.hash.startsWith('#i/')) {
    packed = decodeURIComponent(url.hash.slice(3));
  } else {
    const m = /^\/i\/([^/]+)\/?$/.exec(url.pathname);
    if (m?.[1]) packed = decodeURIComponent(m[1]);
  }
  if (!packed) return null;
  const unpacked = unpackInvitePayload(packed);
  if (!unpacked) return null;
  return pickInviteFields(unpacked.groupId, ownerBaseFromInviteUrl(url), unpacked.inviteToken);
}

function parseShortCodeFromUrl(url: URL): ParsedGroupInvite | null {
  let code: string | null = null;
  if (url.hash.startsWith('#c/')) {
    code = decodeURIComponent(url.hash.slice(3)).trim().toUpperCase();
  }
  if (!code || !INVITE_CODE_RE.test(code)) return null;
  return pickInviteFields('', ownerBaseFromInviteUrl(url), code);
}

function parseGroupShareFromUrl(url: URL): ParsedGroupShare | null {
  let raw: string | null = null;
  if (url.hash.startsWith('#g/')) {
    raw = decodeURIComponent(url.hash.slice(3)).trim();
  }
  if (!raw) return null;
  const groupId = normalizeGroupId(raw);
  if (!groupId) return null;
  const owner = ownerBaseFromInviteUrl(url);
  try {
    const u = new URL(owner);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { groupId, ownerWorkerBUrl: owner };
}

/** 解析固定群号分享（`#g/`）；失败返回 null。 */
export function parseGroupShareInput(raw: string): ParsedGroupShare | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return parseGroupShareFromUrl(url);
  } catch {
    return null;
  }
}

export function parseGroupInviteInput(raw: string): ParsedGroupInvite | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 纯 8 位短码（无 URL）无法定位群主节点
  if (INVITE_CODE_RE.test(trimmed.toUpperCase()) && !trimmed.includes('://')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const fromJson = pickInviteFields(
      parsed.group_id,
      parsed.owner_worker_b_url,
      typeof parsed.invite_code === 'string' && parsed.invite_code.trim()
        ? parsed.invite_code
        : parsed.invite_token,
    );
    if (fromJson) return fromJson;
  } catch {
    // 非 JSON
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // #g/ 不是邀请；留给 parseGroupShareInput
    if (url.hash.startsWith('#g/')) return null;

    const fromCode = parseShortCodeFromUrl(url);
    if (fromCode) return fromCode;

    const fromPacked = parsePackedFromUrl(url);
    if (fromPacked) return fromPacked;

    const groupId =
      url.searchParams.get('g') ??
      url.searchParams.get('gid') ??
      url.searchParams.get('group_id');
    const inviteToken =
      url.searchParams.get('t') ??
      url.searchParams.get('token') ??
      url.searchParams.get('invite_token') ??
      url.searchParams.get('c') ??
      url.searchParams.get('code');
    const ownerExplicit =
      url.searchParams.get('owner') ?? url.searchParams.get('owner_worker_b_url');
    const owner = ownerExplicit?.trim() || ownerBaseFromInviteUrl(url);
    return pickInviteFields(groupId, owner, inviteToken);
  } catch {
    return null;
  }
}
