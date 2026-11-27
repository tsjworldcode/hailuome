// M10-3：私信收件限频（按 sender_worker_b_url 每小时 D1 计数）。

import type { Env } from '../env';
import { normalizeDmPeerUrl } from './dmEnvelope';
import { messagingDb } from './messagingDb';

/** 单发送方节点每小时最多接受的 inbox 投递次数。 */
export const DM_INBOX_RATE_LIMIT_PER_HOUR = 120;

function currentHourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * 检查并递增收件限频计数；超限返回 false。
 * 使用 D1 UPSERT + WHERE 原子递增，避免 SELECT→UPDATE 竞态导致超限。
 */
export async function checkAndIncrementDmInboxRate(
  env: Env,
  senderWorkerBUrl: string,
): Promise<boolean> {
  const normalized = normalizeDmPeerUrl(senderWorkerBUrl);
  const windowHour = currentHourBucketIso();

  const result = await messagingDb(env)
    .prepare(
      `INSERT INTO dm_rate_buckets (sender_worker_b_url, window_hour, count)
       VALUES (?, ?, 1)
       ON CONFLICT (sender_worker_b_url, window_hour) DO UPDATE
       SET count = count + 1
       WHERE count < ?`,
    )
    .bind(normalized, windowHour, DM_INBOX_RATE_LIMIT_PER_HOUR)
    .run()
    .catch(() => null);

  // changes > 0：首次插入或成功递增；changes === 0：已达上限，UPDATE 被 WHERE 跳过。
  return (result?.meta.changes ?? 0) > 0;
}
