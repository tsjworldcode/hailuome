/**
 * M33-P8-n / REG-ASYNC / REG-BR-2a：registration_sync_state
 * - registry_challenge_pending：precheck 已成功、verify 未完成；窗口可续跑（不掉线重打 precheck）
 * - registry_accepted：中心已受理，待轮询 status 领取凭证
 * - registry_verified：已领取凭证，本地尚未落库
 *
 * 存 D1（非 KV）：含一次性 token / claim_token / nonce，
 * 禁止打日志 / 禁止公开 API 回显。
 */
import type { RegisterCompliance, RegistryIdentityPayload } from './types';

export const REGISTRATION_SYNC_SCOPE_HOME = 'home';
export const REGISTRATION_SYNC_PHASE_REGISTRY_VERIFIED = 'registry_verified';
export const REGISTRATION_SYNC_PHASE_REGISTRY_ACCEPTED = 'registry_accepted';
/** REG-BR-2a：precheck 成功、verify 掉线续跑 phase */
export const REGISTRATION_SYNC_PHASE_REGISTRY_CHALLENGE_PENDING = 'registry_challenge_pending';

export type RegistrationSyncPendingPayload = {
  challenge_id: string;
  user_id: string;
  node_api_token: string;
  did_v2: string;
  handle: string;
  display_name: string;
  /** M7-34：登记邮箱（站主私人数据） */
  registration_email: string;
  handle_qualified: string;
  registry_identity: RegistryIdentityPayload;
  registry_signature: string;
  suggested_daily_sync_utc_second_of_day?: number;
  sync_interval_days?: number;
  compliance: RegisterCompliance;
};

/** REG-ASYNC：verify 202 后暂存，便于 complete 中断后继续轮询。 */
export type RegistrationAcceptedPayload = {
  challenge_id: string;
  claim_token: string;
  handle: string;
  display_name: string;
  did_v2: string;
  /** M7-34：登记邮箱（站主私人数据） */
  registration_email: string;
  /** 受理时冻结的节点公钥；续跑时必须与当前 env 一致 */
  pubkey_hex: string;
  /** 受理时冻结的公开节点 URL；续跑时必须与当前 env 一致 */
  node_url: string;
  compliance: RegisterCompliance;
};

/** REG-BR-2a：precheck 成功、verify 掉线续跑 payload。
 *  字段集最小化：仅含挑战续跑所需；不含 claim_token / user_id / node_api_token（verify 之前拿不到）。 */
export type RegistrationChallengePendingPayload = {
  challenge_id: string;
  nonce: string;
  /** 受理时冻结的节点公钥；续跑时必须与当前 env 一致 */
  pubkey_hex: string;
  /** 受理时冻结的公开节点 URL；续跑时必须与当前 env 一致 */
  node_url: string;
  /** ISO 8601：写入时间（排障用） */
  precheck_at: string;
  /** ISO 8601：与注册中心 challenges.expires_at 对齐；过期则清 payload 走首次 */
  expires_at: string;
};

export function parseRegistrationSyncPayload(raw: string): RegistrationSyncPendingPayload | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.user_id !== 'string' || !o.user_id.trim()) return null;
    if (typeof o.node_api_token !== 'string' || !o.node_api_token.trim()) return null;
    if (typeof o.did_v2 !== 'string' || !o.did_v2.trim()) return null;
    if (typeof o.handle !== 'string' || !o.handle.trim()) return null;
    if (typeof o.display_name !== 'string') return null;
    // M7-34：registration_email 可选（向后兼容旧 entry）
    const registration_email =
      typeof o.registration_email === 'string' ? o.registration_email.trim() : '';
    if (typeof o.handle_qualified !== 'string') return null;
    if (typeof o.challenge_id !== 'string') return null;
    if (typeof o.registry_signature !== 'string' || !o.registry_signature.trim()) return null;
    if (!o.registry_identity || typeof o.registry_identity !== 'object') return null;
    if (!o.compliance || typeof o.compliance !== 'object') return null;
    const compliance = o.compliance as RegisterCompliance;
    // 2026-09-27：移除 age_over_18 校验
    if (typeof compliance.terms_accepted_at !== 'string' || typeof compliance.terms_version !== 'string') {
      return null;
    }
    return {
      challenge_id: o.challenge_id.trim(),
      user_id: o.user_id.trim(),
      node_api_token: o.node_api_token.trim(),
      did_v2: o.did_v2.trim(),
      handle: o.handle.trim(),
      display_name: o.display_name,
      registration_email,
      handle_qualified: o.handle_qualified.trim(),
      registry_identity: o.registry_identity as RegistryIdentityPayload,
      registry_signature: o.registry_signature.trim(),
      suggested_daily_sync_utc_second_of_day:
        typeof o.suggested_daily_sync_utc_second_of_day === 'number'
          ? o.suggested_daily_sync_utc_second_of_day
          : undefined,
      sync_interval_days:
        typeof o.sync_interval_days === 'number' ? o.sync_interval_days : undefined,
      compliance,
    };
  } catch {
    return null;
  }
}

export function parseRegistrationAcceptedPayload(raw: string): RegistrationAcceptedPayload | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.challenge_id !== 'string' || !o.challenge_id.trim()) return null;
    if (typeof o.claim_token !== 'string' || !o.claim_token.trim()) return null;
    if (typeof o.handle !== 'string' || !o.handle.trim()) return null;
    if (typeof o.display_name !== 'string') return null;
    if (typeof o.did_v2 !== 'string' || !o.did_v2.trim()) return null;
    // M7-34：registration_email 可选（向后兼容旧 entry）
    const registration_email =
      typeof o.registration_email === 'string' ? o.registration_email.trim() : '';
    if (typeof o.pubkey_hex !== 'string' || !o.pubkey_hex.trim()) return null;
    if (typeof o.node_url !== 'string' || !o.node_url.trim()) return null;
    if (!o.compliance || typeof o.compliance !== 'object') return null;
    const compliance = o.compliance as RegisterCompliance;
    // 2026-09-27：移除 age_over_18 校验
    if (typeof compliance.terms_accepted_at !== 'string' || typeof compliance.terms_version !== 'string') {
      return null;
    }
    return {
      challenge_id: o.challenge_id.trim(),
      claim_token: o.claim_token.trim(),
      handle: o.handle.trim(),
      display_name: o.display_name,
      registration_email,
      did_v2: o.did_v2.trim(),
      pubkey_hex: o.pubkey_hex.trim(),
      node_url: o.node_url.trim(),
      compliance,
    };
  } catch {
    return null;
  }
}

/**
 * REG-BR-2a：解析 challenge_pending payload；任一字段缺/类型错/空串返 null。
 * expires_at 必须能 new Date() 解析，否则 null（防止写入残缺行阻断续跑）。
 */
export function parseRegistrationChallengePendingPayload(
  raw: string,
): RegistrationChallengePendingPayload | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.challenge_id !== 'string' || !o.challenge_id.trim()) return null;
    if (typeof o.nonce !== 'string' || !o.nonce.trim()) return null;
    if (typeof o.pubkey_hex !== 'string' || !o.pubkey_hex.trim()) return null;
    if (typeof o.node_url !== 'string' || !o.node_url.trim()) return null;
    if (typeof o.precheck_at !== 'string' || !o.precheck_at.trim()) return null;
    if (typeof o.expires_at !== 'string' || !o.expires_at.trim()) return null;
    const expiresAtMs = Date.parse(o.expires_at);
    if (!Number.isFinite(expiresAtMs)) return null;
    const precheckAtMs = Date.parse(o.precheck_at);
    if (!Number.isFinite(precheckAtMs)) return null;
    return {
      challenge_id: o.challenge_id.trim(),
      nonce: o.nonce.trim(),
      pubkey_hex: o.pubkey_hex.trim(),
      node_url: o.node_url.trim(),
      precheck_at: new Date(precheckAtMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/** REG-BR-2a：判断 challenge_pending payload 是否仍在 challenge 窗口内（未过期）。 */
export function isChallengePendingPayloadAlive(
  payload: RegistrationChallengePendingPayload,
  nowIso: string,
): boolean {
  const expiresAtMs = Date.parse(payload.expires_at);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs > nowMs;
}

/** REG-BR-2a：判定身份冻结（pubkey_hex + node_url）匹配当前 env。 */
export function assertChallengePendingIdentityMatchesPayload(
  pending: RegistrationChallengePendingPayload,
  pubkeyHex: string,
  nodeUrl: string,
): boolean {
  return pending.pubkey_hex === pubkeyHex && pending.node_url === nodeUrl;
}

