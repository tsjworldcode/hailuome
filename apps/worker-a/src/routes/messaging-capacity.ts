/**
 * M16-7d：MESSAGING_DB 容量查询（Settings 黄色提示）。
 * M16-P4c：扩展自动分片可观测字段。
 * MM-2：GET /api/messaging/cloud-capability（挂在本 app，勿挂到 /api/messaging/media）。
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../env';
import { getMessagingAutoShardObservability } from '../lib/messagingAutoShard';
import { estimateMessagingDbCapacity, isMessagingCapacityOverrideEnabled } from '../lib/messagingDbCapacity';
import { hasMessagingCloudCapability } from '../lib/mediaStorageUsage';
import {
  resolveMessagingMediaMaxBytes,
  resolveMessagingMediaMaxPerMessage,
} from '../lib/messagingMediaLimits';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const messagingCapacityApp = new Hono<AppEnv>();

/** GET /api/messaging/cloud-capability — 群图/镜像云能力（契约路径，非 /media 前缀） */
messagingCapacityApp.get('/cloud-capability', async (c) => {
  const [canCloud, maxBytes, maxPerMessage] = await Promise.all([
    hasMessagingCloudCapability(c.env),
    resolveMessagingMediaMaxBytes(c.env),
    resolveMessagingMediaMaxPerMessage(c.env),
  ]);
  return c.json({
    ok: true,
    data: {
      can_send_group_media: canCloud,
      can_mirror_group_media: canCloud,
      default_view_mode: canCloud ? 'mirror' : 'stream_only',
      max_bytes: maxBytes,
      max_per_message: maxPerMessage,
    },
  });
});

/** GET /api/messaging/db-capacity — 粗算 DM+群合计占用 + P4c 自动分片状态 */
messagingCapacityApp.get('/db-capacity', async (c) => {
  const [data, autoShard] = await Promise.all([
    estimateMessagingDbCapacity(c.env),
    getMessagingAutoShardObservability(c.env),
  ]);
  return c.json({
    ok: true,
    data: {
      ...data,
      capacity_override: isMessagingCapacityOverrideEnabled(c.env),
      ...autoShard,
    },
  });
});
