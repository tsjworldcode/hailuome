/**
 * MSG-FIX-1：解析私信对端节点 URL + dm_pubkey。
 * 禁止假设本机 Worker B `GET /users/:handle` 能解析任意跨节点用户。
 *
 * 报错口径：只有「对端公开资料能读到、但确实没有 dm_pubkey」才报
 * `DM_PEER_NO_PUBKEY`；网络/CORS 失败、404、对端异常分别走
 * `DM_PEER_UNREACHABLE` / `DM_PEER_PROFILE_NOT_FOUND` / `DM_PEER_PROFILE_UNAVAILABLE`，
 * 不能把「拉不到」说成「对方没开私信」。
 *
 * 取公钥路径（DM-PEER-PUBKEY-1）：由本机 Worker A `getDmPeerPubkey` 服务端取档，
 * 浏览器不再直接跨域访问对端 Worker B，避免 workers.dev 被污染 / 默认档 CORS 拦截。
 */
import { ApiError } from './errors';
import type { createWorkerAClient } from './workerA';

type WorkerAClient = ReturnType<typeof createWorkerAClient>;

export interface DmPeerInfo {
  readonly worker_b_url: string;
  readonly dm_pubkey: string;
}

export interface ResolveDmPeerOptions {
  readonly client: WorkerAClient;
  readonly meWorkerB: string;
  readonly meHandle: string;
  /** 会话/上次发送已知的对端 Worker B（优先） */
  readonly hintWorkerBUrl?: string;
  /** 已知 dm_pubkey（可跳过对端公开资料拉取） */
  readonly hintDmPubkey?: string;
}

function normHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

/**
 * 解析顺序：hint → follows → mutual（node_url）→ 本地 DM 收发件箱 peer_worker_b_url
 * → Worker A lookup → 本机 Worker A `getDmPeerPubkey` 服务端取 dm_pubkey。
 */
export async function resolveDmPeer(
  handle: string,
  opts: ResolveDmPeerOptions,
): Promise<DmPeerInfo> {
  const peerHandle = normHandle(handle);
  if (!peerHandle) {
    throw new ApiError(400, { error_code: 'DM_PEER_INVALID' }, '收件人 handle 无效');
  }

  let workerBUrl = (opts.hintWorkerBUrl ?? '').trim();
  let dmPubkey = (opts.hintDmPubkey ?? '').trim();

  if (!workerBUrl) {
    try {
      const follows = await opts.client.listFollows();
      const hit = follows.items.find((f) => normHandle(f.handle) === peerHandle);
      if (hit?.worker_b_url) workerBUrl = hit.worker_b_url.trim();
    } catch {
      // 关注列表不可用时继续其它来源
    }
  }

  if (!workerBUrl) {
    try {
      const mutual = await opts.client.listMutualFollows();
      const hit = mutual.items.find((f) => normHandle(f.handle) === peerHandle);
      if (hit?.node_url) workerBUrl = hit.node_url.trim();
    } catch {
      // 好友列表不可用时继续
    }
  }

  if (!workerBUrl) {
    try {
      const [inbox, outbox] = await Promise.all([
        opts.client.listDmInbox({ limit: 50 }),
        opts.client.listDmOutbox({ limit: 50 }),
      ]);
      for (const item of [...inbox.items, ...outbox.items]) {
        if (normHandle(item.peer_handle) === peerHandle && item.peer_worker_b_url) {
          workerBUrl = item.peer_worker_b_url.trim();
          break;
        }
      }
    } catch {
      // 本地密文列表不可用时继续
    }
  }

  if (!workerBUrl || !dmPubkey) {
    try {
      const looked = await opts.client.lookup(peerHandle);
      if (!workerBUrl && looked.worker_b_url) workerBUrl = looked.worker_b_url.trim();
      if (!dmPubkey && looked.dm_pubkey) dmPubkey = looked.dm_pubkey.trim();
    } catch {
      // lookup 失败不阻断：仍可能已有 URL 再打对端公开资料
    }
  }

  if (!workerBUrl) {
    throw new ApiError(
      404,
      { error_code: 'DM_PEER_NOT_FOUND' },
      '找不到对方节点，请确认 handle 或节点地址',
    );
  }

  if (!dmPubkey) {
    // DM-PEER-PUBKEY-1：不再由浏览器直连对端 Worker B（workers.dev 可能被污染，
    // 且默认 token-required 档 CORS 只放行对端自己的 Pages 来源）。
    // 改由本机 Worker A 服务端取档，只返回 dm_pubkey + worker_b_url。
    try {
      const looked = await opts.client.getDmPeerPubkey(peerHandle, workerBUrl);
      dmPubkey = looked.dm_pubkey;
      if (looked.worker_b_url) workerBUrl = looked.worker_b_url;
    } catch (err) {
      // Worker A 已把网络 / 404 / 未配置分成不同 error_code；原样抛给 UI。
      if (err instanceof ApiError && err.code.startsWith('DM_PEER_')) throw err;
      throw new ApiError(
        503,
        { error_code: 'DM_PEER_UNREACHABLE' },
        '暂时无法连接对方节点，读不到私信公钥，请稍后重试',
      );
    }
  }

  if (!dmPubkey) {
    throw new ApiError(
      404,
      { error_code: 'DM_PEER_NO_PUBKEY' },
      '对方尚未开启私信（未配置 dm_pubkey）',
    );
  }

  return { worker_b_url: workerBUrl, dm_pubkey: dmPubkey };
}
