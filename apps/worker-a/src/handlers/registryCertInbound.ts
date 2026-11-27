/**
 * M33-4 / M33-v2-9：认证收件域由主注册中心 URL 本地推导，不再由 registry 下发。
 */
import {
  buildCertInboundAddressExample,
  CERT_INBOUND_PURPOSE_ZH,
  deriveCertInboundHostFromRegistryUrl,
} from '@hailuo/shared-utils';
import type { Env } from '../env';
import { issueInboundCertAddressV3 } from '@hailuo/shared-crypto';
import { resolveIdentityDb } from '../db/bindings';
import { resolvePrimaryRegistryUrl } from '../lib/registryRouter';

export type CertInboundIssueData = {
  cert_inbound_host: string;
  cert_inbound_address: string;
  cert_inbound_address_example: string;
  cert_inbound_purpose: string;
  expires_at: string;
  expires_in: number;
};

export type CertInboundPresentation = {
  cert_inbound_host: string;
  cert_inbound_address_example: string;
  cert_inbound_purpose: string;
};

const DEFAULT_CERT_INBOUND_TTL_HOURS = 24;

async function readOwnerUserId(env: Env): Promise<string | null> {
  // M-OPT-SPLIT-A7-3：system_config → IDENTITY_DB
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT value FROM system_config WHERE key = 'owner_user_id' LIMIT 1`)
    .first<{ value: string }>();
  const v = row?.value?.trim();
  return v || null;
}

/** 从主注册中心 URL 推导认证收件域与展示字段。 */
export async function resolveCertInboundPresentation(env: Env): Promise<CertInboundPresentation> {
  const registryUrl = await resolvePrimaryRegistryUrl(env);
  const cert_inbound_host = deriveCertInboundHostFromRegistryUrl(registryUrl);
  return {
    cert_inbound_host,
    cert_inbound_address_example: buildCertInboundAddressExample(cert_inbound_host),
    cert_inbound_purpose: CERT_INBOUND_PURPOSE_ZH,
  };
}

/** M33-v2：Worker A 本地签发通道 A 收件地址（零 registry 签发 API）。 */
export async function issueLocalCertInboundAddress(
  env: Env,
  params: {
    userId: string;
    /** M7-39：v3 起收件地址内嵌 handle（MAC 拼串含 handle）。 */
    handle: string;
    certInboundHost: string;
    certInboundAddressExample: string;
    certInboundPurpose: string;
    ttlHours?: number;
  },
): Promise<CertInboundIssueData> {
  const privateKey = env.ED25519_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error('ED25519_PRIVATE_KEY_MISSING');
  }
  const host = params.certInboundHost.trim().toLowerCase();
  if (!host) {
    throw new Error('CERT_INBOUND_HOST_MISSING');
  }
  // M7-39：改走 v3（handle 进地址 + 进 MAC）
  const issued = await issueInboundCertAddressV3({
    userId: params.userId,
    handle: params.handle,
    certInboundHost: host,
    ttlHours: params.ttlHours ?? DEFAULT_CERT_INBOUND_TTL_HOURS,
    privateKeyPkcs8Hex: privateKey,
  });
  return {
    cert_inbound_host: host,
    cert_inbound_address: issued.cert_inbound_address,
    cert_inbound_address_example: params.certInboundAddressExample,
    cert_inbound_purpose: params.certInboundPurpose,
    expires_at: issued.expires_at,
    expires_in: issued.expires_in,
  };
}

/** 读取 owner_user_id，供本地签发前校验节点已登记。 */
export async function readOwnerUserIdForCertInbound(env: Env): Promise<string | null> {
  return readOwnerUserId(env);
}

/** @deprecated 使用 resolveCertInboundPresentation；保留别名供旧调用点迁移。 */
export async function readCertInboundConfig(env: Env): Promise<CertInboundPresentation> {
  return resolveCertInboundPresentation(env);
}
