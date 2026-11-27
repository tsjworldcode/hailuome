// ============================================================
// 通用工具函数（Web Crypto API 兼容，无 Node.js 依赖）
// ============================================================

// ---- 字节 <-> 十六进制 转换 --------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error('hex 字符串长度必须是偶数');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---- Base64url 转换（JWT/Token 用）------------------------

export function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padLen));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- ID 生成（crypto.randomUUID）--------------------------

/**
 * 生成带前缀的唯一 ID
 * 示例：generateId('post') → 'post_550e8400e29b41d4a716446655440000'
 */
export function generateId(prefix: string): string {
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `${prefix}_${uuid}`;
}

export { randomNonceHex } from './randomNonceHex';

// ---- 时间工具 -----------------------------------------------

/** 返回当前 UTC 时间的 ISO 8601 字符串，精确到毫秒 */
export function nowISO(): string {
  return new Date().toISOString();
}

/** 返回当前 Unix 时间戳（秒） */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** ISO 8601 字符串 → Unix 时间戳（秒） */
export function isoToSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// ---- 文本编解码 ---------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeText(str: string): Uint8Array<ArrayBuffer> {
  // TextEncoder 运行时返回 ArrayBuffer 视图；复制一次让 TS 类型也收窄为 WebCrypto 可接受的 BufferSource。
  return new Uint8Array(encoder.encode(str));
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export {
  isAllowedOwnerPath,
  isPublicWorkerBPath,
  OWNER_GATEWAY_COMPAT_MOUNT_PREFIXES,
  OWNER_GATEWAY_RULES,
  PUBLIC_WORKER_B_PREFIXES,
} from './ownerGatewayAllowlist';
export type {
  OwnerGatewayExactRule,
  OwnerGatewayPrefixRule,
  OwnerGatewayRule,
} from './ownerGatewayAllowlist';
export {
  sanitizeRegistryEndpointsForPublic,
  parsePublicRegistryEndpointsKv,
} from './registryEndpointsPublic';
export type { RegistryEndpointLike } from './registryEndpointsPublic';
export {
  BLACKLIST_KV_LEGACY_PREFIX,
  BLACKLIST_KV_LOCAL_PREFIX,
  BLACKLIST_KV_REGISTRY_PREFIX,
  BLACKLIST_KV_FEDERATED_PREFIX,
  blacklistKvKeysForSub,
  blacklistLegacyKey,
  blacklistLocalKey,
  blacklistRegistryKey,
  blacklistFederatedKey,
  isLegacyBlacklistKvKey,
} from './blacklistKv';
export { isPublicReadCacheEnvelope } from './publicReadCacheEnvelope';
export {
  HAILUO_PROTO_VERSION,
  serializeProtoEnvelope,
  withProtoVersion,
} from './protoEnvelope';
export type { HailuoProtoVersion } from './protoEnvelope';
export {
  FOLLOWER_TOKEN_MODES,
  FOLLOWER_READ_SCOPES,
  FOLLOWER_TOKEN_MODE_FORCED,
  FOLLOWER_TOKEN_MODE_DEFAULT,
  FOLLOWER_TOKEN_MODE_FORCE_ENABLED,
  resolveForcedFollowerTokenMode,
  isFollowerTokenModeProgramForced,
  normalizeWorkerBOrigin,
  normalizeFollowerTokenMode,
  parseFollowerTokenModeForRead,
  parseFollowerTokenModeForWrite,
  isProtectedFollowerTokenMode,
  modeWantsMediaTickets,
  checkReadScopeForMode,
} from './followerTokenMode';
export type { FollowerTokenMode, FollowerReadScope } from './followerTokenMode';
export {
  EMAIL_ALLOWLIST_VERSION,
  REGISTER_EMAIL_DOMAIN_USER_MESSAGE,
  checkRegisterEmailDomainV1,
  getEmailAllowlistV1DomainCount,
  getEmailBlocklistV1DomainCount,
} from './emailAllowlistV1';
export {
  PROJECT_TERMS_VERSION,
  validateRegisterEmail,
  validateRegisterPrecheckEmail,
  validateTermsAcceptance,
} from './registerRequirements';

export type { RegisterFieldError } from './registerRequirements';
// SPILL-1c-node-c：人口学常量与校验导出已随 registerRequirements 物理删除（不再 re-export）。
export {
  HANDLE_LOCAL_RE,
  HANDLE_LOCAL_RE_LEGACY,
  HANDLE_MIN_BYTES,
  HANDLE_MAX_BYTES,
  RESERVED_HANDLE_PREFIX,
  HANDLE_LOCAL_RULES_USER_MESSAGE_ZH,
  HANDLE_LOCAL_RULES_USER_MESSAGE_EN,
  HANDLE_RESERVED_USER_MESSAGE_ZH,
  HANDLE_RESERVED_USER_MESSAGE_EN,
  handleUtf8ByteLength,
  isHandleByteLengthValid,
  isReservedHandlePrefix,
  isValidRegisterHandleLocal,
  isValidLegacyHandleLocal,
  normalizeHandleLocalSegment,
} from './handleLocal';
// NCF-HS-5：跟随中心 D8 发号形态识别（节点不找片）
export {
  REGISTRY_USER_ID_REGEX_D8,
  REGISTRY_USER_ID_REGEX_PRE_HS,
  REGISTRY_CREDENTIAL_ID_REGEX_D8,
  REGISTRY_USER_ID_D8_EXAMPLE,
  looksLikeRegistryUserId,
  looksLikeRegistryPrincipalIdD8,
} from './registryPrincipalId';
export {
  buildMessagingMediaStorageKey,
  isMessagingMediaObjectName,
  isMessagingMediaStorageKey,
  parseMessagingMediaBackend,
  parseMessagingMediaStorageKey,
} from './messagingMediaKey';
export type { MessagingMediaBackend } from './messagingMediaKey';
export {
  DEPLOYMENT_MODES,
  HOSTED_L0_ACCOUNT_DELETE_CONFIRM_PHRASE,
  HOSTED_L0_DATA_RETENTION_DAYS,
  HOSTED_L0_PRIVACY_SECTIONS,
  HOSTED_L0_PRIVACY_VERSION,
  buildHostedL0PrivacyDocument,
  isHostedL0ModeEnabled,
} from './hostedL0';
export type { DeploymentMode, HostedL0PrivacySection } from './hostedL0';
// SPILL-1b-6-c：M9-9 机器节点 / AI agent 注册已退役（plan §6.5.4）。
// 共享类型 `packages/shared-utils/src/machineNode.ts` 已物理删除；MACHINE_*
// 常量与 helper（MACHINE_INVITE_TOKEN_PREFIX / MACHINE_INVITE_DEFAULT_TTL_HOURS /
// MACHINE_INVITE_MAX_TTL_HOURS / MACHINE_CAPABILITIES_MAX / MACHINE_CAPABILITY_MAX_LEN /
// MACHINE_NODE_TYPES / normalizeMachineCapabilities / parseMachineNodeType /
// MachineNodeType）随文件一起迁出；调用方已在 SPILL-1b-6-a/b 之前清空。
export {
  ALLOWED_HTTPS_PORTS,
  assertSafeOutboundHttpsUrl,
  assertSafePeerWorkerBUrl,
  isBlockedIpv4,
  isBlockedIpv6,
  isPrivateProofTargetAllowed,
  redactOutboundUrlHost,
} from './ssrfGuard';
export {
  CERT_INBOUND_PURPOSE_ZH,
  buildCertInboundAddressExample,
  deriveCertInboundHostFromRegistryUrl,
} from './certInboundHost';
export type { SsrfGuardResult } from './ssrfGuard';
