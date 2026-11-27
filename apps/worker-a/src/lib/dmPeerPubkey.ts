/**
 * DM-PEER-PUBKEY-1：从对端 Worker B `GET /users/:handle` 的公开资料中只取
 * `dm_pubkey` + `worker_b_url`，供本机 Worker A 服务端解析私信公钥。
 *
 * 背景：浏览器直接 `fetch` 对端 Worker B 会同时撞上两层墙：
 *   1) 用户网络可能访问不了 `*.workers.dev`（DNS 污染 / 企业代理）；
 *   2) 默认 `token-required` 档下 Worker B CORS 只放行它自己的 Pages 来源。
 * 本 lib 只做纯解析 / URL 拼接，不做网络请求；路由层用 `fetchOutboundPeer` 取档。
 *
 * 防身份关联：只返回 dm_pubkey / worker_b_url，不透传 bio / contact_email 等资料。
 */
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';

/**
 * 拼对端公开资料 URL。
 *
 * `assertSafePeerWorkerBUrl` / `URL.toString()` 会把裸 origin 补成 `https://host/`；
 * 直接 `${nodeUrl}/users/x` 会得到 `https://host//users/x`（双斜杠），
 * Hono 的 `/users/:handle` 不匹配 → 对端返回 404，前端误报「找不到该用户」。
 * 必须先 `normalizeWorkerBOrigin` 去尾斜杠。
 */
export function buildPeerUserProfileUrl(nodeUrl: string, handle: string): string {
  return `${normalizeWorkerBOrigin(nodeUrl)}/users/${encodeURIComponent(handle)}`;
}

export type DmPeerPubkeyParseResult =
  | { readonly ok: true; readonly dm_pubkey: string; readonly worker_b_url: string }
  | { readonly ok: false; readonly reason: 'no_pubkey' | 'invalid' };

/**
 * 解析对端 `/users/:handle` 响应。
 *
 * - `ok: true`：data 是对象且 dm_pubkey 为 64 hex；
 * - `no_pubkey`：data 是对象但 dm_pubkey 为空 / 格式不对（对方确实没开私信）；
 * - `invalid`：响应不是 `{ ok: true, data: object }` 形状（旧节点 / HTML / 代理错误页）。
 */
export function parseDmPeerPubkeyProfile(
  raw: unknown,
  fallbackNodeUrl: string,
): DmPeerPubkeyParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid' };
  const obj = raw as { ok?: unknown; data?: unknown };
  if (obj.ok !== true || !obj.data || typeof obj.data !== 'object') {
    return { ok: false, reason: 'invalid' };
  }
  const data = obj.data as Record<string, unknown>;
  const dmPubkey = typeof data.dm_pubkey === 'string' ? data.dm_pubkey.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(dmPubkey)) {
    return { ok: false, reason: 'no_pubkey' };
  }
  const workerBUrl = typeof data.worker_b_url === 'string' ? data.worker_b_url.trim() : '';
  return {
    ok: true,
    dm_pubkey: dmPubkey,
    worker_b_url: workerBUrl || fallbackNodeUrl,
  };
}
