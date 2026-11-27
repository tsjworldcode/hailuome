/**
 * NCF-2C：生产 adapter — Env 只出现在本文件。
 * 防身份关联：日志不得输出完整 email / phone / node_api_token / 私钥。
 * R-MSG-3b-1：登记 INSERT users 不再写 phone。
 * SPILL-1c-node-a：人口学 PATCH 同步已下架。
 */
import { resolveIdentityDb } from '../../../db/bindings';
import {
  computePubkeyFingerprint,
  signMessage,
  ed25519PubkeyHexToRegistryBase64,
  ed25519SignatureHexToRegistryBase64,
  pubkeyHexToDidV2,
} from '@hailuo/shared-crypto';
import {
  PUBLIC_PROFILE_KV_KEY,
  REGISTRY_PROOF_KV_KEY,
  REGISTRY_PROOF_KV_TTL_SEC,
} from '@hailuo/shared-types';
import type { Env } from '../../../env';
import { resolveCertInboundPresentation } from '../../../handlers/registryCertInbound';
import { syncCanonicalWorkerBUrlKv } from '../../../handlers/publicProfileKv';
import { syncRegistryEndpointsToKv } from '../../../handlers/registryEndpointsKvSync';
import { prepareDailySyncSchedulePersist } from '../../../lib/dailySyncScheduleConfig';
import {
  canonicalizeHandleQualified,
  formatQualifiedHandle,
} from '../../../lib/handleQualified';
import { invalidateLocalPublicBaseUrlCache } from '../../../lib/localPublicBaseUrl';
import { migrateOwnerWrappedVaultFpToHandle } from '../../../lib/ownerVaultKey';
import { persistRegistryEndpoints0 } from '../../../lib/registryEndpoints';
import { resolveRegistrationRegistryUrl, withRegistrationIntakeRetry } from '../../../lib/registryRouter';
import { hailuoClientIpHeaders } from '../../../lib/registrationClientIp';
import type { RegisterCompleteDeps, RegistryClientResponse } from '../types';
import {
  REGISTRATION_SYNC_PHASE_REGISTRY_ACCEPTED,
  REGISTRATION_SYNC_PHASE_REGISTRY_CHALLENGE_PENDING,
  REGISTRATION_SYNC_PHASE_REGISTRY_VERIFIED,
  REGISTRATION_SYNC_SCOPE_HOME,
  parseRegistrationAcceptedPayload,
  parseRegistrationChallengePendingPayload,
  parseRegistrationSyncPayload,
} from '../registrationSyncState';

const REGISTRY_TIMEOUT_MS = 10_000;

async function proxyPost(
  registryUrl: string,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<RegistryClientResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${registryUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data: unknown = await upstream.json();
    return { status: upstream.status, data };
  } catch (err) {
    console.error(`[register/proxy] ${path} failed`, err);
    return {
      status: 502,
      data: { ok: false, error_code: 'REGISTRY_UNAVAILABLE', message: 'registry is unreachable' },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * REG-ASYNC-FIX：带 Bearer 的 GET；失败日志只写 pathname，禁止把 claim 打进 query 日志。
 */
async function proxyGetBearer(
  registryUrl: string,
  pathname: string,
  bearerToken: string,
): Promise<RegistryClientResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${registryUrl}${pathname}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: controller.signal,
    });
    const data: unknown = await upstream.json();
    return { status: upstream.status, data };
  } catch (err) {
    // 中文注释：只记 pathname，永不记带 claim 的 URL
    console.error(`[register/proxy] GET ${pathname} failed`, err);
    return {
      status: 502,
      data: { ok: false, error_code: 'REGISTRY_UNAVAILABLE', message: 'registry is unreachable' },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** REG-ASYNC-FIX：ack 用 Bearer；失败同样只记 pathname */
async function proxyPostBearer(
  registryUrl: string,
  pathname: string,
  bearerToken: string,
  body: unknown = {},
): Promise<RegistryClientResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${registryUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data: unknown = await upstream.json();
    return { status: upstream.status, data };
  } catch (err) {
    console.error(`[register/proxy] POST ${pathname} failed`, err);
    return {
      status: 502,
      data: { ok: false, error_code: 'REGISTRY_UNAVAILABLE', message: 'registry is unreachable' },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createProductionRegisterCompleteDeps(
  env: Env,
  clientIp: string | null = null,
): RegisterCompleteDeps {
  // 只给预检和提交。轮询 status 与 ack 不带客户地址。
  const clientIpHeaders = hailuoClientIpHeaders(clientIp);
  return {
    nodeIdentity: {
      getPubkeyHex: () => env.ED25519_PUBLIC_KEY ?? null,
      getPrivateKeyHex: () => env.ED25519_PRIVATE_KEY ?? null,
      getNodeUrl: () => env.WORKER_B_URL ?? null,
    },
    usersRepo: {
      async isAlreadyRegistered() {
        // 以中心登记身份为准：本地 users 行只是站点公开资料，清掉登记后不应再报 ALREADY_REGISTERED。
        const row = await resolveIdentityDb(env)
          .prepare(`SELECT value FROM system_config WHERE key = 'owner_user_id' LIMIT 1`)
          .first<{ value: string }>()
          .catch(() => null);
        return Boolean(row?.value?.trim());
      },
      async persistHomeRegistration(input) {
        const schedulePersist = await prepareDailySyncSchedulePersist(
          env,
          input.userId,
          input.suggestedDailySyncSecond,
          input.nowIso,
          { route: 'register/complete' },
          input.syncIntervalDays,
        );

        // R-MSG-1d：登记落盘即 wrap
        const { prepareNodeApiTokenForDb } = await import('../../../lib/nodeApiTokenAtRest');
        const sealedToken = await prepareNodeApiTokenForDb(env, input.nodeApiToken);

        const homeCompleteStmts = [
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('node_api_token', ?, ?)`,
          ).bind(sealedToken, input.nowIso),
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('owner_user_id', ?, ?)`,
          ).bind(input.userId, input.nowIso),
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('did_v2', ?, ?)`,
          ).bind(input.didV2, input.nowIso),
          // M7-30g-1：登记即写入公开基址 SSOT，与 users.worker_b_url 双写
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('worker_b_url', ?, ?)`,
          ).bind(input.nodeUrl, input.nowIso),
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('node_url', ?, ?)`,
          ).bind(input.nodeUrl, input.nowIso),
          ...schedulePersist.statements,
          // M7-34：写入登记邮箱（站主私人数据，仅本人可见）
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO users(handle, display_name, pubkey, worker_b_url, registration_email, created_at) VALUES(?, ?, ?, ?, ?, ?)`,
          ).bind(
            input.handle,
            input.displayName,
            input.pubkeyHex,
            input.nodeUrl,
            input.registrationEmail,
            input.nowIso,
          ),
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('register_terms_version', ?, ?)`,
          ).bind(input.compliance.terms_version, input.nowIso),
        ];
        if (input.handleQualified) {
          homeCompleteStmts.push(
            resolveIdentityDb(env).prepare(
              `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('handle_qualified', ?, ?)`,
            ).bind(input.handleQualified, input.nowIso),
          );
        }
        await resolveIdentityDb(env).batch([
          ...homeCompleteStmts,
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('register_terms_accepted_at', ?, ?)`,
          ).bind(input.compliance.terms_accepted_at, input.nowIso),
        ]);
        // VAULT-PRE-REG-KEY-2：登记前若已用公钥指纹键写过外层，同步迁到 users.handle
        try {
          await migrateOwnerWrappedVaultFpToHandle(env, input.handle);
        } catch {
          console.error('[register/complete] vault key migrate fp→handle failed');
        }
      },
    },
    proofStore: {
      async writeChallenge(challengeId, nonce, fingerprint, nowIso) {
        await resolveIdentityDb(env).batch([
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_challenge_id', ?, ?)`,
          ).bind(challengeId, nowIso),
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_nonce', ?, ?)`,
          ).bind(nonce, nowIso),
          resolveIdentityDb(env).prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_pubkey_fingerprint', ?, ?)`,
          ).bind(fingerprint, nowIso),
        ]);
      },
      async putProofKv(proofBody) {
        await env.STATE_KV.put(REGISTRY_PROOF_KV_KEY, proofBody, {
          expirationTtl: REGISTRY_PROOF_KV_TTL_SEC,
        });
      },
      async deleteProofKv() {
        await env.STATE_KV.delete(REGISTRY_PROOF_KV_KEY).catch((err) => {
          console.error('[register/complete] STATE_KV proof cleanup failed', err);
        });
      },
    },
    registryClient: {
      resolveRegistryUrl: async () => {
        const url = await resolveRegistrationRegistryUrl(env);
        if (!url) {
          throw new Error('BOOTSTRAP_INTAKE_REQUIRED');
        }
        return url;
      },
      async precheck(body) {
        return withRegistrationIntakeRetry(env, (registryUrl) =>
          proxyPost(registryUrl, '/api/register/precheck', body, clientIpHeaders),
        );
      },
      async verifyChallenge(body) {
        return withRegistrationIntakeRetry(env, (registryUrl) =>
          proxyPost(registryUrl, '/api/register/challenge/verify', body, clientIpHeaders),
        );
      },
      async getChallengeStatus(challengeId, claimToken) {
        const pathname = `/api/register/challenge/${encodeURIComponent(challengeId)}/status`;
        return withRegistrationIntakeRetry(env, (registryUrl) =>
          proxyGetBearer(registryUrl, pathname, claimToken),
        );
      },
      async ackChallenge(challengeId, claimToken) {
        const pathname = `/api/register/challenge/${encodeURIComponent(challengeId)}/ack`;
        return withRegistrationIntakeRetry(env, (registryUrl) =>
          proxyPostBearer(registryUrl, pathname, claimToken, {}),
        );
      },
      async pickupClaim(challengeId) {
        const registryUrl = await resolveRegistrationRegistryUrl(env);
        if (!registryUrl) throw new Error('BOOTSTRAP_INTAKE_REQUIRED');
        const privateKey = env.ED25519_PRIVATE_KEY ?? '';
        const signatureHex = await signMessage(
          `hailuo-register-claim-pickup.${challengeId}`,
          privateKey,
        );
        const signature = ed25519SignatureHexToRegistryBase64(signatureHex);
        return proxyPost(
          registryUrl,
          `/api/register/challenge/${encodeURIComponent(challengeId)}/claim-pickup`,
          { signature },
        );
      },
    },
    crypto: {
      pubkeyToRegistryB64: (pubkeyHex) => ed25519PubkeyHexToRegistryBase64(pubkeyHex),
      signatureToRegistryB64: (signatureHex) => ed25519SignatureHexToRegistryBase64(signatureHex),
      computeFingerprint: (pubkeyRegistryB64) => computePubkeyFingerprint(pubkeyRegistryB64),
      signChallenge: (message, privateKeyHex) => signMessage(message, privateKeyHex),
      deriveDidV2: (pubkeyHex) => pubkeyHexToDidV2(pubkeyHex),
    },
    endpointsPersist: {
      async persistAndSyncKv(input) {
        const registryUrl = await resolveRegistrationRegistryUrl(env);
        if (!registryUrl) throw new Error('BOOTSTRAP_INTAKE_REQUIRED');
        await persistRegistryEndpoints0(
          env,
          resolveIdentityDb(env),
          input.identity,
          input.signature,
          input.userId,
          input.nodeApiToken,
          input.nowIso,
          registryUrl,
        );
        await syncRegistryEndpointsToKv(env);
      },
    },
    syncState: {
      async readPending() {
        const row = await resolveIdentityDb(env).prepare(
          `SELECT phase, payload_json FROM registration_sync_state WHERE scope = ? LIMIT 1`,
        )
          .bind(REGISTRATION_SYNC_SCOPE_HOME)
          .first<{ phase: string; payload_json: string }>()
          .catch(() => null);
        if (!row || row.phase !== REGISTRATION_SYNC_PHASE_REGISTRY_VERIFIED) return null;
        const parsed = parseRegistrationSyncPayload(row.payload_json);
        if (!parsed) return null;
        // R-MSG-1d：暂存密文解出明文供 finalize 使用
        const { openNodeApiToken } = await import('../../../lib/nodeApiTokenAtRest');
        const opened = await openNodeApiToken(env, parsed.node_api_token);
        return { ...parsed, node_api_token: opened.plain };
      },
      async writePending(payload, nowIso) {
        const { prepareNodeApiTokenForDb } = await import('../../../lib/nodeApiTokenAtRest');
        const sealedPayload = {
          ...payload,
          node_api_token: await prepareNodeApiTokenForDb(env, payload.node_api_token),
        };
        // 中文注释：不写 email；payload 含 token（已 wrap），仅本表暂存
        await resolveIdentityDb(env).prepare(
          `INSERT OR REPLACE INTO registration_sync_state(scope, phase, payload_json, created_at, updated_at)
           VALUES(?, ?, ?, COALESCE((SELECT created_at FROM registration_sync_state WHERE scope = ?), ?), ?)`,
        )
          .bind(
            REGISTRATION_SYNC_SCOPE_HOME,
            REGISTRATION_SYNC_PHASE_REGISTRY_VERIFIED,
            JSON.stringify(sealedPayload),
            REGISTRATION_SYNC_SCOPE_HOME,
            nowIso,
            nowIso,
          )
          .run();
      },
      async readAccepted() {
        const row = await resolveIdentityDb(env).prepare(
          `SELECT phase, payload_json FROM registration_sync_state WHERE scope = ? LIMIT 1`,
        )
          .bind(REGISTRATION_SYNC_SCOPE_HOME)
          .first<{ phase: string; payload_json: string }>()
          .catch(() => null);
        if (!row || row.phase !== REGISTRATION_SYNC_PHASE_REGISTRY_ACCEPTED) return null;
        return parseRegistrationAcceptedPayload(row.payload_json);
      },
      async writeAccepted(payload, nowIso) {
        // 中文注释：payload 须含调用方传入的 pubkey_hex + node_url（冻结身份）
        await resolveIdentityDb(env).prepare(
          `INSERT OR REPLACE INTO registration_sync_state(scope, phase, payload_json, created_at, updated_at)
           VALUES(?, ?, ?, COALESCE((SELECT created_at FROM registration_sync_state WHERE scope = ?), ?), ?)`,
        )
          .bind(
            REGISTRATION_SYNC_SCOPE_HOME,
            REGISTRATION_SYNC_PHASE_REGISTRY_ACCEPTED,
            JSON.stringify(payload),
            REGISTRATION_SYNC_SCOPE_HOME,
            nowIso,
            nowIso,
          )
          .run();
      },
      // REG-BR-2a：precheck 成功 → verify 未完成时的续跑 phase
      async readChallengePending() {
        const row = await resolveIdentityDb(env).prepare(
          `SELECT phase, payload_json FROM registration_sync_state WHERE scope = ? LIMIT 1`,
        )
          .bind(REGISTRATION_SYNC_SCOPE_HOME)
          .first<{ phase: string; payload_json: string }>()
          .catch(() => null);
        if (!row || row.phase !== REGISTRATION_SYNC_PHASE_REGISTRY_CHALLENGE_PENDING) return null;
        return parseRegistrationChallengePendingPayload(row.payload_json);
      },
      async writeChallengePending(payload, nowIso) {
        // 中文注释：INSERT OR REPLACE 覆盖式；与 accepted 同 scope，写入即覆盖 challenge_pending
        await resolveIdentityDb(env).prepare(
          `INSERT OR REPLACE INTO registration_sync_state(scope, phase, payload_json, created_at, updated_at)
           VALUES(?, ?, ?, COALESCE((SELECT created_at FROM registration_sync_state WHERE scope = ?), ?), ?)`,
        )
          .bind(
            REGISTRATION_SYNC_SCOPE_HOME,
            REGISTRATION_SYNC_PHASE_REGISTRY_CHALLENGE_PENDING,
            JSON.stringify(payload),
            REGISTRATION_SYNC_SCOPE_HOME,
            nowIso,
            nowIso,
          )
          .run();
      },
      async clear() {
        await resolveIdentityDb(env).prepare(`DELETE FROM registration_sync_state WHERE scope = ?`)
          .bind(REGISTRATION_SYNC_SCOPE_HOME)
          .run()
          .catch((err) => {
            console.error('[register/complete] sync_state clear failed', err);
          });
      },
    },
    publicProfile: {
      async putOwnerSnapshot(profile) {
        await env.STATE_KV.put(PUBLIC_PROFILE_KV_KEY, JSON.stringify(profile)).catch((err) => {
          console.error('[register/complete] public profile KV sync failed', err);
        });
      },
      async syncCanonicalWorkerBUrl(nodeUrl) {
        await syncCanonicalWorkerBUrlKv(env, nodeUrl).catch((err) => {
          console.error('[register/complete] canonical worker_b_url KV sync failed', err);
        });
      },
      invalidateLocalBaseUrlCache: () => invalidateLocalPublicBaseUrlCache(),
    },
    certInbound: {
      async resolvePresentation() {
        try {
          return await resolveCertInboundPresentation(env);
        } catch {
          return null;
        }
      },
    },
    handleFormat: {
      canonicalizeQualified: (raw) => canonicalizeHandleQualified(raw),
      formatQualified: (local, registryId) => formatQualifiedHandle(local, registryId),
    },
    clock: { nowIso: () => new Date().toISOString() },
    logger: {
      error: (msg, detail) =>
        detail === undefined ? console.error(msg) : console.error(msg, detail),
    },
  };
}
