/**
 * 多注册中心通信路由（M9-3-3/4）：按 priority 遍历 endpoints，每候选 3×3s 重试 + 失败分类。
 *
 * M9-3-4：`registryFetch` 委托本模块；Cron health 对每个 active/unreachable endpoint 各报一次（M9-3-B4）。
 * M9-3-R1：daily-sync / health 改走 `registryRouterFetchBound` + `registered_registries`（唯一一家，自带 URL/token）。
 */

import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { buildSignatureInputV2, signMessage } from '@hailuo/shared-crypto';
import {
  lazyRewritePlainNodeApiTokens,
  openNodeApiToken,
} from './nodeApiTokenAtRest';
import {
  readRegistryEndpoints,
  saveRegistryEndpoints,
  type RegistryEndpoint,
} from './registryEndpoints';
import { readActiveIntake } from './activeIntake';
import {
  markRegisteredRegistrySuccess,
  markRegisteredRegistryUnreachable,
  migrateRegisteredRegistryIfNeeded,
  readRegisteredRegistry,
  registeredRegistryToEndpoint,
} from './registeredRegistries';
import { resolveAuthHandleForRegistry } from './registryAuthHandle';
import {
  RETRY_AFTER_CAP_MS,
  computeRegistryRetryWaitMs,
  fullJitterMs,
  parseRetryAfterMs,
} from './registryRetryWait';

/** Cron waitUntil 路径：3 次尝试、间隔 3s。 */
export const CRON_RETRY_ATTEMPTS = 3;
export const CRON_RETRY_DELAY_MS = 3_000;

/** 用户同步请求（M9-3-4 接入）：2×2s，避免 UI 长时间阻塞。 */
export const SYNC_RETRY_ATTEMPTS = 2;
export const SYNC_RETRY_DELAY_MS = 2_000;

export const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

/** NCF-REG-RETRY-1：重导出自纯模块，保持既有 import 面。 */
export {
  RETRY_AFTER_CAP_MS,
  computeRegistryRetryWaitMs,
  fullJitterMs,
  parseRetryAfterMs,
};

export type RegistryRouterProfile = 'cron' | 'sync';

export type RegistryFailureKind =
  | 'success'
  | 'retryable'
  | 'fatal'
  | 'endpoint_misconfigured';

export interface RegistryRouterFetchOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** 仅尝试指定 registry_id */
  targetRegistryId?: string;
  /** 需要 node_api_token 的端点才参与（默认 true） */
  requireToken?: boolean;
  /** cron=3×3s；sync=2×2s */
  profile?: RegistryRouterProfile;
  /** true 时由调用方自行写 outbound_events（如 Cron health 逐 endpoint 落库） */
  skipOutboundAudit?: boolean;
}

export interface RegistryRouterFetchResult {
  response: Response;
  endpoint: RegistryEndpoint;
  endpointIndex: number;
  attempts: number;
  /** M9-3-8：failover / 重试摘要，供 outbound_events.router_detail */
  router_detail: string;
  /** 是否尝试过多个 endpoint 才成功 */
  failover_switched: boolean;
}

// 中文注释：错误类抽到 registryErrors，供 registryAuthHandle 等共用，避免循环依赖
export { RegistryAllUnavailableError, RegistryFatalError } from './registryErrors';
import { RegistryAllUnavailableError, RegistryFatalError } from './registryErrors';

const ENDPOINT_MISCONFIGURED_CODES = new Set([
  'NODE_TOKEN_INVALID',
  'NODE_TOKEN_REVOKED',
  'NODE_TOKEN_MISSING',
]);

/** registry 返回 5xx 但属于业务/契约失败（重试无意义），应直接透传而非「所有中心不可用」。 */
const REGISTRY_BUSINESS_FATAL_CODES = new Set([
  'CERT_INBOUND_INTERNAL',
  'CERT_INBOUND_CHANNEL_DISABLED',
  'CERT_ESP_CHANNEL_DISABLED',
  'CERTIFY_EMAIL_REQUIRED',
  'CERTIFY_ALREADY_VERIFIED',
]);

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function randomNonceHex(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signNodeRequest(
  env: Env,
  meta: { method: string; path: string },
  body: string,
): Promise<{ 'X-Timestamp': string; 'X-Nonce': string; 'X-Signature': string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomNonceHex();
  const input = buildSignatureInputV2(meta.method, meta.path, timestamp, nonce, body);
  try {
    const signature = await signMessage(input, env.ED25519_PRIVATE_KEY);
    return {
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RegistryFatalError('REGISTRY_SIGN_FAILED', `节点请求签名失败：${reason}`);
  }
}

async function loadLegacyCredentials(
  env: Env,
  db: D1Database,
): Promise<{ token: string; userId: string } | null> {
  const { results } = await db
    .prepare(
      `SELECT key, value FROM system_config
        WHERE key IN ('node_api_token', 'owner_user_id')`,
    )
    .all<{ key: string; value: string }>();

  const map: Record<string, string> = {};
  for (const row of results ?? []) {
    map[row.key] = row.value;
  }

  const stored = map.node_api_token?.trim();
  const userId = map.owner_user_id?.trim();
  if (!stored || !userId) return null;
  // R-MSG-1d：legacy / wrap 均 open 成明文 Bearer
  const opened = await openNodeApiToken(env, stored);
  if (opened.wasLegacyPlain) {
    void lazyRewritePlainNodeApiTokens(env).catch(() => { });
  }
  return { token: opened.plain, userId };
}

/**
 * 读 D1 registry_endpoints；空则从 env.REGISTRY_URL + 既有凭证合成单元素（兼容未迁移节点）。
 */
export async function resolveRegistryEndpoints(env: Env): Promise<RegistryEndpoint[]> {
  const fromDb = await readRegistryEndpoints(resolveIdentityDb(env));
  if (fromDb.length > 0) return fromDb;

  const registryUrl = stripTrailingSlash(env.REGISTRY_URL ?? '');
  if (!registryUrl) return [];

  const legacy = await loadLegacyCredentials(env, resolveIdentityDb(env));
  if (!legacy) return [];

  const addedAt = new Date().toISOString();
  return [{
    registry_id: 'legacy-env-registry',
    registry_url: registryUrl,
    trust_pubkey: '',
    node_api_token: legacy.token,
    owner_user_id: legacy.userId,
    status: 'active',
    added_at: addedAt,
    fail_streak: 0,
  }];
}

/** 按数组顺序（priority）筛选候选 endpoint。 */
export function selectRegistryCandidates(
  endpoints: RegistryEndpoint[],
  opts?: Pick<RegistryRouterFetchOptions, 'targetRegistryId' | 'requireToken'>,
): RegistryEndpoint[] {
  const requireToken = opts?.requireToken !== false;
  const targetId = opts?.targetRegistryId?.trim();

  return endpoints.filter((endpoint, index, all) => {
    if (targetId && endpoint.registry_id !== targetId) return false;
    if (requireToken && !endpoint.node_api_token?.trim()) return false;
    // pending 无 token 已在上面跳过；unreachable 仍参与 failover 重试
    if (endpoint.status === 'pending') return false;
    // 保持原数组顺序作为 priority
    return all.indexOf(endpoint) === index;
  });
}

/**
 * @deprecated M-OPT-12：生产 daily-sync 走 `resolveRegisteredRegistryForSync`，不再按地址簿多中心 health 上报。
 * 保留供旧测试/地址簿筛选兼容。
 */
export function selectHealthReportEndpoints(endpoints: RegistryEndpoint[]): RegistryEndpoint[] {
  return endpoints.filter(
    (endpoint, index, all) =>
      (endpoint.status === 'active' || endpoint.status === 'unreachable')
      && Boolean(endpoint.node_api_token?.trim())
      && all.indexOf(endpoint) === index,
  );
}

/**
 * M9-3-R1：解析 daily-sync / health 唯一目标——只读 registered_registries（含 URL/token）。
 * 空则尝试从地址簿 [0] 回填；仍无则 null。
 */
export async function resolveRegisteredRegistryForSync(
  env: Env,
): Promise<RegistryEndpoint | null> {
  // R-MSG-1d：有 wrap secret 时把残留明文懒迁为密文
  void lazyRewritePlainNodeApiTokens(env).catch(() => { });

  let reg = await readRegisteredRegistry(resolveIdentityDb(env));
  if (!reg) {
    const endpoints = await resolveRegistryEndpoints(env);
    await migrateRegisteredRegistryIfNeeded(env, resolveIdentityDb(env), endpoints);
    reg = await readRegisteredRegistry(resolveIdentityDb(env));
  }
  return reg ? registeredRegistryToEndpoint(reg) : null;
}

/** 主注册中心：优先已登记权威表；否则地址簿 [0] / legacy。 */
export async function resolvePrimaryRegistryEndpoint(env: Env): Promise<RegistryEndpoint | null> {
  const registered = await resolveRegisteredRegistryForSync(env);
  if (registered) return registered;
  const endpoints = await resolveRegistryEndpoints(env);
  return endpoints[0] ?? null;
}

/**
 * 已登记：只认 home。
 * 还没登记成功：不拉入口，也不使用登记流程收下的接待地址。
 * 信息流、认证收件和其它已认证请求走地址簿或部署时写死的主中心。
 */
export async function resolvePrimaryRegistryUrl(env: Env): Promise<string> {
  const registered = await resolveRegisteredRegistryForSync(env);
  if (registered?.registry_url) return stripTrailingSlash(registered.registry_url);
  const endpoints = await resolveRegistryEndpoints(env);
  const first = endpoints[0]?.registry_url?.trim();
  if (first) return stripTrailingSlash(first);
  return stripTrailingSlash(env.REGISTRY_URL ?? '');
}

/**
 * 只有登记流程使用浏览器交来、节点已验签收下的接待地址。
 * 没有这份记录时返回空，调用方要求浏览器先向入口领取。本函数不拉入口。
 */
export async function resolveRegistrationRegistryUrl(env: Env): Promise<string | null> {
  const registered = await resolveRegisteredRegistryForSync(env);
  if (registered?.registry_url) return stripTrailingSlash(registered.registry_url);
  const intake = await readActiveIntake(resolveIdentityDb(env));
  const url = intake?.registry_url?.trim();
  if (!url) return null;
  return stripTrailingSlash(url);
}

/** 超时、连接失败、对方 5xx。业务 4xx 不算。连接失败在代理里收成 502。 */
export function isRegistryUnreachableStatus(status: number): boolean {
  return status === 408 || (status >= 500 && status <= 599);
}

/**
 * 登记请求打到浏览器交来、节点已验签收下的那一家。
 * 还没有这份说明时返回 409，不代拉入口。连不上也不在这里再拉。
 */
export async function withRegistrationIntakeRetry<T extends { status: number }>(
  env: Env,
  run: (registryUrl: string) => Promise<T>,
): Promise<T> {
  const url = await resolveRegistrationRegistryUrl(env);
  if (!url) {
    return {
      status: 409,
      data: {
        ok: false,
        error_code: 'BOOTSTRAP_INTAKE_REQUIRED',
        message: '请先由浏览器向入口领取接待说明',
      },
    } as unknown as T;
  }
  // 连不上时不再由节点代拉入口。浏览器自己再问一次，交来新的说明后再重试。
  return run(url);
}

/** HTTP 层失败分类（不含网络异常）。 */
export function classifyRegistryHttpFailure(
  status: number,
  errorCode?: string | null,
): RegistryFailureKind {
  if (status >= 200 && status < 300) return 'success';

  const code = errorCode?.trim().toUpperCase() ?? '';
  if (status === 400) return 'fatal';
  if (REGISTRY_BUSINESS_FATAL_CODES.has(code)) return 'fatal';
  if (status === 401 && ENDPOINT_MISCONFIGURED_CODES.has(code)) {
    return 'endpoint_misconfigured';
  }
  if (status === 401 || status === 403) return 'fatal';
  if (status === 502 || status === 503 || status === 504) return 'retryable';
  if (status >= 500) return 'retryable';
  if (status === 408 || status === 429) return 'retryable';
  // 404 等客户端错误：视为 fatal，避免用错误 path 刷遍所有中心
  if (status >= 400 && status < 500) return 'fatal';
  return 'retryable';
}

/** 网络/超时异常分类。 */
export function classifyRegistryNetworkFailure(_err: unknown): RegistryFailureKind {
  return 'retryable';
}

function retryPlan(profile: RegistryRouterProfile): { attempts: number; delayMs: number } {
  if (profile === 'sync') {
    return { attempts: SYNC_RETRY_ATTEMPTS, delayMs: SYNC_RETRY_DELAY_MS };
  }
  return { attempts: CRON_RETRY_ATTEMPTS, delayMs: CRON_RETRY_DELAY_MS };
}

export function sleepMs(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseRegistryErrorCode(res: Response): Promise<string | null> {
  try {
    const clone = res.clone();
    const json = (await clone.json()) as { error_code?: string };
    return json.error_code?.trim() ?? null;
  } catch {
    return null;
  }
}

async function patchEndpoint(
  env: Env,
  db: D1Database,
  registryId: string,
  patch: Partial<RegistryEndpoint>,
): Promise<void> {
  const endpoints = await readRegistryEndpoints(db);
  const idx = endpoints.findIndex((e) => e.registry_id === registryId);
  if (idx < 0) return;
  endpoints[idx] = { ...endpoints[idx], ...patch };
  await saveRegistryEndpoints(env, db, endpoints);
}

async function markEndpointSuccess(env: Env, db: D1Database, registryId: string): Promise<void> {
  const now = new Date().toISOString();
  await patchEndpoint(env, db, registryId, {
    last_ok_at: now,
    fail_streak: 0,
    status: 'active',
  });
  const registered = await readRegisteredRegistry(db);
  if (registered?.registry_id === registryId) {
    await markRegisteredRegistrySuccess(db);
  }
}

/** M-DS-2b：daily-sync 成功后恢复 endpoint 为 active。 */
export async function markRegistryEndpointDailySyncSuccess(
  env: Env,
  db: D1Database,
  registryId: string,
): Promise<void> {
  await markEndpointSuccess(env, db, registryId);
}

/** M-DS-2b：连续 2 日日同步失败后标 unreachable。 */
export async function markRegistryEndpointUnreachable(
  env: Env,
  db: D1Database,
  registryId: string,
): Promise<void> {
  const endpoints = await readRegistryEndpoints(db);
  const current = endpoints.find((e) => e.registry_id === registryId);
  const now = new Date().toISOString();
  await patchEndpoint(env, db, registryId, {
    last_fail_at: now,
    fail_streak: (current?.fail_streak ?? 0) + 1,
    status: 'unreachable',
  });
  const registered = await readRegisteredRegistry(db);
  if (registered?.registry_id === registryId) {
    await markRegisteredRegistryUnreachable(db);
  }
}

async function markEndpointRetryExhausted(env: Env, db: D1Database, registryId: string): Promise<void> {
  const endpoints = await readRegistryEndpoints(db);
  const current = endpoints.find((e) => e.registry_id === registryId);
  const now = new Date().toISOString();
  const nextStreak = (current?.fail_streak ?? 0) + 1;
  await patchEndpoint(env, db, registryId, {
    last_fail_at: now,
    fail_streak: nextStreak,
    status: 'unreachable',
  });
  const registered = await readRegisteredRegistry(db);
  if (registered?.registry_id === registryId) {
    await markRegisteredRegistryUnreachable(db);
  }
}

async function markEndpointMisconfigured(env: Env, db: D1Database, registryId: string): Promise<void> {
  const now = new Date().toISOString();
  const endpoints = await readRegistryEndpoints(db);
  const current = endpoints.find((e) => e.registry_id === registryId);
  await patchEndpoint(env, db, registryId, {
    last_fail_at: now,
    fail_streak: (current?.fail_streak ?? 0) + 1,
    status: 'pending',
  });
}

async function fetchRegistryEndpointOnce(
  env: Env,
  endpoint: RegistryEndpoint,
  path: string,
  opts: RegistryRouterFetchOptions,
): Promise<Response> {
  const stored = endpoint.node_api_token?.trim();
  const userId = endpoint.owner_user_id?.trim();
  if (!stored || !userId) {
    throw new RegistryFatalError('REGISTRY_ENDPOINT_NO_TOKEN', '注册中心 endpoint 缺少 node_api_token');
  }

  // R-MSG-1d：Bearer 只用内存明文；落盘密文在此 unwrap
  let token: string;
  try {
    const opened = await openNodeApiToken(env, stored);
    token = opened.plain;
    if (opened.wasLegacyPlain) {
      void lazyRewritePlainNodeApiTokens(env).catch(() => { });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RegistryFatalError('REGISTRY_ENDPOINT_NO_TOKEN', msg);
  }

  // NCF-HS-2：鉴权 Handle 与 token 双绑定；百分号编码满足 Header ByteString（中文 handle）
  const authHandle = await resolveAuthHandleForRegistry(env);
  const handleHeader = encodeURIComponent(authHandle);

  const bodyForSig = opts.body ?? '';
  const methodForSig = (opts.method ?? 'GET').toUpperCase();
  const sigHeaders = await signNodeRequest(env, { method: methodForSig, path }, bodyForSig);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_FETCH_TIMEOUT_MS);

  try {
    return await fetch(`${endpoint.registry_url}${path}`, {
      method: opts.method ?? 'GET',
      body: opts.body,
      headers: {
        'Content-Type': 'application/json',
        'X-Hailuo-Node-User-Id': userId,
        'X-Hailuo-Node-Handle': handleHeader,
        'Authorization': `Bearer ${token}`,
        ...sigHeaders,
        ...(opts.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildRouterDetail(trail: string[], successNote?: string): string {
  const parts = [...trail];
  if (successNote) parts.push(successNote);
  return parts.join('; ').slice(0, 500);
}

/**
 * M9-3-R1：绑定已提供的 endpoint（通常来自 registered_registries）直连，
 * 不从 registry_endpoints 再查 token；无 failover 到其它中心。
 */
export async function registryRouterFetchBound(
  env: Env,
  path: string,
  endpoint: RegistryEndpoint,
  opts: Omit<RegistryRouterFetchOptions, 'targetRegistryId'> = {},
): Promise<RegistryRouterFetchResult> {
  const profile = opts.profile ?? 'cron';
  const { attempts: maxAttempts, delayMs } = retryPlan(profile);
  const failures: string[] = [];
  const failoverTrail: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res: Response;
    try {
      res = await fetchRegistryEndpointOnce(env, endpoint, path, opts);
    } catch (err) {
      if (err instanceof RegistryFatalError) throw err;

      const kind = classifyRegistryNetworkFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${endpoint.registry_id}:network:${message}`);
      failoverTrail.push(`${endpoint.registry_id}:network:attempt_${attempt}`);

      if (kind === 'retryable' && attempt < maxAttempts) {
        // NCF-REG-RETRY-1：网络失败无 Retry-After → Full Jitter
        await sleepMs(computeRegistryRetryWaitMs({ profileDelayMs: delayMs }));
        continue;
      }

      if (attempt >= maxAttempts) {
        try {
          await markEndpointRetryExhausted(env, resolveIdentityDb(env), endpoint.registry_id);
        } catch (bookkeepingErr) {
          console.error('[registry] 重试耗尽后回写 endpoint 失败', bookkeepingErr);
        }
        failoverTrail.push(`${endpoint.registry_id}:exhausted_${maxAttempts}`);
      }
      break;
    }

    if (res.ok) {
      // 中文注释：回写 endpoint（含明文凭证 seal）失败不能丢掉已经成功的中心响应
      try {
        await markEndpointSuccess(env, resolveIdentityDb(env), endpoint.registry_id);
      } catch (bookkeepingErr) {
        console.error('[registry] 成功后回写 endpoint 失败，仍返回中心响应', bookkeepingErr);
      }
      const successNote = `${endpoint.registry_id}:ok:attempt_${attempt}`;
      return {
        response: res,
        endpoint,
        endpointIndex: 0,
        attempts: attempt,
        router_detail: buildRouterDetail(failoverTrail, successNote),
        failover_switched: false,
      };
    }

    const errorCode = await parseRegistryErrorCode(res);
    const kind = classifyRegistryHttpFailure(res.status, errorCode);
    failures.push(`${endpoint.registry_id}:${res.status}:${errorCode ?? 'unknown'}`);
    failoverTrail.push(`${endpoint.registry_id}:${res.status}:${errorCode ?? 'unknown'}:attempt_${attempt}`);

    if (kind === 'fatal') {
      throw new RegistryFatalError(
        errorCode ?? `HTTP_${res.status}`,
        `注册中心拒绝请求 ${res.status}${errorCode ? ` (${errorCode})` : ''}`,
      );
    }

    if (kind === 'endpoint_misconfigured') {
      await markEndpointMisconfigured(env, resolveIdentityDb(env), endpoint.registry_id);
      failoverTrail.push(`${endpoint.registry_id}:misconfigured:${errorCode ?? 'unknown'}`);
      break;
    }

    if (kind === 'retryable' && attempt < maxAttempts) {
      // NCF-REG-RETRY-1：优先 Retry-After，否则 Full Jitter
      await sleepMs(
        computeRegistryRetryWaitMs({
          profileDelayMs: delayMs,
          retryAfterHeader: res.headers.get('Retry-After'),
        }),
      );
      continue;
    }

    if (attempt >= maxAttempts) {
      try {
        await markEndpointRetryExhausted(env, resolveIdentityDb(env), endpoint.registry_id);
      } catch (bookkeepingErr) {
        console.error('[registry] 重试耗尽后回写 endpoint 失败', bookkeepingErr);
      }
      failoverTrail.push(`${endpoint.registry_id}:exhausted_${maxAttempts}`);
    }
    break;
  }

  throw new RegistryAllUnavailableError(
    failures.length > 0 ? failures.join('; ') : '已登记注册中心不可用',
  );
}

/**
 * 按 priority 遍历 registry endpoints，每候选最多 cron 3 次 / sync 2 次后 failover。
 * 重试等待：NCF-REG-RETRY-1 Full Jitter + 优先 `Retry-After`（封顶 30s）。
 */
export async function registryRouterFetch(
  env: Env,
  path: string,
  opts: RegistryRouterFetchOptions = {},
): Promise<RegistryRouterFetchResult> {
  const profile = opts.profile ?? 'cron';
  const { attempts: maxAttempts, delayMs } = retryPlan(profile);

  const allEndpoints = await resolveRegistryEndpoints(env);
  const candidates = selectRegistryCandidates(allEndpoints, opts);

  if (candidates.length === 0) {
    const legacy = await loadLegacyCredentials(env, resolveIdentityDb(env));
    if (!legacy) {
      throw new Error(
        '节点尚未注册：system_config 中缺少 node_api_token / owner_user_id，' +
        '请先完成注册中心登记',
      );
    }
    throw new RegistryAllUnavailableError('无可用注册中心 endpoint（均需 token 且非 pending）');
  }

  const failures: string[] = [];
  const failoverTrail: string[] = [];
  let endpointOrdinal = 0;

  for (const endpoint of candidates) {
    const endpointIndex = allEndpoints.findIndex((e) => e.registry_id === endpoint.registry_id);
    if (endpointOrdinal > 0) {
      failoverTrail.push(`failover->${endpoint.registry_id}`);
    }
    endpointOrdinal += 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res: Response;
      try {
        res = await fetchRegistryEndpointOnce(env, endpoint, path, opts);
      } catch (err) {
        if (err instanceof RegistryFatalError) throw err;

        const kind = classifyRegistryNetworkFailure(err);
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${endpoint.registry_id}:network:${message}`);
        failoverTrail.push(`${endpoint.registry_id}:network:attempt_${attempt}`);

        if (kind === 'retryable' && attempt < maxAttempts) {
          await sleepMs(computeRegistryRetryWaitMs({ profileDelayMs: delayMs }));
          continue;
        }

        if (attempt >= maxAttempts) {
          await markEndpointRetryExhausted(env, resolveIdentityDb(env), endpoint.registry_id);
          failoverTrail.push(`${endpoint.registry_id}:exhausted_${maxAttempts}`);
        }
        break;
      }

      if (res.ok) {
        await markEndpointSuccess(env, resolveIdentityDb(env), endpoint.registry_id);
        const successNote = `${endpoint.registry_id}:ok:attempt_${attempt}`;
        return {
          response: res,
          endpoint,
          endpointIndex: endpointIndex >= 0 ? endpointIndex : 0,
          attempts: attempt,
          router_detail: buildRouterDetail(failoverTrail, successNote),
          failover_switched: endpointOrdinal > 1,
        };
      }

      const errorCode = await parseRegistryErrorCode(res);
      const kind = classifyRegistryHttpFailure(res.status, errorCode);
      failures.push(`${endpoint.registry_id}:${res.status}:${errorCode ?? 'unknown'}`);
      failoverTrail.push(`${endpoint.registry_id}:${res.status}:${errorCode ?? 'unknown'}:attempt_${attempt}`);

      if (kind === 'fatal') {
        throw new RegistryFatalError(
          errorCode ?? `HTTP_${res.status}`,
          `注册中心拒绝请求 ${res.status}${errorCode ? ` (${errorCode})` : ''}`,
        );
      }

      if (kind === 'endpoint_misconfigured') {
        await markEndpointMisconfigured(env, resolveIdentityDb(env), endpoint.registry_id);
        failoverTrail.push(`${endpoint.registry_id}:misconfigured:${errorCode ?? 'unknown'}`);
        console.warn('[registryRouter] endpoint 凭证无效，标记 pending 并切换下一候选', {
          registry_id: endpoint.registry_id,
          error_code: errorCode,
        });
        break;
      }

      if (kind === 'retryable' && attempt < maxAttempts) {
        await sleepMs(
          computeRegistryRetryWaitMs({
            profileDelayMs: delayMs,
            retryAfterHeader: res.headers.get('Retry-After'),
          }),
        );
        continue;
      }

      if (attempt >= maxAttempts) {
        await markEndpointRetryExhausted(env, resolveIdentityDb(env), endpoint.registry_id);
        failoverTrail.push(`${endpoint.registry_id}:exhausted_${maxAttempts}`);
      }
      break;
    }
  }

  throw new RegistryAllUnavailableError(
    failures.length > 0 ? failures.join('; ') : '所有注册中心均不可用',
  );
}
