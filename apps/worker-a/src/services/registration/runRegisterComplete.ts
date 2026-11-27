/**
 * NCF-2C / M33-P8-n / REG-ASYNC：登记完成编排（无 Env / 无 Hono）。
 * P8：领取凭证后先写 registration_sync_state，再本地落库；失败可同接口续跑。
 * REG-ASYNC：verify 返回 202 + claim_token，轮询 status 领取 user_id/token。
 * REG-ASYNC-FIX：Bearer claim、冻结 pubkey/node_url、本地退避 + poll_after_ms、落库后 ack。
 * REG-ASYNC-FIX2-node（配对 registry FIX2-7）：读 status.attempts 抬升 localBackoff，减缓与中心 cron 对撞。
 */
import type {
  RegisterCompleteCommand,
  RegisterCompleteDeps,
  RegisterCompleteResult,
  RegistryClientResponse,
} from './types';
import type {
  RegistrationAcceptedPayload,
  RegistrationChallengePendingPayload,
  RegistrationSyncPendingPayload,
} from './registrationSyncState';
import { isChallengePendingPayloadAlive, assertChallengePendingIdentityMatchesPayload } from './registrationSyncState';

function isHttpOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 交回浏览器前去掉领取令牌和节点凭证。 */
function stripRelaySecrets(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(body));
  } catch {
    return {};
  }
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const row = value as Record<string, unknown>;
    delete row.claim_token;
    delete row.node_api_token;
    for (const item of Object.values(row)) walk(item);
  };
  walk(clone);
  return clone;
}

function relayResult(
  step: 'precheck' | 'verify',
  registryUrl: string,
  path: string,
  body: Record<string, unknown>,
): RegisterCompleteResult {
  return {
    status: 'browser_relay',
    httpStatus: 200,
    relay: { step, registry_url: registryUrl, path, body },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_MAX_MS = 90_000;
/** 本地退避起点；收到服务端 poll_after_ms 时也不重置；亦作 attempts 地板基数（BASE_BACKOFF_MS） */
const POLL_LOCAL_BACKOFF_START_MS = 500;
const POLL_LOCAL_BACKOFF_MAX_MS = 10_000;
const POLL_SERVER_DEFAULT_MS = 3000;
/** 无 token 但仍可短暂续轮时的上限（毫秒） */
const POLL_BRIEF_CONTINUE_MS = 15_000;
/** FIX2-7：status.attempts 参与地板时的上限倍数（与中心 MAX_PROCESS_ATTEMPTS 对齐） */
const POLL_ATTEMPTS_CAP = 5;

/** REG-BR-2a：节点侧挑战待 verify 窗口（与注册中心 CHALLENGE_TTL_MS 同源）。
 *  同步精度：registry `src/services/registration/registrationTypes.ts:CHALLENGE_TTL_MS = 10 * 60 * 1000`。
 *  任一侧改值需同步对侧；M-RegBootstrapResilience §五 双仓配对字段表已登记。 */
const REGISTRATION_CHALLENGE_PENDING_WINDOW_MS = 10 * 60 * 1000;

function pollJitterMs(): number {
  return Math.floor(Math.random() * 400);
}

/**
 * REG-ASYNC-FIX2-node：若中心回报 process_attempts>0，抬升 localBackoff 地板。
 * floor = BASE_BACKOFF_MS * min(attempts, 5)；只抬高不降低。
 */
function raiseLocalBackoffFromAttempts(localBackoff: number, attempts: unknown): number {
  const n = Math.max(0, Number(attempts ?? 0) || 0);
  if (n <= 0) return localBackoff;
  const floor = POLL_LOCAL_BACKOFF_START_MS * Math.min(n, POLL_ATTEMPTS_CAP);
  return Math.max(localBackoff, floor);
}

function appendPrecheckCompliance(
  body: Record<string, string | boolean>,
  compliance: RegisterCompleteCommand['compliance'],
): void {
  // 2026-09-27：不再上送 age_over_18
  body.terms_accepted = true;
  body.terms_version = compliance.terms_version;
}

/** status 成功体（与 registry GET /status data 对齐；亦称 StatusResponse） */
type StatusClaimData = {
  status?: string;
  result_code?: string | null;
  message?: string;
  poll_after_ms?: number;
  /** FIX2-7：= 中心 process_attempts；缺省/未知按 0 */
  readonly attempts?: number;
  user_id?: string;
  node_api_token?: string | null;
  did_v2?: string;
  handle_local?: string;
  handle_qualified?: string;
  home_registry_id?: string;
  suggested_daily_sync_utc_second_of_day?: number;
  sync_interval_days?: number;
  registry_identity?: RegistrationSyncPendingPayload['registry_identity'];
  registry_signature?: string;
  token_claimed?: boolean;
  token_claim_expired?: boolean;
  /** 兼容中心实现暂用名（与 token_claim_expired 同义） */
  claim_replay_expired?: boolean;
};

/** REG-ASYNC-FIX / FIX2-node：delay = max(poll_after_ms||3000, localBackoff) + jitter；
 * localBackoff 只增不减；attempts>0 时再抬地板。
 * M9-PH-BO-2：路径 D（claim_token 非 clm_ 前缀）在 challenge 尚未 INSERT 时 status 404，须继续轮询。 */
async function pollAndClaimCredentials(
  deps: RegisterCompleteDeps,
  accepted: RegistrationAcceptedPayload,
): Promise<
  | { ok: true; data: StatusClaimData }
  | { ok: false; result: RegisterCompleteResult }
> {
  const started = Date.now();
  let localBackoff = POLL_LOCAL_BACKOFF_START_MS;
  let briefContinueStarted: number | null = null;
  /** 路径 D：claim_token = browser_nonce（无 clm_ 前缀）；入队前 status 404 属预期。 */
  const treatNotFoundAsPending = !accepted.claim_token.trim().toLowerCase().startsWith('clm_');

  while (Date.now() - started < POLL_MAX_MS) {
    const st = await deps.registryClient.getChallengeStatus(
      accepted.challenge_id,
      accepted.claim_token,
    );
    if (!isHttpOk(st.status)) {
      const errBody = st.data as { error_code?: string } | null;
      const notFound =
        st.status === 404 || errBody?.error_code === 'REGISTER_CHALLENGE_NOT_FOUND';
      if (treatNotFoundAsPending && notFound) {
        const delay = Math.max(POLL_SERVER_DEFAULT_MS, localBackoff) + pollJitterMs();
        localBackoff = Math.min(localBackoff * 2, POLL_LOCAL_BACKOFF_MAX_MS);
        await sleep(delay);
        continue;
      }
      return {
        ok: false,
        result: {
          status: 'registry_upstream',
          httpStatus: st.status,
          upstreamBody: st.data,
        },
      };
    }
    const body = st.data as { ok?: boolean; data?: StatusClaimData };
    const data = body.data ?? {};
    // REG-ASYNC-FIX2-node：中心 process_attempts 抬升本地退避地板
    localBackoff = raiseLocalBackoffFromAttempts(localBackoff, data.attempts);

    if (data.status === 'accepted' || data.status === 'verifying') {
      const serverPoll =
        typeof data.poll_after_ms === 'number' && data.poll_after_ms > 0
          ? data.poll_after_ms
          : POLL_SERVER_DEFAULT_MS;
      // 中文注释：永不因服务端建议而把 localBackoff 重置回 500
      const delay = Math.max(serverPoll, localBackoff) + pollJitterMs();
      localBackoff = Math.min(localBackoff * 2, POLL_LOCAL_BACKOFF_MAX_MS);
      await sleep(delay);
      continue;
    }

    if (data.status === 'failed' || data.status === 'expired') {
      return {
        ok: false,
        result: {
          status: 'registry_upstream',
          httpStatus: 422,
          error_code: data.result_code ?? 'REGISTER_FAILED',
          message: data.message ?? '登记处理失败，请重新登记',
          upstreamBody: st.data,
        },
      };
    }

    if (data.status === 'succeeded') {
      if (data.user_id && data.node_api_token) {
        return { ok: true, data };
      }
      // 有界重放窗过期、未落本地 pending
      if (data.token_claim_expired === true || data.claim_replay_expired === true) {
        return {
          ok: false,
          result: {
            status: 'registry_upstream',
            httpStatus: 410,
            error_code: 'TOKEN_CLAIM_EXPIRED',
            message: '登记凭证领取窗口已过期；请排障或重新登记（勿盲目重试 precheck）',
            upstreamBody: st.data,
          },
        };
      }
      // 已 ack，本机尚无 pending → 无法再取明文
      if (data.token_claimed === true) {
        return {
          ok: false,
          result: {
            status: 'registry_upstream',
            httpStatus: 409,
            error_code: 'TOKEN_ALREADY_CLAIMED',
            message: '凭证已在注册中心确认领取，但本机无暂存；请排障或重新登记',
            upstreamBody: st.data,
          },
        };
      }
      // 短暂继续轮询（例如处理刚完成、token 尚未可见）
      if (briefContinueStarted === null) briefContinueStarted = Date.now();
      if (Date.now() - briefContinueStarted > POLL_BRIEF_CONTINUE_MS) {
        return {
          ok: false,
          result: {
            status: 'registry_upstream',
            httpStatus: 502,
            error_code: 'REGISTRY_ERROR',
            message: 'status 未返回 user_id / node_api_token',
            upstreamBody: st.data,
          },
        };
      }
      const serverPoll =
        typeof data.poll_after_ms === 'number' && data.poll_after_ms > 0
          ? data.poll_after_ms
          : POLL_SERVER_DEFAULT_MS;
      const delay = Math.max(serverPoll, localBackoff) + pollJitterMs();
      localBackoff = Math.min(localBackoff * 2, POLL_LOCAL_BACKOFF_MAX_MS);
      await sleep(delay);
      continue;
    }

    const delay = Math.max(POLL_SERVER_DEFAULT_MS, localBackoff) + pollJitterMs();
    localBackoff = Math.min(localBackoff * 2, POLL_LOCAL_BACKOFF_MAX_MS);
    await sleep(delay);
  }
  return {
    ok: false,
    result: {
      status: 'registry_upstream',
      httpStatus: 504,
      error_code: 'REGISTRATION_PROCESSING',
      message: treatNotFoundAsPending
        ? '邮件通道处理中或未开放：请确认已发信；若长时间无结果可稍后点「开始领取」重试，或继续用普通注册'
        : '登记处理超时，请稍后重试同一完成接口（勿重新 precheck）',
    },
  };
}

async function buildPendingFromClaim(
  deps: RegisterCompleteDeps,
  accepted: RegistrationAcceptedPayload,
  claim: StatusClaimData,
): Promise<
  | { ok: true; pending: RegistrationSyncPendingPayload }
  | { ok: false; result: RegisterCompleteResult }
> {
  const userId = claim.user_id!;
  const nodeApiToken = claim.node_api_token!;
  const registryDidV2 = claim.did_v2;
  const registryIdentity = claim.registry_identity;
  const registrySignature = claim.registry_signature;
  const didV2 = accepted.did_v2;

  const handleLocalForHq = (claim.handle_local ?? accepted.handle).trim().toLowerCase();
  const homeRegistryIdForHq = (
    claim.home_registry_id ??
    registryIdentity?.registry_id ??
    ''
  )
    .trim()
    .toLowerCase();
  const rawHandleQualified = claim.handle_qualified?.trim() ?? '';
  const handleQualified = rawHandleQualified
    ? deps.handleFormat.canonicalizeQualified(rawHandleQualified)
    : handleLocalForHq && homeRegistryIdForHq
      ? deps.handleFormat.formatQualified(handleLocalForHq, homeRegistryIdForHq)
      : '';

  if (!registryIdentity || !registrySignature) {
    return {
      ok: false,
      result: {
        status: 'registry_upstream',
        httpStatus: 502,
        error_code: 'REGISTRY_ERROR',
        message: 'status 未返回 registry_identity / registry_signature',
      },
    };
  }
  if (registryDidV2 && registryDidV2 !== didV2) {
    return {
      ok: false,
      result: {
        status: 'did_mismatch',
        httpStatus: 502,
        error_code: 'REGISTRY_DID_MISMATCH',
        message: '注册中心返回的 did_v2 与本地派生不一致',
      },
    };
  }

  return {
    ok: true,
    pending: {
      challenge_id: accepted.challenge_id,
      user_id: userId,
      node_api_token: nodeApiToken,
      did_v2: didV2,
      handle: accepted.handle,
      display_name: accepted.display_name,
      registration_email: accepted.registration_email,
      handle_qualified: handleQualified,
      registry_identity: registryIdentity,
      registry_signature: registrySignature,
      suggested_daily_sync_utc_second_of_day: claim.suggested_daily_sync_utc_second_of_day,
      sync_interval_days: claim.sync_interval_days,
      compliance: accepted.compliance,
    },
  };
}

/** 从已暂存 / 刚领取的 payload 完成本地落库。 */
async function finalizeLocalFromPending(
  deps: RegisterCompleteDeps,
  pending: RegistrationSyncPendingPayload,
  pubkeyHex: string,
  nodeUrl: string,
): Promise<RegisterCompleteResult> {
  const isoNow2 = deps.clock.nowIso();
  const {
    user_id: userId,
    node_api_token: nodeApiToken,
    did_v2: didV2,
    handle,
    display_name: displayName,
    handle_qualified: handleQualified,
    registry_identity: registryIdentity,
    registry_signature: registrySignature,
    compliance,
  } = pending;

  try {
    await deps.endpointsPersist.persistAndSyncKv({
      identity: registryIdentity,
      signature: registrySignature,
      userId,
      nodeApiToken,
      nowIso: isoNow2,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'REGISTRY_IDENTITY_INVALID') {
      await deps.syncState.clear();
      return {
        status: 'trust_failed',
        httpStatus: 502,
        error_code: 'REGISTRY_IDENTITY_INVALID',
        message: '注册中心身份签名无效，登记已中止',
      };
    }
    if (msg === 'REGISTRY_TRUST_ANCHOR_MISMATCH') {
      await deps.syncState.clear();
      return {
        status: 'trust_failed',
        httpStatus: 502,
        error_code: 'REGISTRY_TRUST_ANCHOR_MISMATCH',
        message: '注册中心身份与节点钉死的主中心信任锚不匹配，登记已中止',
      };
    }
    deps.logger.error('[register/complete] persist registry_endpoints failed', err);
    return {
      status: 'local_persist_failed',
      httpStatus: 503,
      error_code: 'REGISTRATION_SYNC_PENDING',
      message: '注册中心已成功，本地写入失败；请重试本接口以续跑落库（勿重新 precheck）',
    };
  }

  try {
    await deps.usersRepo.persistHomeRegistration({
      handle,
      displayName,
      registrationEmail: pending.registration_email || '',
      pubkeyHex,
      nodeUrl,
      userId,
      nodeApiToken,
      didV2,
      handleQualified,
      compliance,
      nowIso: isoNow2,
      suggestedDailySyncSecond: pending.suggested_daily_sync_utc_second_of_day,
      syncIntervalDays: pending.sync_interval_days,
    });
  } catch (err) {
    deps.logger.error('[register/complete] persistHomeRegistration failed', err);
    return {
      status: 'local_persist_failed',
      httpStatus: 503,
      error_code: 'REGISTRATION_SYNC_PENDING',
      message: '注册中心已成功，本地写入失败；请重试本接口以续跑落库（勿重新 precheck）',
    };
  }

  await deps.syncState.clear();

  let certInbound: Awaited<ReturnType<typeof deps.certInbound.resolvePresentation>> = null;
  try {
    certInbound = await deps.certInbound.resolvePresentation();
  } catch (err) {
    deps.logger.error('[register/complete] cert inbound derive failed', err);
  }

  deps.publicProfile.invalidateLocalBaseUrlCache();
  // 登记已成功落 D1；公开快照同步失败不回滚登记
  await deps.publicProfile.putOwnerSnapshot({
    handle,
    display_name: displayName,
    bio: '',
    pubkey: pubkeyHex,
    dm_pubkey: '',
    worker_b_url: nodeUrl,
    avatar_key: '',
    contact_email: '',
    created_at: isoNow2,
    updated_at: isoNow2,
  });
  await deps.publicProfile.syncCanonicalWorkerBUrl(nodeUrl);

  return {
    status: 'ok',
    httpStatus: 200,
    data: {
      handle,
      handle_qualified: handleQualified || null,
      display_name: displayName,
      user_id: userId,
      did_v2: didV2,
      message: '注册中心登记完成，节点现已可被搜索发现',
      cert_inbound_host: certInbound?.cert_inbound_host ?? null,
      cert_inbound_address_example: certInbound?.cert_inbound_address_example ?? null,
      cert_inbound_purpose: certInbound?.cert_inbound_purpose ?? null,
    },
    flags: { needInitialDailySync: true },
  };
}

/**
 * REG-ASYNC-FIX：writePending → finalizeLocal → ack。
 * ack 失败：本地已成功则仅记日志；本地仍有 pending 时本路径不调 ack。
 */
async function writePendingFinalizeAndAck(
  deps: RegisterCompleteDeps,
  pending: RegistrationSyncPendingPayload,
  accepted: RegistrationAcceptedPayload,
  pubkeyHex: string,
  nodeUrl: string,
): Promise<RegisterCompleteResult> {
  try {
    await deps.syncState.writePending(pending, deps.clock.nowIso());
  } catch (err) {
    deps.logger.error('[register/complete] sync_state write failed', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '登记暂存失败，请稍后重试（若注册中心已成功请联系排障）',
    };
  }

  const result = await finalizeLocalFromPending(deps, pending, pubkeyHex, nodeUrl);

  // 中文注释：仅本地成功后 ack；失败时保留中心重放窗，勿提前擦除
  if (result.status === 'ok') {
    try {
      const ack = await deps.registryClient.ackChallenge(
        accepted.challenge_id,
        accepted.claim_token,
      );
      if (!isHttpOk(ack.status)) {
        // 本地已落库；ack 失败可忽略（中心重放窗内仍可再 ack）
        deps.logger.error('[register/complete] ackChallenge non-ok', ack.status);
      }
    } catch (err) {
      deps.logger.error('[register/complete] ackChallenge failed', err);
    }
  }

  return result;
}

function assertAcceptedIdentityMatchesEnv(
  accepted: RegistrationAcceptedPayload,
  pubkeyHex: string,
  nodeUrl: string,
): RegisterCompleteResult | null {
  if (accepted.pubkey_hex !== pubkeyHex || accepted.node_url !== nodeUrl) {
    return {
      status: 'misconfigured',
      httpStatus: 409,
      error_code: 'REGISTRATION_IDENTITY_MISMATCH',
      message:
        '受理时冻结的公钥或节点地址与当前配置不一致，无法续跑登记；请恢复原配置后重试，或清空暂存后重新登记',
    };
  }
  return null;
}

/**
 * REG-BR-2a：verify 成功后的通用后半段链路（首次 + challengeResume 共用）。
 * 负责 writeAccepted → poll → finalize → ack。
 */
async function proceedAfterVerifySuccess(
  deps: RegisterCompleteDeps,
  params: {
    challengeId: string;
    claimToken: string;
    didV2: string;
    handle: string;
    displayName: string;
    registrationEmail: string;
    compliance: import('./types').RegisterCompliance;
    pubkeyHex: string;
    nodeUrl: string;
  },
): Promise<RegisterCompleteResult> {
  const accepted: RegistrationAcceptedPayload = {
    challenge_id: params.challengeId,
    claim_token: params.claimToken,
    handle: params.handle,
    display_name: params.displayName,
    registration_email: params.registrationEmail,
    did_v2: params.didV2,
    pubkey_hex: params.pubkeyHex,
    node_url: params.nodeUrl,
    compliance: params.compliance,
  };

  try {
    await deps.syncState.writeAccepted(accepted, deps.clock.nowIso());
  } catch (err) {
    deps.logger.error('[register/complete] sync_state accepted write failed', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '登记受理暂存失败，请稍后重试',
    };
  }

  const polled = await pollAndClaimCredentials(deps, accepted);
  if (!polled.ok) return polled.result;
  await deps.proofStore.deleteProofKv();
  const built = await buildPendingFromClaim(deps, accepted, polled.data);
  if (!built.ok) return built.result;
  return writePendingFinalizeAndAck(
    deps,
    built.pending,
    accepted,
    params.pubkeyHex,
    params.nodeUrl,
  );
}

/**
 * REG-BR-2a：precheck 已成功、verify 未完成时的续跑分支。
 *
 * 行为：
 * 1. 读 syncState 的 challenge_pending phase；
 * 2. 校验 expires_at > now（未过期）+ 身份冻结匹配 env；
 * 3. 重新构造 proof KV（用旧 challenge_id + nonce），sign → verify；
 * 4. verify 成功后返回 challengeId/claimToken/didV2 给主流程复用 verify-后链路。
 *
 * 失败/不命中：返回 null 让调用方走首次流程。
 */
async function tryChallengeResume(
  deps: RegisterCompleteDeps,
  pubkeyHex: string,
  nodeUrl: string,
): Promise<{ challengeId: string; claimToken: string; didV2: string } | null> {
  const pending = await deps.syncState.readChallengePending();
  if (!pending) return null;

  // 身份冻结不符 → 清 payload 走首次
  if (!assertChallengePendingIdentityMatchesPayload(pending, pubkeyHex, nodeUrl)) {
    await deps.syncState.clear().catch(() => undefined);
    return null;
  }

  // 已过期 → 清 payload 走首次
  const nowIso = deps.clock.nowIso();
  if (!isChallengePendingPayloadAlive(pending, nowIso)) {
    await deps.syncState.clear().catch(() => undefined);
    return null;
  }

  // 重建 proofStore + proof KV（与首次 precheck 成功后同链路，便于 verify 端校验）
  let pubkeyRegistryB64: string;
  try {
    pubkeyRegistryB64 = deps.crypto.pubkeyToRegistryB64(pubkeyHex);
  } catch (err) {
    deps.logger.error('[register/complete] challengeResume pubkey encode failed', err);
    return null;
  }
  const pubkeyFingerprint = await deps.crypto.computeFingerprint(pubkeyRegistryB64);
  await deps.proofStore.writeChallenge(
    pending.challenge_id,
    pending.nonce,
    pubkeyFingerprint,
    nowIso,
  );
  const proofBody = `${pending.challenge_id}.${pending.nonce}`;
  try {
    await deps.proofStore.putProofKv(proofBody);
  } catch (err) {
    deps.logger.error('[register/complete] challengeResume proof KV write failed', err);
    // proof KV 失败不阻断 verify，但下次续跑时如中心仍要求 proof 则会失败；让 verify 自行决定
  }

  // 重新 sign + verify（与首次 precheck→sign→verify 同口径，不打 precheck）
  const privateKey = deps.nodeIdentity.getPrivateKeyHex() ?? '';
  let signatureHex: string;
  try {
    signatureHex = await deps.crypto.signChallenge(proofBody, privateKey);
  } catch (err) {
    deps.logger.error('[register/complete] challengeResume sign failed', err);
    return null;
  }
  let signatureRegistryB64: string;
  try {
    signatureRegistryB64 = deps.crypto.signatureToRegistryB64(signatureHex);
  } catch (err) {
    deps.logger.error('[register/complete] challengeResume signature encode failed', err);
    return null;
  }
  let didV2: string;
  try {
    didV2 = await deps.crypto.deriveDidV2(pubkeyHex);
  } catch (err) {
    deps.logger.error('[register/complete] challengeResume did_v2 derive failed', err);
    return null;
  }
  const verify = await deps.registryClient.verifyChallenge({
    challenge_id: pending.challenge_id,
    signature: signatureRegistryB64,
    did_v2: didV2,
  });
  if (!isHttpOk(verify.status)) {
    // verify 4xx/5xx：challenge 可能已过期/被中心拒；清 syncState 走首次
    await deps.syncState.clear().catch(() => undefined);
    return null;
  }
  const acceptData = verify.data as {
    ok?: boolean;
    data?: { challenge_id?: string; claim_token?: string | null };
  };
  const claimToken = acceptData.data?.claim_token;
  if (!claimToken) {
    // 中心可能仍返 202 但 claim_token 为空（如已过 verify 处理窗）
    await deps.syncState.clear().catch(() => undefined);
    return null;
  }
  return {
    challengeId: pending.challenge_id,
    claimToken,
    didV2,
  };
}

/**
 * NCF-CLAIM-PICKUP-1：浏览器把 verify 的回复交回来了，但里面没有领取令牌。
 * 节点用私钥签 `hailuo-register-claim-pickup.<challenge_id>`，到注册中心领取封存的明文。
 *
 * 失败一律转成结构化结果：不抛异常，避免登记页只看到 500；
 * 也不带上游 body，免得 `registerCompleteResultToResponse` 原样回显、盖掉这里的中文提示。
 * 状态码用 409：4xx 不会被网页的「换入口重试一次」接走（那个重试会复用一次性的 Turnstile token）。
 */
async function pickupClaimForBrowserFlow(
  deps: RegisterCompleteDeps,
  challengeId: string,
): Promise<{ ok: true; claimToken: string } | { ok: false; result: RegisterCompleteResult }> {
  let picked: RegistryClientResponse;
  try {
    picked = await deps.registryClient.pickupClaim(challengeId);
  } catch (err) {
    deps.logger.error('[register/complete] claim pickup request failed', err);
    return {
      ok: false,
      result: {
        status: 'registry_upstream',
        httpStatus: 409,
        error_code: 'REGISTRY_ERROR',
        message: '登记凭证领取请求未能送出，请稍后重试',
      },
    };
  }

  const body = picked.data as {
    ok?: boolean;
    error_code?: string;
    data?: { claim_token?: string | null };
  } | null;
  const claimToken = body?.data?.claim_token;
  if (isHttpOk(picked.status) && claimToken) {
    return { ok: true, claimToken };
  }

  // 中心已经明确说领不到时，透传它的错误码，便于网页和排障对齐。
  const upstreamCode =
    body && typeof body.error_code === 'string' && body.error_code.trim()
      ? body.error_code.trim()
      : 'REGISTRY_ERROR';
  const message =
    upstreamCode === 'REGISTER_CLAIM_NOT_READY'
      ? '登记凭证还不能领取，请稍等片刻后重试'
      : upstreamCode === 'REGISTER_CLAIM_ENVELOPE_UNAVAILABLE'
        ? '注册中心暂时不能封存登记凭证，请稍后重试'
        : '登记凭证领取失败，请稍后重试';
  // 只记状态码和错误码：不记令牌，也不记签名。
  deps.logger.error('[register/complete] claim pickup rejected', {
    status: picked.status,
    error_code: upstreamCode,
  });
  return {
    ok: false,
    result: {
      status: 'registry_upstream',
      httpStatus: 409,
      error_code: upstreamCode,
      message,
    },
  };
}

export async function runRegisterComplete(
  command: RegisterCompleteCommand,
  deps: RegisterCompleteDeps,
): Promise<RegisterCompleteResult> {
  const handle = command.handle;
  const displayName = command.displayName;
  const email = command.email;
  const turnstileToken = command.turnstileToken;
  const compliance = command.compliance;

  const pubkeyHex = deps.nodeIdentity.getPubkeyHex();
  const privateKey = deps.nodeIdentity.getPrivateKeyHex();
  const nodeUrl = deps.nodeIdentity.getNodeUrl();
  if (!pubkeyHex || !privateKey || !nodeUrl) {
    return {
      status: 'misconfigured',
      httpStatus: 500,
      error_code: 'MISCONFIGURED',
      message: '节点密钥或 Worker B 地址未配置',
    };
  }

  if (await deps.usersRepo.isAlreadyRegistered()) {
    await deps.syncState.clear();
    return {
      status: 'already_registered',
      httpStatus: 409,
      error_code: 'ALREADY_REGISTERED',
      message: '节点已完成注册中心登记',
    };
  }

  // M33-P8-n：若上次已领取凭证但本地落库失败，直接续跑（不再打 registry）
  const pendingResume = await deps.syncState.readPending();
  if (pendingResume) {
    return finalizeLocalFromPending(deps, pendingResume, pubkeyHex, nodeUrl);
  }

  // 浏览器已经把提交结果交回来。不读里面的令牌，改由节点去领。
  if (command.browser?.phase === 'verify_result') {
    const pending = await deps.syncState.readChallengePending();
    if (!pending || !assertChallengePendingIdentityMatchesPayload(pending, pubkeyHex, nodeUrl)) {
      return {
        status: 'bad_request',
        httpStatus: 409,
        error_code: 'BOOTSTRAP_INTAKE_REQUIRED',
        message: '请先完成登记预检',
      };
    }
    const upstreamStatus = command.browser.upstreamStatus ?? 0;
    if (!isHttpOk(upstreamStatus)) {
      return {
        status: 'registry_upstream',
        httpStatus: upstreamStatus || 502,
        upstreamBody: stripRelaySecrets(command.browser.upstreamBody),
      };
    }
    let didV2: string;
    try {
      didV2 = await deps.crypto.deriveDidV2(pubkeyHex);
    } catch (err) {
      deps.logger.error('[register/complete] did_v2 derive failed', err);
      return {
        status: 'internal_error',
        httpStatus: 500,
        error_code: 'INTERNAL_ERROR',
        message: 'DID v2 派生失败',
      };
    }
    const picked = await pickupClaimForBrowserFlow(deps, pending.challenge_id);
    if (!picked.ok) return picked.result;
    const claimToken = picked.claimToken;
    return proceedAfterVerifySuccess(deps, {
      challengeId: pending.challenge_id,
      claimToken,
      didV2,
      handle,
      displayName,
      registrationEmail: email,
      compliance,
      pubkeyHex,
      nodeUrl,
    });
  }

  // 浏览器路径不再由节点代发预检或提交。
  if (!command.browser) {
    const challengeResume = await tryChallengeResume(deps, pubkeyHex, nodeUrl);
    if (challengeResume) {
      return proceedAfterVerifySuccess(deps, {
        challengeId: challengeResume.challengeId,
        claimToken: challengeResume.claimToken,
        didV2: challengeResume.didV2,
        handle,
        displayName,
        registrationEmail: email,
        compliance,
        pubkeyHex,
        nodeUrl,
      });
    }
  }

  // REG-ASYNC：若上次已受理但轮询未完成，继续轮询（勿重新 precheck）
  const acceptedResume = await deps.syncState.readAccepted();
  if (acceptedResume) {
    const identityErr = assertAcceptedIdentityMatchesEnv(acceptedResume, pubkeyHex, nodeUrl);
    if (identityErr) return identityErr;

    const polled = await pollAndClaimCredentials(deps, acceptedResume);
    if (!polled.ok) return polled.result;
    await deps.proofStore.deleteProofKv();
    const built = await buildPendingFromClaim(deps, acceptedResume, polled.data);
    if (!built.ok) return built.result;
    return writePendingFinalizeAndAck(
      deps,
      built.pending,
      acceptedResume,
      pubkeyHex,
      nodeUrl,
    );
  }

  let pubkeyRegistryB64: string;
  try {
    pubkeyRegistryB64 = deps.crypto.pubkeyToRegistryB64(pubkeyHex);
  } catch (err) {
    deps.logger.error('[register/complete] invalid ED25519_PUBLIC_KEY', err);
    return {
      status: 'misconfigured',
      httpStatus: 500,
      error_code: 'MISCONFIGURED',
      message: '节点公钥格式无效（须为 32 字节 raw hex）',
    };
  }

  const precheckBody: Record<string, string | boolean> = {
    handle,
    pubkey: pubkeyRegistryB64,
    node_url: nodeUrl,
    turnstile_token: turnstileToken,
    email,
  };
  if (command.emailVerifyToken) precheckBody.email_verify_token = command.emailVerifyToken;
  appendPrecheckCompliance(precheckBody, compliance);

  if (command.browser?.phase === 'prepare') {
    const registryUrl = await deps.registryClient.resolveRegistryUrl();
    return relayResult('precheck', registryUrl, '/api/register/precheck', precheckBody);
  }

  const pre = command.browser?.phase === 'precheck_result'
    ? { status: command.browser.upstreamStatus ?? 0, data: command.browser.upstreamBody }
    : await deps.registryClient.precheck(precheckBody);
  if (!isHttpOk(pre.status)) {
    return {
      status: 'registry_upstream',
      httpStatus: pre.status,
      upstreamBody: stripRelaySecrets(pre.data),
    };
  }

  const preData = pre.data as { ok?: boolean; data?: { challenge_id?: string; nonce?: string } };
  const challengeId = preData.data?.challenge_id;
  const nonce = preData.data?.nonce;
  if (!challengeId || !nonce) {
    return {
      status: 'registry_upstream',
      httpStatus: 502,
      error_code: 'REGISTRY_ERROR',
      message: 'precheck 未返回 challenge_id / nonce',
    };
  }

  const pubkeyFingerprint = await deps.crypto.computeFingerprint(pubkeyRegistryB64);
  const isoNow = deps.clock.nowIso();
  await deps.proofStore.writeChallenge(challengeId, nonce, pubkeyFingerprint, isoNow);

  const proofBody = `${challengeId}.${nonce}`;
  try {
    await deps.proofStore.putProofKv(proofBody);
  } catch (err) {
    deps.logger.error('[register/complete] STATE_KV proof write failed', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: 'proof 暂存失败，请稍后重试',
    };
  }

  // REG-BR-2a：precheck 成功 → 立即把 challenge_id+nonce+身份冻结到 syncState，
  // verify 阶段掉线后下次进入 runRegisterComplete 可直接走 challengeResume 续跑，不重新 precheck。
  // writeChallengePending 失败按设计 try/catch 静默（不阻断 verify 主路径）。
  try {
    const challengePending: RegistrationChallengePendingPayload = {
      challenge_id: challengeId,
      nonce,
      pubkey_hex: pubkeyHex,
      node_url: nodeUrl,
      precheck_at: isoNow,
      expires_at: new Date(
        Date.parse(isoNow) + REGISTRATION_CHALLENGE_PENDING_WINDOW_MS,
      ).toISOString(),
    };
    await deps.syncState.writeChallengePending(challengePending, isoNow);
  } catch (err) {
    deps.logger.error('[register/complete] sync_state challenge_pending write failed', err);
    // 故意不 return：挑战续跑是优化路径，不阻断正常 verify 主流程
  }

  let signatureHex: string;
  try {
    signatureHex = await deps.crypto.signChallenge(`${challengeId}.${nonce}`, privateKey);
  } catch (err) {
    deps.logger.error('[register/complete] sign failed', err);
    return {
      status: 'sign_failed',
      httpStatus: 500,
      error_code: 'SIGN_FAILED',
      message: 'challenge 签名失败',
    };
  }

  let signatureRegistryB64: string;
  try {
    signatureRegistryB64 = deps.crypto.signatureToRegistryB64(signatureHex);
  } catch (err) {
    deps.logger.error('[register/complete] signature encode failed', err);
    return {
      status: 'sign_failed',
      httpStatus: 500,
      error_code: 'SIGN_FAILED',
      message: 'challenge 签名编码失败',
    };
  }

  let didV2: string;
  try {
    didV2 = await deps.crypto.deriveDidV2(pubkeyHex);
  } catch (err) {
    deps.logger.error('[register/complete] did_v2 derive failed', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: 'DID v2 派生失败',
    };
  }

  if (command.browser?.phase === 'precheck_result') {
    const registryUrl = await deps.registryClient.resolveRegistryUrl();
    return relayResult('verify', registryUrl, '/api/register/challenge/verify', {
      challenge_id: challengeId,
      signature: signatureRegistryB64,
      did_v2: didV2,
    });
  }

  const verify = await deps.registryClient.verifyChallenge({
    challenge_id: challengeId,
    signature: signatureRegistryB64,
    did_v2: didV2,
  });
  // REG-ASYNC：成功为 202 Accepted；4xx/5xx 仍失败
  if (!isHttpOk(verify.status)) {
    return {
      status: 'registry_upstream',
      httpStatus: verify.status,
      upstreamBody: stripRelaySecrets(verify.data),
    };
  }

  const acceptData = verify.data as {
    ok?: boolean;
    data?: {
      challenge_id?: string;
      status?: string;
      claim_token?: string | null;
      poll_after_ms?: number;
      expires_at?: string;
    };
  };
  const claimToken = acceptData.data?.claim_token;
  if (!claimToken) {
    return {
      status: 'registry_upstream',
      httpStatus: 502,
      error_code: 'REGISTRY_ERROR',
      message: 'challenge/verify 未返回 claim_token（需 REG-ASYNC 注册中心）',
    };
  }

  return proceedAfterVerifySuccess(deps, {
    challengeId,
    claimToken,
    didV2,
    handle,
    displayName,
    registrationEmail: email,
    compliance,
    pubkeyHex,
    nodeUrl,
  });
}
