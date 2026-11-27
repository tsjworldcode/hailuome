/**
 * NCF-2C：节点侧登记完成（register/complete）深模块类型。
 * 契约见 docs/m-refactor-ncf-2-plan.md §5.4。
 * 注意：本域不写完整邮箱/手机到对外 message；日志禁止 token/私钥。
 */

import type { RegistryIdentityPayload } from '../../lib/registryEndpoints';
import type {
  RegistrationChallengePendingPayload,
  RegistrationSyncPendingPayload,
} from './registrationSyncState';

export type { RegistryIdentityPayload };
export type { RegistrationSyncPendingPayload };
export type { RegistrationChallengePendingPayload };

export type RegisterCompleteStatus =
  | 'ok'
  | 'bad_request'
  | 'already_registered'
  | 'misconfigured'
  | 'registry_upstream'
  | 'browser_relay'
  | 'sign_failed'
  | 'did_mismatch'
  | 'trust_failed'
  | 'local_persist_failed'
  | 'internal_error';

export type RegisterCompliance = {
  /** 2026-09-27：移除 age_over_18；注册不再要求年龄自证 */
  terms_accepted_at: string;
  terms_version: string;
};

export type RegisterBrowserPhase = 'prepare' | 'precheck_result' | 'verify_result';

export type RegisterCompleteCommand = {
  handle: string;
  displayName: string;
  email: string;
  emailVerifyToken?: string;
  turnstileToken: string;
  compliance: RegisterCompliance;
  /** 有这个字段时，预检和提交由浏览器送到注册中心。 */
  browser?: {
    phase: RegisterBrowserPhase;
    upstreamStatus?: number;
    upstreamBody?: unknown;
  };
};

export type RegisterCompleteSuccessData = {
  handle: string;
  handle_qualified: string | null;
  display_name: string;
  user_id: string;
  did_v2: string;
  message: string;
  cert_inbound_host: string | null;
  cert_inbound_address_example: string | null;
  cert_inbound_purpose: string | null;
};

export type RegisterCompleteResult = {
  status: RegisterCompleteStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: RegisterCompleteSuccessData;
  /** 注册中心拒绝时透传。已去掉领取令牌。 */
  upstreamBody?: unknown;
  /** 浏览器下一步要送到注册中心的正文。不含领取令牌。 */
  relay?: {
    step: 'precheck' | 'verify';
    registry_url: string;
    path: string;
    body: Record<string, unknown>;
  };
  flags?: {
    needInitialDailySync?: boolean;
  };
};

export type RegistryClientResponse = { status: number; data: unknown };

export type CertInboundPresentation = {
  cert_inbound_host: string | null;
  cert_inbound_address_example: string | null;
  cert_inbound_purpose: string | null;
};

/** 窄依赖：核心禁止整包 Env 与 Hono Context */
export type RegisterCompleteDeps = {
  nodeIdentity: {
    getPubkeyHex(): string | null;
    getPrivateKeyHex(): string | null;
    getNodeUrl(): string | null;
  };
  usersRepo: {
    isAlreadyRegistered(): Promise<boolean>;
    persistHomeRegistration(input: {
      handle: string;
      displayName: string;
      registrationEmail: string;
      pubkeyHex: string;
      nodeUrl: string;
      userId: string;
      nodeApiToken: string;
      didV2: string;
      handleQualified: string;
      compliance: RegisterCompliance;
      nowIso: string;
      suggestedDailySyncSecond?: number;
      syncIntervalDays?: number;
    }): Promise<void>;
  };
  proofStore: {
    writeChallenge(challengeId: string, nonce: string, fingerprint: string, nowIso: string): Promise<void>;
    putProofKv(proofBody: string): Promise<void>;
    deleteProofKv(): Promise<void>;
  };
  registryClient: {
    resolveRegistryUrl(): Promise<string>;
    precheck(body: Record<string, string | boolean>): Promise<RegistryClientResponse>;
    verifyChallenge(body: {
      challenge_id: string;
      signature: string;
      did_v2: string;
    }): Promise<RegistryClientResponse>;
    /** REG-ASYNC：轮询登记结果（Authorization: Bearer claim_token） */
    getChallengeStatus(
      challengeId: string,
      claimToken: string,
    ): Promise<RegistryClientResponse>;
    /** REG-ASYNC-FIX：本地落库成功后 ack，擦除中心明文 token */
    ackChallenge(
      challengeId: string,
      claimToken: string,
    ): Promise<RegistryClientResponse>;
    /** 浏览器提交之后，节点凭私钥领取封存的令牌。 */
    pickupClaim(challengeId: string): Promise<RegistryClientResponse>;
  };
  crypto: {
    pubkeyToRegistryB64(pubkeyHex: string): string;
    signatureToRegistryB64(signatureHex: string): string;
    computeFingerprint(pubkeyRegistryB64: string): Promise<string>;
    signChallenge(message: string, privateKeyHex: string): Promise<string>;
    deriveDidV2(pubkeyHex: string): Promise<string>;
  };
  endpointsPersist: {
    persistAndSyncKv(input: {
      identity: RegistryIdentityPayload;
      signature: string;
      userId: string;
      nodeApiToken: string;
      nowIso: string;
    }): Promise<void>;
  };
  /** M33-P8-n / REG-ASYNC：受理后或领取凭证后暂存，本地失败可续跑 */
  syncState: {
    readPending(): Promise<RegistrationSyncPendingPayload | null>;
    writePending(payload: RegistrationSyncPendingPayload, nowIso: string): Promise<void>;
    readAccepted(): Promise<import('./registrationSyncState').RegistrationAcceptedPayload | null>;
    writeAccepted(
      payload: import('./registrationSyncState').RegistrationAcceptedPayload,
      nowIso: string,
    ): Promise<void>;
    /** REG-BR-2a：precheck 已成功、verify 未完成时的续跑 payload */
    readChallengePending(): Promise<RegistrationChallengePendingPayload | null>;
    writeChallengePending(
      payload: RegistrationChallengePendingPayload,
      nowIso: string,
    ): Promise<void>;
    clear(): Promise<void>;
  };
  publicProfile: {
    putOwnerSnapshot(profile: Record<string, unknown>): Promise<void>;
    syncCanonicalWorkerBUrl(nodeUrl: string): Promise<void>;
    invalidateLocalBaseUrlCache(): void;
  };
  certInbound: {
    resolvePresentation(): Promise<CertInboundPresentation | null>;
  };
  handleFormat: {
    canonicalizeQualified(raw: string): string;
    formatQualified(local: string, registryId: string): string;
  };
  clock: { nowIso(): string };
  logger: {
    error(msg: string, detail?: unknown): void;
  };
};
