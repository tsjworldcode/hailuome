/**
 * GET/PATCH /api/node-settings/media-storage — B2 / Filebase Web 配置与 M5-SR 路由器。
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import {
  clearB2ConfigD1,
  clearB2ConfigFromKv,
  clearFilebaseConfigD1,
  clearFilebaseConfigFromKv,
  isHttpsUrl,
  isStoredB2ConfigComplete,
  persistB2ConfigD1,
  persistFilebaseConfigD1,
  probeB2WithConfig,
  probeFilebaseWithConfig,
  readB2ProbeStatus,
  readFilebaseProbeStatus,
  readImagesStorage,
  readStoredB2ConfigFromD1,
  readStoredFilebaseConfigFromD1,
  sanitizeB2Config,
  sanitizeFilebaseConfig,
  setImagesStorage,
  syncB2ConfigToKv,
  syncFilebaseConfigToKv,
  type ImagesStorageBackend,
  type StoredB2Config,
  type StoredFilebaseConfig,
} from '../lib/mediaStorage';
import {
  buildUsageMapForApi,
  backfillUsageFromRegistry,
  calibrateB2Usage,
  calibrateFilebaseUsage,
  calibrateR2Usage,
  calibrateKvUsage,
  maybeAutoEnableRouterOnCloudConfig,
  readActiveWriteBackend,
  readKvHighWatermark,
  readKvPreferredMaxBytes,
  readMediaStorageMode,
  readR2HighWatermark,
  readR2TargetWatermark,
  readWritePriority,
  registerCloudBackendInPriority,
  setKvHighWatermark,
  setKvPreferredMaxBytes,
  setMediaStorageMode,
  setR2HighWatermark,
  setR2TargetWatermark,
  unregisterCloudBackendFromPriority,
  validateMediaStorageThresholdsBody,
  type MediaStorageMode,
} from '../lib/mediaStorageUsage';
import { gcOrphanKvImages } from '../lib/mediaStorageGc';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const mediaStorageSettingsApp = new Hono<AppEnv>();

function parseBackend(raw: unknown): ImagesStorageBackend | null {
  if (raw === 'kv' || raw === 'b2' || raw === 'filebase' || raw === 'r2') return raw;
  return null;
}

function parseMode(raw: unknown): MediaStorageMode | null {
  if (raw === 'router' || raw === 'manual') return raw;
  return null;
}

async function readR2ProbeStatus(env: Env): Promise<string> {
  // system_config 在 IDENTITY_DB
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = 'r2_probe_status' LIMIT 1`)
      .first<{ value: string }>();
    return row?.value ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function activeProbeStatus(env: Env, backend: ImagesStorageBackend): Promise<string> {
  if (backend === 'filebase') return readFilebaseProbeStatus(env);
  if (backend === 'b2') return readB2ProbeStatus(env);
  if (backend === 'r2') return readR2ProbeStatus(env);
  return 'ok';
}

async function buildGetPayload(env: Env) {
  const identityDb = resolveIdentityDb(env);
  const governanceDb = resolveGovernanceDb(env);
  const mode = await readMediaStorageMode(env);
  const backend = await readImagesStorage(env);
  const active_write_backend = await readActiveWriteBackend(env);
  const b2Stored = await readStoredB2ConfigFromD1(env);
  const filebaseStored = await readStoredFilebaseConfigFromD1(env);
  const probe_status = await activeProbeStatus(env, backend);
  const b2_probe_status = await readB2ProbeStatus(env);
  const filebase_probe_status = await readFilebaseProbeStatus(env);
  const usage = await buildUsageMapForApi(env);
  const write_priority = await readWritePriority(env);

  // M8-14-9：R2 绑定状态
  const r2_bound = Boolean(env.HAILUO_IMAGE_R2);

  // M8-14-9：当前阈值（读 D1；未配置则回落默认值）
  const [kv_high_watermark, kv_preferred_max_bytes, r2_high_watermark, r2_target_watermark] =
    await Promise.all([
      readKvHighWatermark(env),
      readKvPreferredMaxBytes(env),
      readR2HighWatermark(env),
      readR2TargetWatermark(env),
    ]);

  // media_storage_config 在 GOVERNANCE_DB
  const b2Row = await governanceDb
    .prepare(`SELECT updated_at FROM media_storage_config WHERE id = 'b2' LIMIT 1`)
    .first<{ updated_at: string }>();
  const filebaseRow = await governanceDb
    .prepare(`SELECT updated_at FROM media_storage_config WHERE id = 'filebase' LIMIT 1`)
    .first<{ updated_at: string }>();
  void identityDb;

  return {
    mode,
    write_priority: [...write_priority],
    active_write_backend,
    backend,
    b2: sanitizeB2Config(b2Stored),
    filebase: sanitizeFilebaseConfig(filebaseStored),
    usage,
    probe_status,
    b2_probe_status,
    filebase_probe_status,
    updated_at: b2Row?.updated_at ?? filebaseRow?.updated_at ?? null,
    // M8-14-9：R2 状态与阈值
    r2_bound,
    thresholds: {
      kv_high_watermark,         // 0.90
      kv_preferred_max_bytes,     // 10 MB
      r2_high_watermark,         // 0.90
      r2_target_watermark,       // 0.70
    },
  };
}

/** GET /api/node-settings/media-storage */
mediaStorageSettingsApp.get('/', async (c) => {
  return c.json({ ok: true, data: await buildGetPayload(c.env) });
});

async function parseS3ConfigBody(
  raw: unknown,
  readExisting: () => Promise<StoredB2Config | null>,
): Promise<StoredB2Config | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cfg = raw as Record<string, unknown>;
  const key_id = typeof cfg.key_id === 'string' ? cfg.key_id.trim() : '';
  const bucket_name = typeof cfg.bucket_name === 'string' ? cfg.bucket_name.trim() : '';
  const endpoint = typeof cfg.endpoint === 'string' ? cfg.endpoint.trim() : '';
  const region =
    typeof cfg.region === 'string' && cfg.region.trim() ? cfg.region.trim() : undefined;

  let app_key = typeof cfg.app_key === 'string' ? cfg.app_key.trim() : '';
  if (!app_key) {
    const existing = await readExisting();
    if (existing?.app_key) app_key = existing.app_key;
  }

  const draft: Partial<StoredB2Config> = { key_id, app_key, bucket_name, endpoint, region };
  if (!isStoredB2ConfigComplete(draft)) return null;
  return draft;
}

async function saveFilebaseConfig(env: Env, stored: StoredFilebaseConfig) {
  if (!isHttpsUrl(stored.endpoint)) {
    return { ok: false as const, error_code: 'FILEBASE_CONFIG_INVALID_URL', message: 'endpoint 必须是 https:// 开头的 URL' };
  }
  try {
    await probeFilebaseWithConfig(stored);
  } catch (err) {
    console.error('[node-settings/media-storage] Filebase 探针失败', err);
    return {
      ok: false as const,
      error_code: 'FILEBASE_PROBE_FAILED',
      message: 'Filebase 连接探针失败，请检查密钥、bucket 与 endpoint',
    };
  }
  try {
    await persistFilebaseConfigD1(env, stored, 'ok');
  } catch (err) {
    console.error('[node-settings/media-storage] 写 D1 Filebase 失败', err);
    return { ok: false as const, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: '保存 Filebase 配置到 D1 失败，请重试' };
  }
  try {
    await syncFilebaseConfigToKv(env, stored);
  } catch (err) {
    console.error('[node-settings/media-storage] Filebase STATE_KV 同步失败', err);
    return {
      ok: false as const,
      error_code: 'MEDIA_STORAGE_SAVE_FAILED',
      message: 'Filebase 配置已保存但未启用：Worker B 运行态同步失败，请重试',
    };
  }
  return { ok: true as const };
}

/** 云凭证首次入库：写入优先级链 + 从 KV 场景自动开 router */
async function afterCloudBackendSaved(
  env: Env,
  backend: 'filebase' | 'b2',
  wasConfiguredBefore: boolean,
): Promise<void> {
  if (!wasConfiguredBefore) {
    await registerCloudBackendInPriority(env, backend);
  }
  await maybeAutoEnableRouterOnCloudConfig(env);
}

async function saveB2Config(env: Env, stored: StoredB2Config) {
  if (!isHttpsUrl(stored.endpoint)) {
    return { ok: false as const, error_code: 'B2_CONFIG_INVALID_URL', message: 'endpoint 必须是 https:// 开头的 URL' };
  }
  try {
    await probeB2WithConfig(stored);
  } catch (err) {
    console.error('[node-settings/media-storage] B2 探针失败', err);
    return { ok: false as const, error_code: 'B2_PROBE_FAILED', message: 'B2 连接探针失败，请检查密钥、bucket 与 endpoint' };
  }
  try {
    await persistB2ConfigD1(env, stored, 'ok');
  } catch (err) {
    console.error('[node-settings/media-storage] 写 D1 失败', err);
    return { ok: false as const, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: '保存 B2 配置到 D1 失败，请重试' };
  }
  try {
    await syncB2ConfigToKv(env, stored);
  } catch (err) {
    console.error('[node-settings/media-storage] STATE_KV 同步失败', err);
    return {
      ok: false as const,
      error_code: 'MEDIA_STORAGE_SAVE_FAILED',
      message: 'B2 配置已保存但未启用：Worker B 运行态同步失败，请重试',
    };
  }
  return { ok: true as const };
}

/** PATCH /api/node-settings/media-storage */
mediaStorageSettingsApp.patch('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
  }

  const modePatch = parseMode(body.mode);
  if (modePatch) {
    try {
      await setMediaStorageMode(resolveIdentityDb(c.env), modePatch);
    } catch (err) {
      console.error('[node-settings/media-storage] 切换 mode 失败', err);
      return c.json(
        { ok: false, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: '保存媒体存储模式失败，请重试' },
        500,
      );
    }
  }

  if (body.recalibrate_filebase === true) {
    await calibrateFilebaseUsage(c.env);
  }

  if (body.recalibrate_b2 === true) {
    await calibrateB2Usage(c.env);
  }

  if (body.recalibrate_r2 === true) {
    await calibrateR2Usage(c.env);
  }

  // M8-14-10b：列举 IMAGE_KV 校准自记账（补孤儿登记）
  if (body.recalibrate_kv === true) {
    await calibrateKvUsage(c.env);
  }

  // M8-14-10c：清理无帖引用的 kv: 孤儿图
  if (body.gc_orphan_kv === true) {
    await gcOrphanKvImages(c.env);
  }

  if (body.backfill_usage === true) {
    await backfillUsageFromRegistry(c.env);
  }

  // M8-14-9：阈值写入
  // M8-14-9b：先做业务校验（挡 NaN / 越界 / 关系错）→ 失败 400；然后写 D1，任一 set 抛错 → 失败 500。
  // 之前 `.catch(console.error)` 静默吞错的策略被取消：现在任一字段不合规用户都能立刻看到反馈。
  if (typeof body.thresholds === 'object' && body.thresholds !== null && !Array.isArray(body.thresholds)) {
    const th = body.thresholds as Record<string, unknown>;
    const validation = validateMediaStorageThresholdsBody(th);
    if (!validation.ok) {
      return c.json(
        {
          ok: false,
          error_code: 'MEDIA_STORAGE_INVALID_THRESHOLD',
          message: validation.error,
        },
        400,
      );
    }
    const writes: Promise<void>[] = [];
    if ('kv_high_watermark' in th) {
      writes.push(setKvHighWatermark(c.env, th.kv_high_watermark as number));
    }
    if ('kv_preferred_max_bytes' in th) {
      writes.push(setKvPreferredMaxBytes(c.env, th.kv_preferred_max_bytes as number));
    }
    if ('r2_high_watermark' in th) {
      writes.push(setR2HighWatermark(c.env, th.r2_high_watermark as number));
    }
    if ('r2_target_watermark' in th) {
      writes.push(setR2TargetWatermark(c.env, th.r2_target_watermark as number));
    }
    if (writes.length > 0) {
      try {
        await Promise.all(writes);
      } catch (err) {
        console.error('[node-settings/media-storage] 写 D1 阈值失败', err);
        return c.json(
          {
            ok: false,
            error_code: 'MEDIA_STORAGE_SAVE_FAILED',
            message: '保存阈值失败，请重试',
          },
          500,
        );
      }
    }
  }

  if (body.clear_b2 === true) {
    try {
      await clearB2ConfigD1(c.env);
      await clearB2ConfigFromKv(c.env);
      await unregisterCloudBackendFromPriority(c.env, 'b2');
    } catch (err) {
      console.error('[node-settings/media-storage] 清除 B2 配置失败', err);
      return c.json(
        { ok: false, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: '清除 B2 配置失败，请重试' },
        500,
      );
    }
    return c.json({ ok: true, data: await buildGetPayload(c.env) });
  }

  if (body.clear_filebase === true) {
    try {
      await clearFilebaseConfigD1(c.env);
      await clearFilebaseConfigFromKv(c.env);
      await unregisterCloudBackendFromPriority(c.env, 'filebase');
    } catch (err) {
      console.error('[node-settings/media-storage] 清除 Filebase 配置失败', err);
      return c.json(
        { ok: false, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: '清除 Filebase 配置失败，请重试' },
        500,
      );
    }
    return c.json({ ok: true, data: await buildGetPayload(c.env) });
  }

  const currentMode = await readMediaStorageMode(c.env);

  // router 模式：可只保存凭证，不要求 backend 单选
  if (currentMode === 'router' && body.backend === undefined) {
    if (body.filebase !== undefined) {
      const hadFilebase = isStoredB2ConfigComplete(await readStoredFilebaseConfigFromD1(c.env));
      const stored = await parseS3ConfigBody(body.filebase, () => readStoredFilebaseConfigFromD1(c.env));
      if (!stored) {
        return c.json(
          {
            ok: false,
            error_code: 'FILEBASE_CONFIG_INCOMPLETE',
            message: 'Filebase 配置缺少必填字段（key_id、app_key、bucket_name、endpoint）',
          },
          400,
        );
      }
      const result = await saveFilebaseConfig(c.env, stored as StoredFilebaseConfig);
      if (!result.ok) {
        return c.json({ ok: false, error_code: result.error_code, message: result.message }, result.error_code === 'FILEBASE_PROBE_FAILED' ? 502 : 500);
      }
      await afterCloudBackendSaved(c.env, 'filebase', hadFilebase);
    }
    if (body.b2 !== undefined) {
      const hadB2 = isStoredB2ConfigComplete(await readStoredB2ConfigFromD1(c.env));
      const stored = await parseS3ConfigBody(body.b2, () => readStoredB2ConfigFromD1(c.env));
      if (!stored) {
        return c.json(
          { ok: false, error_code: 'B2_CONFIG_INCOMPLETE', message: 'B2 配置缺少必填字段（key_id、app_key、bucket_name、endpoint）' },
          400,
        );
      }
      const result = await saveB2Config(c.env, stored);
      if (!result.ok) {
        return c.json({ ok: false, error_code: result.error_code, message: result.message }, result.error_code === 'B2_PROBE_FAILED' ? 502 : 500);
      }
      await afterCloudBackendSaved(c.env, 'b2', hadB2);
    }
    if (modePatch || body.filebase !== undefined || body.b2 !== undefined || body.recalibrate_filebase === true || body.recalibrate_b2 === true || body.recalibrate_r2 === true || body.recalibrate_kv === true || body.gc_orphan_kv === true || body.backfill_usage === true || typeof body.thresholds === 'object') {
      return c.json({ ok: true, data: await buildGetPayload(c.env) });
    }
  }

  // manual 等：仅切换 mode（或仅 recalibrate/thresholds）时不强制 backend，避免 mode 已写却返回 400
  if (
    body.backend === undefined &&
    body.filebase === undefined &&
    body.b2 === undefined &&
    (modePatch || body.recalibrate_filebase === true || body.recalibrate_b2 === true || body.recalibrate_r2 === true || body.recalibrate_kv === true || body.gc_orphan_kv === true || body.backfill_usage === true || typeof body.thresholds === 'object')
  ) {
    return c.json({ ok: true, data: await buildGetPayload(c.env) });
  }

  const backend = parseBackend(body.backend);
  if (!backend || (backend !== 'kv' && backend !== 'b2' && backend !== 'filebase')) {
    return c.json(
      {
        ok: false,
        error_code: 'MEDIA_STORAGE_INVALID_BACKEND',
        message: 'backend 必须为 kv、b2 或 filebase',
      },
      400,
    );
  }

  if (backend === 'kv') {
    try {
      await setImagesStorage(c.env, 'kv');
    } catch (err) {
      console.error('[node-settings/media-storage] 切换 kv 失败', err);
      return c.json(
        { ok: false, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: '保存媒体存储设置失败，请重试' },
        500,
      );
    }
    return c.json({ ok: true, data: await buildGetPayload(c.env) });
  }

  if (backend === 'filebase') {
    const hadFilebase = isStoredB2ConfigComplete(await readStoredFilebaseConfigFromD1(c.env));
    const stored = await parseS3ConfigBody(body.filebase, () => readStoredFilebaseConfigFromD1(c.env));
    if (!stored) {
      return c.json(
        {
          ok: false,
          error_code: 'FILEBASE_CONFIG_INCOMPLETE',
          message: 'Filebase 配置缺少必填字段（key_id、app_key、bucket_name、endpoint）',
        },
        400,
      );
    }
    const result = await saveFilebaseConfig(c.env, stored as StoredFilebaseConfig);
    if (!result.ok) {
      return c.json({ ok: false, error_code: result.error_code, message: result.message }, result.error_code === 'FILEBASE_PROBE_FAILED' ? 502 : 500);
    }
    await afterCloudBackendSaved(c.env, 'filebase', hadFilebase);
    if (currentMode === 'manual') {
      try {
        await setImagesStorage(c.env, 'filebase');
      } catch (err) {
        console.error('[node-settings/media-storage] 切换 images_storage=filebase 失败', err);
        return c.json(
          { ok: false, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: 'Filebase 已探针通过但启用后端失败，请重试' },
          500,
        );
      }
    }
    return c.json({ ok: true, data: await buildGetPayload(c.env) });
  }

  const hadB2 = isStoredB2ConfigComplete(await readStoredB2ConfigFromD1(c.env));
  const stored = await parseS3ConfigBody(body.b2, () => readStoredB2ConfigFromD1(c.env));
  if (!stored) {
    return c.json(
      { ok: false, error_code: 'B2_CONFIG_INCOMPLETE', message: 'B2 配置缺少必填字段（key_id、app_key、bucket_name、endpoint）' },
      400,
    );
  }
  const result = await saveB2Config(c.env, stored);
  if (!result.ok) {
    return c.json({ ok: false, error_code: result.error_code, message: result.message }, result.error_code === 'B2_PROBE_FAILED' ? 502 : 500);
  }
  await afterCloudBackendSaved(c.env, 'b2', hadB2);
  if (currentMode === 'manual') {
    try {
      await setImagesStorage(c.env, 'b2');
    } catch (err) {
      console.error('[node-settings/media-storage] 切换 images_storage=b2 失败', err);
      return c.json(
        { ok: false, error_code: 'MEDIA_STORAGE_SAVE_FAILED', message: 'B2 已探针通过但启用后端失败，请重试' },
        500,
      );
    }
  }
  return c.json({ ok: true, data: await buildGetPayload(c.env) });
});
