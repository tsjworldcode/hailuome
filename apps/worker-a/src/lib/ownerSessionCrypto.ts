/**
 * M34-1：站主会话脱敏工具（防身份关联）。
 * 明文 IP / 完整 UA / JWT 原文不得入库或回显。
 */
export type OwnerLoginMethod = 'password' | 'totp' | 'recovery' | 'legacy';

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ip_hash = sha256(JWT_SECRET + '\\0' + ip)；禁止存明文 IP */
export async function hashClientIp(salt: string, ip: string): Promise<string> {
  const trimmed = ip.trim() || 'unknown';
  return sha256Hex(`${salt}\0${trimmed}`);
}

/** JWT 指纹：sha256(token) 前 32 hex，用于登出匹配，不存完整 JWT */
export async function jwtFingerprint(token: string): Promise<string> {
  const full = await sha256Hex(token);
  return full.slice(0, 32);
}

/** 完整 token_hash（64 hex），与 revoked_tokens / requireOwnerJWT 对齐 */
export async function jwtTokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}

/** 粗粒度 UA 族，如 Chrome / Windows；禁止存完整 UA */
export function parseUserAgentFamily(uaRaw: string | undefined | null): string {
  const ua = (uaRaw ?? '').trim();
  if (!ua) return 'unknown';

  let browser = 'Other';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

  let os = 'Other';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return `${browser} / ${os}`;
}

/**
 * M34-4b：客户端 IP 脱敏，仅供站主 Settings 设备名展示。
 * IPv4 → a.b.c.*；IPv6 → 前 4 hextet + :*；非法/空 → null（禁止存假值或完整明文）。
 */
export function maskClientIp(ipRaw: string | undefined | null): string | null {
  const ip = (ipRaw ?? '').trim();
  if (!ip || ip === 'unknown') return null;

  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map((s) => Number(s));
    if (octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.*`;
    }
    return null;
  }

  // IPv6（含压缩 ::）：展开后再取前 4 hextet
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower.includes('.')) return null; // 拒绝 IPv4-mapped 混写，避免误存
    const parts = lower.split('::');
    if (parts.length > 2) return null;
    let hextets: string[];
    if (parts.length === 1) {
      hextets = parts[0]!.split(':').filter(Boolean);
      if (hextets.length !== 8) return null;
    } else {
      const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
      const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
      const missing = 8 - left.length - right.length;
      if (missing < 0) return null;
      hextets = [...left, ...Array(missing).fill('0'), ...right];
    }
    if (hextets.length !== 8) return null;
    if (!hextets.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
    return `${hextets.slice(0, 4).join(':')}:*`;
  }

  return null;
}

export function newOwnerSessionId(): string {
  return `oss_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function newOwnerLoginEventId(): string {
  return `ole_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function resolveOwnerSessionTtlSec(envValue: string | undefined): number {
  const n = Number.parseInt(envValue ?? '300', 10);
  if (!Number.isFinite(n) || n < 60) return 300;
  if (n > 86_400) return 86_400;
  return n;
}
