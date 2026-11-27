/**
 * SEC-AUDIT-2026-10-6a · Worker B 媒体票据能力层（MEDIA-TICKET-1）。
 *
 * 【职责】
 *   - 签发：给**本节点自己的**媒体签发短 TTL 票据（受保护档下供 `<img>` 直连）。
 *   - 校验：`GET /img/:key` 在 protected 档下接受「合法票据」作为 Authorization 的替代。
 *
 * 【为什么票据由源站自己签发，而不是 Worker A 代签】
 *   1. Worker A 永不公开（§F-02 硬约束），票据出现在 URL 里更不能借道 Worker A 公网地址。
 *   2. 票据验签需要 `MEDIA_TICKET_SECRET`，让 secret 只存在于**消费方** Worker B，
 *      泄露面收敛在单个 Worker 内，不需要跨 Worker 同步密钥。
 *   3. Worker B 只读不写，签发票据是**纯计算**（HMAC），不产生任何 KV/D1 写入，
 *      不触碰 Free Tier 写额度。
 *
 * 【开关 · SEC-6-AUTO】
 *   主闸 = 当前读帖档位：`token-required` / `following-only` / `mutual-only` 自动开；
 *   `public-read` / `owner-only` 自动关。须已配置 `MEDIA_TICKET_SECRET`。
 *   `MEDIA_TICKET_ENABLED=false|0|off` 为**紧急关闸**（覆盖自动开）；未设置或 true 时跟档位走。
 *   站主 Settings 切档后，Worker B 约 45s 内与读帖保护同步（同 M13-1 TTL）。
 */

import { buildMediaTicketPayload, signMediaTicket, verifyMediaTicket } from '@hailuo/shared-crypto';
import type { MediaTicketFailure, MediaTicketPayload } from '@hailuo/shared-crypto';
import {
  modeWantsMediaTickets,
  type FollowerTokenMode,
} from '@hailuo/shared-utils';
import type { Env } from '../env.d';

/** 紧急关闸 env 名（false/0/off 强制关；其它值不挡自动开）。 */
export const MEDIA_TICKET_ENABLED_FLAG = 'MEDIA_TICKET_ENABLED';

/** 支持的媒体 storage key 前缀（与 `GET /img/:key` 解析口径一致）。 */
const SUPPORTED_KEY_PREFIXES = ['kv:', 'r2:', 'b2:', 'filebase:'] as const;

/** 票据签发请求体上限（8 KB，够放 key + 审计标识）。 */
const MAX_TICKET_BODY_BYTES = 8 * 1024;

/**
 * 校验 storage key 是否为可签发票据的媒体 key。
 *
 * 保守白名单：只接受已知后端前缀，且 key 主体不含空白 / 控制字符，
 * 避免把任意字符串塞进票据 payload。
 */
export function isTicketableStorageKey(key: string): boolean {
  if (!key) return false;
  const prefix = SUPPORTED_KEY_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix) return false;
  const rest = key.slice(prefix.length);
  if (!rest || rest.length > 512) return false;
  // 不允许空白与控制字符（票据会进 URL，空白会被转义后破坏比对）
  return !/[\s\u0000-\u001f\u007f]/.test(rest);
}

/**
 * 紧急关闸是否按下（显式 false/0/off）。
 * 未设置或 true/1/on → 不关闸，由档位决定。
 */
export function isMediaTicketForceDisabled(env: Env): boolean {
  const raw = env.MEDIA_TICKET_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  return raw === 'false' || raw === '0' || raw === 'off';
}

/**
 * @deprecated 语义已改为「非紧急关闸」；新代码用 `!isMediaTicketForceDisabled` + `modeWantsMediaTickets`。
 * 保留：true = 未按下关闸（含 unset），便于旧测试字面兼容。
 */
export function isMediaTicketEnabled(env: Env): boolean {
  return !isMediaTicketForceDisabled(env);
}

/** 票据签名 secret 是否已配置。 */
export function resolveMediaTicketSecret(env: Env): string | null {
  const secret = env.MEDIA_TICKET_SECRET?.trim();
  return secret ? secret : null;
}

/**
 * 票据能力是否可用：已配 secret + 当前档需要票据 + 未紧急关闸。
 * @param mode 当前读帖保护档（须由调用方传入，与 `/img` 中间件一致）
 */
export function isMediaTicketUsable(env: Env, mode: FollowerTokenMode): boolean {
  if (isMediaTicketForceDisabled(env)) return false;
  if (resolveMediaTicketSecret(env) === null) return false;
  return modeWantsMediaTickets(mode);
}

/** 签发票据（调用方须自行确认 key 合法、且能力可用）。 */
export async function issueMediaTicket(
  env: Env,
  input: { storageKey: string; requesterSub?: string },
): Promise<{ ok: true; ticket: string; payload: MediaTicketPayload } | { ok: false; error_code: string; message: string }> {
  const secret = resolveMediaTicketSecret(env);
  if (!secret) {
    return {
      ok: false,
      error_code: 'MEDIA_TICKET_DISABLED',
      message: '媒体票据能力未启用',
    };
  }
  if (!isTicketableStorageKey(input.storageKey)) {
    return {
      ok: false,
      error_code: 'MEDIA_TICKET_KEY_INVALID',
      message: '媒体 key 不合法',
    };
  }
  const payload = buildMediaTicketPayload({
    storageKey: input.storageKey,
    requesterSub: input.requesterSub ?? '',
  });
  const ticket = await signMediaTicket(payload, secret);
  return { ok: true, ticket, payload };
}

/**
 * 校验票据是否可用于当前 storage key。
 *
 * @param ticket query 参数 `ticket`
 * @param storageKey 当前 `GET /img/:key` 的 key（**必须**精确比对，票据绑定单 key）
 */
export async function verifyMediaTicketForKey(
  env: Env,
  ticket: string | null | undefined,
  storageKey: string,
): Promise<{ ok: true; payload: MediaTicketPayload } | { ok: false; reason: MediaTicketFailure }> {
  const secret = resolveMediaTicketSecret(env);
  if (!secret) {
    return { ok: false, reason: 'bad_signature' };
  }
  return verifyMediaTicket(ticket, secret, storageKey);
}

/**
 * 单次批量票据请求允许的最大 key 数（与前端分片上限一致）。
 * 上限存在的意义：一次请求一个签名 + 一个响应体，避免被当作放大器。
 */
export const MAX_MEDIA_TICKET_KEYS = 32;

/** 票据请求体解析结果（批量 / 旧单 key 两种形态）。 */
export type ParsedMediaTicketRequest =
  | {
      ok: true;
      /** 去重后的 storage key 列表（顺序保持请求顺序） */
      storageKeys: string[];
      /** 旧形态（`storage_key`）为 true —— 响应需保留扁平字段做向后兼容 */
      legacySingle: boolean;
      requesterSub?: string;
    }
  | { ok: false; error_code: string; message: string };

/**
 * 票据请求体解析。
 *
 * 支持两种形态：
 *  - 批量（SEC-AUDIT-2026-10-6b）：`{ "storage_keys": ["kv:a", "kv:b"] }`（1..32 个）
 *  - 旧单 key（SEC-AUDIT-2026-10-6a）：`{ "storage_key": "kv:a" }`
 *
 * 批量形态的动机：浏览器一次渲染多张图时，逐张取票会产生 N 次请求；
 * 批量接口把 N 次压成 1 次（上限 32，超出由前端分片）。
 */
export function parseMediaTicketRequestBody(raw: string): ParsedMediaTicketRequest {
  if (new TextEncoder().encode(raw).byteLength > MAX_TICKET_BODY_BYTES) {
    return { ok: false, error_code: 'INVALID_BODY', message: '请求体超过大小限制' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error_code: 'INVALID_BODY', message: '请求体格式错误' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error_code: 'INVALID_BODY', message: '请求体格式错误' };
  }
  const o = parsed as Record<string, unknown>;
  const requesterSub = typeof o.requester_sub === 'string' ? o.requester_sub.trim() : undefined;

  // ── 批量形态 ─────────────────────────────────────────────────────────
  if (Array.isArray(o.storage_keys)) {
    const rawKeys = o.storage_keys;
    if (rawKeys.length === 0) {
      return { ok: false, error_code: 'STORAGE_KEY_REQUIRED', message: '缺少 storage_key' };
    }
    if (rawKeys.length > MAX_MEDIA_TICKET_KEYS) {
      return {
        ok: false,
        error_code: 'TOO_MANY_STORAGE_KEYS',
        message: `单次最多签发 ${MAX_MEDIA_TICKET_KEYS} 个媒体票据`,
      };
    }
    const storageKeys: string[] = [];
    for (const item of rawKeys) {
      if (typeof item !== 'string') {
        return { ok: false, error_code: 'INVALID_BODY', message: 'storage_keys 必须是字符串数组' };
      }
      const key = item.trim();
      if (!key) {
        return { ok: false, error_code: 'STORAGE_KEY_REQUIRED', message: '缺少 storage_key' };
      }
      if (!isTicketableStorageKey(key)) {
        return { ok: false, error_code: 'MEDIA_TICKET_KEY_INVALID', message: '媒体 key 不合法' };
      }
      if (!storageKeys.includes(key)) storageKeys.push(key);
    }
    return { ok: true, storageKeys, legacySingle: false, requesterSub };
  }

  // ── 旧单 key 形态 ───────────────────────────────────────────────────
  const storageKey = typeof o.storage_key === 'string' ? o.storage_key.trim() : '';
  if (!storageKey) {
    return { ok: false, error_code: 'STORAGE_KEY_REQUIRED', message: '缺少 storage_key' };
  }
  return { ok: true, storageKeys: [storageKey], legacySingle: true, requesterSub };
}
