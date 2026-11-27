/**
 * M14-3：Web 侧向目标节点申请读帖 Token 前生成互粉证明（避免 auth ↔ workerA 循环依赖）。
 */
import type { ReadMutualProof } from '@hailuo/shared-types';
import { getOwnerJwt, getWorkerAUrl } from './auth';
import { createWorkerAClient } from './workerA';

/** 读者站主 JWT 下为目标 Worker B URL 生成 read_mutual_proof；失败返回 null。 */
export async function fetchReadMutualProofForTarget(
  ownerWorkerBUrl: string,
): Promise<ReadMutualProof | null> {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    const data = await client.createReadMutualProof({ owner_worker_b_url: ownerWorkerBUrl });
    return data.proof;
  } catch {
    return null;
  }
}
