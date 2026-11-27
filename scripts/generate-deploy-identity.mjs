/**
 * 生成部署身份信息，stdout 输出 JSON，勿提交生成结果。
 *
 * 派生优先级：
 * 1. 有 `CLOUDFLARE_ACCOUNT_ID` → 与 CI（ci-stable-identity.mjs）同源的稳定身份：
 *    组码 / 资源 ID / 占位 handle 由「账号 + HAILUO_NODE_SLOT」确定性派生。
 *    同一账号同一槽位重复部署会复用同一套名字（不重复建 D1/KV）；换账号或槽位才变。
 * 2. 没有账号 ID → 回退随机生成（仅账号尚未探测到的兜底，本地正常部署走稳定派生）。
 *
 * 命名规则：
 * - DEPLOY_GROUP_CODE：Worker A / Worker B / Pages / D1 / KV 共用的 6 位 hex 同组码。
 * - WORKER_A_RESOURCE_ID / WORKER_B_RESOURCE_ID / PAGES_RESOURCE_ID：三份独立 32 位 hex ID。
 * - 公开资源名把同组码放在各自短 ID 前，方便肉眼识别属于同一海螺节点；
 *   Worker 名必须 <=54 字符（Cloudflare previews 限制），所以名称中只使用 ID 前 28 位：
 *   hailuo-worker-a-{group}-{shortA}
 *   hailuo-worker-b-{group}-{shortB}
 *   hailuo-web-{group}-{shortP}
 */
import { buildStableIdentity } from './ci-stable-identity.mjs';

const HANDLE_PREFIX = 'hailuo_';
const DEFAULT_OWNER_LOGIN_USERNAME = 'admin';
const DEFAULT_OWNER_LOGIN_PASSWORD = 'admin';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += ALNUM[bytes[i] % ALNUM.length];
  return out;
}

function randomHex(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(len / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

function randomDeployResourceId() {
  return randomHex(32);
}

function resourceNameId(resourceId) {
  return resourceId.slice(0, 28);
}

const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const slot = (process.env.HAILUO_NODE_SLOT || '1').trim() || '1';

if (accountId) {
  // 与 CI 同源：账号 + 槽位 → 组码 / 资源 ID / 占位 handle；本地与云端行为一致
  process.stdout.write(JSON.stringify(buildStableIdentity(accountId, slot)));
} else {
  const deployGroupCode = randomHex(6);
  const workerAResourceId = randomDeployResourceId();
  const workerBResourceId = randomDeployResourceId();
  const pagesResourceId = randomDeployResourceId();

  const payload = {
    DEPLOY_GROUP_CODE: deployGroupCode,
    WORKER_A_RESOURCE_ID: workerAResourceId,
    WORKER_B_RESOURCE_ID: workerBResourceId,
    PAGES_RESOURCE_ID: pagesResourceId,
    WORKER_A_NAME: `hailuo-worker-a-${deployGroupCode}-${resourceNameId(workerAResourceId)}`,
    WORKER_B_NAME: `hailuo-worker-b-${deployGroupCode}-${resourceNameId(workerBResourceId)}`,
    PAGES_PROJECT_NAME: `hailuo-web-${deployGroupCode}-${resourceNameId(pagesResourceId)}`,
    // 后缀 10：总长 hailuo_ + 10 = 17 字节，仍在 handle 5–32 字节上限内，也比 16 位更好读
    BOOTSTRAP_HANDLE: `${HANDLE_PREFIX}${randomSuffix(10)}`,
    OWNER_LOGIN_USERNAME: DEFAULT_OWNER_LOGIN_USERNAME,
    OWNER_LOGIN_PASSWORD: DEFAULT_OWNER_LOGIN_PASSWORD,
    identity_source: 'random_fallback',
  };

  process.stdout.write(JSON.stringify(payload));
}
