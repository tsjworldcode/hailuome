/**
 * M8-13 · CI 稳定部署身份（同一 Cloudflare 账号 + 槽位 → 同一组 D1/KV/Worker 名）
 *
 * 避免每次 Run / 每次 push 随机组码导致重复建库撞 Free D1 上限。
 *
 * 优先级：
 * 1. CI_DEPLOY_IDENTITY_JSON（完整覆盖）
 * 2. 由 CLOUDFLARE_ACCOUNT_ID + HAILUO_NODE_SLOT（默认 1）确定性派生
 *
 * 运行自检：node scripts/ci-stable-identity.mjs
 */
import { createHash } from 'node:crypto';

const HANDLE_PREFIX = 'hailuo_';
const DEFAULT_OWNER_LOGIN_USERNAME = 'admin';
const DEFAULT_OWNER_LOGIN_PASSWORD = 'admin';

export function hexHash(seed, len) {
  return createHash('sha256').update(String(seed), 'utf8').digest('hex').slice(0, len);
}

function resourceNameId(resourceId) {
  return resourceId.slice(0, 28);
}

export function buildStableIdentity(accountId, slot = '1') {
  if (!accountId) throw new Error('buildStableIdentity 需要 accountId');
  const base = `hailuo-node:${accountId}:${slot}`;
  const deployGroupCode = hexHash(`${base}:group`, 6);
  const workerAResourceId = hexHash(`${base}:worker-a`, 32);
  const workerBResourceId = hexHash(`${base}:worker-b`, 32);
  const pagesResourceId = hexHash(`${base}:pages`, 32);
  return {
    DEPLOY_GROUP_CODE: deployGroupCode,
    WORKER_A_RESOURCE_ID: workerAResourceId,
    WORKER_B_RESOURCE_ID: workerBResourceId,
    PAGES_RESOURCE_ID: pagesResourceId,
    WORKER_A_NAME: `hailuo-worker-a-${deployGroupCode}-${resourceNameId(workerAResourceId)}`,
    WORKER_B_NAME: `hailuo-worker-b-${deployGroupCode}-${resourceNameId(workerBResourceId)}`,
    PAGES_PROJECT_NAME: `hailuo-web-${deployGroupCode}-${resourceNameId(pagesResourceId)}`,
    // 与本地 generate-deploy-identity 同长：hailuo_ + 10 hex（总长 17，够区分且不冗长）；
    // 同一账号 + 槽位仍确定性不变（换账号或 HAILUO_NODE_SLOT 才会变）
    BOOTSTRAP_HANDLE: `${HANDLE_PREFIX}${hexHash(`${base}:handle`, 10)}`,
    OWNER_LOGIN_USERNAME: DEFAULT_OWNER_LOGIN_USERNAME,
    OWNER_LOGIN_PASSWORD: DEFAULT_OWNER_LOGIN_PASSWORD,
    identity_source: 'stable_hash',
    HAILUO_NODE_SLOT: String(slot),
  };
}

export function resolveCiIdentity({ accountId, slot, identityJson } = {}) {
  if (identityJson) {
    const raw = typeof identityJson === 'string' ? JSON.parse(identityJson) : identityJson;
    if (!raw.WORKER_A_NAME || !raw.WORKER_B_NAME || !raw.PAGES_PROJECT_NAME || !raw.DEPLOY_GROUP_CODE) {
      throw new Error('CI_DEPLOY_IDENTITY_JSON 缺少 WORKER_*_NAME / PAGES_PROJECT_NAME / DEPLOY_GROUP_CODE');
    }
    return {
      OWNER_LOGIN_USERNAME: DEFAULT_OWNER_LOGIN_USERNAME,
      OWNER_LOGIN_PASSWORD: DEFAULT_OWNER_LOGIN_PASSWORD,
      ...raw,
      identity_source: 'CI_DEPLOY_IDENTITY_JSON',
    };
  }
  const sid = accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!sid) throw new Error('resolveCiIdentity 需要 CLOUDFLARE_ACCOUNT_ID 或 CI_DEPLOY_IDENTITY_JSON');
  return buildStableIdentity(sid, slot || process.env.HAILUO_NODE_SLOT || '1');
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('ci-stable-identity.mjs') || process.argv[1].includes('ci-stable-identity'));

if (isMain) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '00000000000000000000000000000000';
  const a = buildStableIdentity(accountId, '1');
  const b = buildStableIdentity(accountId, '1');
  if (a.DEPLOY_GROUP_CODE !== b.DEPLOY_GROUP_CODE) {
    console.error('stable identity 非确定性');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(a, null, 2) + '\n');
}
