/**
 * 媒体文件上传接口（M2-5 + M5-1 + M5-B2 + M5-C2 + M5-C3 + M8-14-7 + M8-14-8）。
 *
 * imagesApp 挂在 /api/images/*，JWT 鉴权由 index.ts 保障。
 * 接口路径保持 /api/images 不变（向后兼容），现支持图片/视频/音频/文件。
 *
 * POST /api/images — 上传媒体文件（图片 / 视频 / 音频 / 文档）
 *
 * 支持类型（M5-C2/C3 扩展）：
 *   KV  后端：image/* 仅图片（**M8-14-7 ≤ 10 MiB 优先写 KV**；>10 MiB 或非图自动改道 R2）
 *   B2/R2 后端：任意 Content-Type，包括
 *     image/*  — 图片（JPEG / PNG / WebP / GIF 等）
 *     video/*  — 视频（MP4 / WebM / MOV 等）
 *     audio/*  — 音频（MP3 / AAC / OGG 等）
 *     application/* — 文档/文件（PDF / ZIP / DOCX 等）
 *     其他任意类型（B2 是通用对象存储，不限文件类型）
 *
 * 大小上限（按存储后端动态决定，M5-C2 + M5-SR + M8-14-7 + M8-14-8）：
 *   KV  后端：≤ 10 MiB（M8-14-7 软阈值；Cloudflare KV 单值硬上限 25 MB）
 *   B2/R2/Filebase：受 Cloudflare Workers 请求体限制（默认应用层 100 MB，见 MEDIA_MAX_REQUEST_BYTES）
 *   R2 软上限 10 GiB（M8-14-8；`R2_SOFT_LIMIT_BYTES` 与 Free Tier 对齐）
 *
 * M8-14-7 分流逻辑：
 *   1. 无 R2 绑定 → 仅 KV 规则（≥10 MiB / 非图 → 失败）
 *   2. 有 R2，且 size ≤ 10 MiB 且 image/* → 优先 KV
 *   3. 有 R2，且 size > 10 MiB → R2
 *   4. 有 R2，且非 image/* → R2
 *   5. 有 R2，且 KV 水位 ≥ 90% → R2（即使 ≤ 10 MiB）
 *
 * M8-14-8 R2 高水位 GC（`gcR2ToTargetWatermark`，挂 isGroupExternalSlotMinute 槽）：
 *   - 触发：R2 用量 ≥ 90%（`media_r2_high_watermark`）自动回收
 *   - 目标：清到 ≤ 70%（`media_r2_target_watermark`），腾约 30%
 *   - 两段回收：
 *     Tier 1：released_at / abandoned / retain_until 已过期 → 直接删 R2 bytes + 减计数
 *     Tier 2：active 按 created_at ASC + 跨 CONTENT_DB 校验无未删帖引用 → 删
 *   - **禁止**直接删仍被未删帖引用的对象（防图裂）
 *   - 阈值可在设置页修改（M8-14-9，本步不动 UI）
 *
 * ⚠️ Cloudflare Workers 请求体平台限制（按账号套餐，代码默认 100 MB）：
 *   Free/Pro：100 MB；Business：200 MB；Enterprise：默认 500 MB。
 *   operator 可通过 env `MEDIA_MAX_REQUEST_BYTES` 覆盖（字节数）。
 *
 * M5-B2 更新：读 D1 system_config.images_storage + B2 配置）：
 * M5-FB 更新：images_storage='filebase' 且探针 ok → Filebase
 *   1. images_storage='filebase' 且 D1 Filebase 配置完整且 filebase_probe_status='ok' → Filebase
 *   2. images_storage='b2' 且 D1/env B2 配置完整且 b2_probe_status='ok' → B2
 *   3. images_storage='r2' 且 HAILUO_IMAGE_R2 binding 存在且 r2_probe_status='ok' → R2
 *   4. 否则 → IMAGE_KV（始终可用的兜底）
 *
 * ⚠️ M2 红线保留：
 *   - POSTS_CACHE_KV 和 STATE_KV 在此路由禁止写入
 *   - IMAGE_KV.put 是唯一允许的 KV 写
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from '../env';
import { uploadToB2Stream } from '../lib/b2upload';
import { uploadToFilebaseStream } from '../lib/filebaseupload';
import {
  readImagesStorage,
  toB2UploadConfig,
  toFilebaseUploadConfig,
} from '../lib/mediaStorage';
import { finalizePublicMediaUpload } from '../lib/mediaObjectRegistry';
import {
  readMediaStorageMode,
  resolveUploadBackend,
  type MediaUsageBackend,
  type UsageAfterSnapshot,
} from '../lib/mediaStorageUsage';
import { resolveMaxMediaRequestBytes } from '../lib/mediaUploadLimits';
import { serveMediaObject } from '../lib/mediaServe';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const imagesApp = new Hono<AppEnv>();

/** KV 后端最大字节数（25 MB，Cloudflare KV 单值硬上限，不可突破） */
const MAX_KV_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// GET /api/images/:key — 站主 JWT 读媒体（M14-11 owner-only Web 图片代理）
// ---------------------------------------------------------------------------

imagesApp.get('/:key', async (c) => {
  const rawKey = c.req.param('key');
  const key = decodeURIComponent(rawKey);
  return serveMediaObject(c.env, key);
});

// ---------------------------------------------------------------------------
// POST /api/images — 上传媒体文件（图片 / 视频 / 音频 / 文档等）
// ---------------------------------------------------------------------------

imagesApp.post('/', async (c) => {
  // ── 1. 取 Content-Type（空值直接拒绝） ────────────────────────────────────
  const contentType = c.req.header('Content-Type') ?? '';
  if (!contentType) {
    return c.json(
      { ok: false, error_code: 'MEDIA_INVALID_TYPE', message: 'Content-Type 不能为空' },
      400,
    );
  }

  // ── 2. Content-Length 预检（路由前需要 declaredSize）────────────────────
  const contentLengthHeader = c.req.header('Content-Length') ?? null;
  const declaredSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
  const hasValidLength = declaredSize !== null && !isNaN(declaredSize);

  // ── 3. 确定存储后端（router：write_priority 链；manual：首选 images_storage，满额按 write_priority 溢出）─
  const storageMode = await readMediaStorageMode(c.env);
  const target = await resolveUploadBackend(c.env, { contentType, sizeBytes: declaredSize });

  if (!target) {
    const imagesStorage = await readImagesStorage(c.env);
    const errorCode =
      storageMode === 'manual' && imagesStorage !== 'kv'
        ? 'MEDIA_STORAGE_ROUTER_DISABLED'
        : 'MEDIA_STORAGE_FULL';
    const message =
      errorCode === 'MEDIA_STORAGE_ROUTER_DISABLED'
        ? '当前存储后端已满或未配置；可开启自动路由或切换后端'
        : '所有可用存储后端已满或未配置，无法上传';
    return c.json({ ok: false, error_code: errorCode, message }, 507);
  }

  const useFilebase = target.backend === 'filebase';
  const useB2 = target.backend === 'b2';
  const useR2 = target.backend === 'r2';
  const useKv = target.backend === 'kv';
  const filebaseStored = target.filebaseStored ?? null;
  const b2Stored = target.b2Stored ?? null;

  // ── 4. 按后端校验 Content-Type ───────────────────────────────────────────
  // KV 后端：仅 image/*（KV 设计用途就是小图片，非图片请配置 B2/R2）
  // B2/R2 后端：任意类型（image/video/audio/application/… B2 是通用对象存储）
  if (useKv && !contentType.startsWith('image/')) {
    return c.json(
      {
        ok: false,
        error_code: 'MEDIA_INVALID_TYPE',
        message: 'KV 后端仅支持 image/* 类型；如需上传视频、音频或文件，请先配置 Filebase、Backblaze B2 或 Cloudflare R2',
      },
      400,
    );
  }

  // KV 路径时大小上限 25MB；B2/R2/Filebase 路径时 500MB
  const maxBytes = useKv ? MAX_KV_BYTES : resolveMaxMediaRequestBytes(c.env);

  if (hasValidLength && declaredSize! > maxBytes) {
    const limitMB = Math.round(maxBytes / 1024 / 1024);
    return c.json(
      { ok: false, error_code: 'MEDIA_TOO_LARGE', message: `文件不能超过 ${limitMB} MB` },
      400,
    );
  }

  const uuid = crypto.randomUUID().replace(/-/g, '');
  // M7-30g-3：公开 /img URL 基址以 D1 为准（换域后免改 env）
  const publicBase = await resolveLocalPublicBaseUrl(c.env);
  if (!publicBase) {
    return c.json(
      { ok: false, error_code: 'MISCONFIGURED', message: 'Worker B 地址未配置' },
      503,
    );
  }

  // ── 5a. Filebase 存储路径（M5-FB） ───────────────────────────────────────
  if (useFilebase) {
    if (!contentLengthHeader) {
      return c.json(
        {
          ok: false,
          error_code: 'MEDIA_LENGTH_REQUIRED',
          message: 'Filebase 上传需要 Content-Length 请求头，请确保客户端以确定大小的 body 发送',
        },
        411,
      );
    }

    const fbObjectKey = `img_${uuid}`;
    const internalKey = `filebase:${fbObjectKey}`;
    const bodyStream = c.req.raw.body;

    if (!bodyStream) {
      return c.json({ ok: false, error_code: 'MEDIA_REQUIRED', message: '文件内容不能为空' }, 400);
    }

    try {
      const fbCfg = toFilebaseUploadConfig(filebaseStored!);
      await uploadToFilebaseStream(
        fbCfg,
        fbObjectKey,
        bodyStream,
        contentType,
        contentLengthHeader,
      );
    } catch (err) {
      console.error('[images] Filebase 流式上传失败', err);
      return c.json(
        {
          ok: false,
          error_code: 'MEDIA_UPLOAD_FAILED',
          message: 'Filebase 上传失败，请重试' + (declaredSize && declaredSize <= MAX_KV_BYTES
            ? '；或移除 Filebase 配置后重新上传（将自动使用 KV）' : ''),
        },
        500,
      );
    }
    const url = `${publicBase}/img/${internalKey}`;
    const sizeBytes = hasValidLength ? declaredSize! : 0;
    const usage_after =
      sizeBytes > 0 ? await finalizePublicMediaUpload(c.env, 'filebase', internalKey, sizeBytes) : null;
    return uploadSuccessJson(c, internalKey, url, 'filebase', sizeBytes, usage_after);
  }

  // ── 5b. B2 存储路径（M5-B2 + M5-C4b 流式直通） ────────────────────────────
  // 请求 body 作为 ReadableStream 直接管道到 B2，完全不缓冲进 Worker 内存。
  // 内存占用 ≈ 0；CPU 占用 ≈ 0（UNSIGNED-PAYLOAD + 纯 I/O 管道）。
  if (useB2) {
    // M5-C7：B2 S3 PUT 不支持 chunked encoding，Content-Length 必填。
    // 早拒绝避免 Worker 流式管道运行后才被 B2 报神秘错误。
    if (!contentLengthHeader) {
      return c.json(
        {
          ok: false,
          error_code: 'MEDIA_LENGTH_REQUIRED',
          message: 'B2 上传需要 Content-Length 请求头，请确保客户端以确定大小的 body 发送',
        },
        411, // HTTP 411 Length Required
      );
    }

    const b2ObjectKey = `img_${uuid}`;
    const internalKey  = `b2:${b2ObjectKey}`;
    const bodyStream   = c.req.raw.body;

    if (!bodyStream) {
      return c.json({ ok: false, error_code: 'MEDIA_REQUIRED', message: '文件内容不能为空' }, 400);
    }

    try {
      const b2Cfg = toB2UploadConfig(b2Stored!);
      await uploadToB2Stream(
        b2Cfg,
        b2ObjectKey,
        bodyStream,
        contentType,
        contentLengthHeader,
      );
    } catch (err) {
      console.error('[images] B2 流式上传失败', err);
      // 流式失败后 body stream 已消耗，无法再次读取 → 无法降级 KV
      // 只有 Content-Length 声明为小文件（≤ 25MB）时才尝试降级（需重新发起请求）
      return c.json(
        {
          ok: false,
          error_code: 'MEDIA_UPLOAD_FAILED',
          message: 'B2 上传失败，请重试' + (declaredSize && declaredSize <= MAX_KV_BYTES
            ? '；或移除 B2 配置后重新上传（将自动使用 KV）' : ''),
        },
        500,
      );
    }
    const url = `${publicBase}/img/${internalKey}`;
    const sizeBytes = hasValidLength ? declaredSize! : 0;
    const usage_after =
      sizeBytes > 0 ? await finalizePublicMediaUpload(c.env, 'b2', internalKey, sizeBytes) : null;
    return uploadSuccessJson(c, internalKey, url, 'b2', sizeBytes, usage_after);
  }

  // ── 5b. R2 存储路径（M5-1 + M5-C4b 流式直通） ────────────────────────────
  // R2 binding 的 put() 原生接受 ReadableStream，无需缓冲。
  if (useR2) {
    const key        = `r2:img_${uuid}`;
    const bodyStream = c.req.raw.body;

    if (!bodyStream) {
      return c.json({ ok: false, error_code: 'MEDIA_REQUIRED', message: '文件内容不能为空' }, 400);
    }

    try {
      await c.env.HAILUO_IMAGE_R2!.put(key, bodyStream, {
        httpMetadata: { contentType },
      });
    } catch (err) {
      console.error('[images] HAILUO_IMAGE_R2.put 流式上传失败', err);
      return c.json(
        { ok: false, error_code: 'MEDIA_UPLOAD_FAILED', message: 'R2 上传失败，请重试' },
        500,
      );
    }
    const url = `${publicBase}/img/${key}`;
    const sizeBytes = hasValidLength ? declaredSize! : 0;
    const usage_after =
      sizeBytes > 0 ? await finalizePublicMediaUpload(c.env, 'r2', key, sizeBytes) : null;
    return uploadSuccessJson(c, key, url, 'r2', sizeBytes, usage_after);
  }

  // ── 5c. KV 存储路径（默认兜底，≤ 25 MB，需缓冲进内存）────────────────────
  // KV 仅支持 image/*，且 ≤ 25MB；此路径才需要 arrayBuffer()
  const mediaData = await c.req.arrayBuffer();
  if (mediaData.byteLength === 0) {
    return c.json({ ok: false, error_code: 'MEDIA_REQUIRED', message: '文件内容不能为空' }, 400);
  }
  if (mediaData.byteLength > MAX_KV_BYTES) {
    return c.json(
      { ok: false, error_code: 'MEDIA_TOO_LARGE', message: '图片不能超过 25 MB（KV 后端限制）' },
      400,
    );
  }
  return uploadToKv(c, mediaData, contentType, uuid, publicBase);
});

function uploadSuccessJson(
  c: Context<AppEnv>,
  key: string,
  url: string,
  storage: MediaUsageBackend,
  sizeBytes: number,
  usage_after: UsageAfterSnapshot | null,
): Response {
  return c.json({
    ok: true,
    data: {
      key,
      url,
      storage,
      ...(sizeBytes > 0 ? { size_bytes: sizeBytes } : {}),
      ...(usage_after ? { usage_after } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// 内部辅助：写 IMAGE_KV（kv: 前缀，M2 红线唯一允许的 KV 写，仅 ≤ 25MB）
// ---------------------------------------------------------------------------

async function uploadToKv(
  c: Context<AppEnv>,
  mediaData: ArrayBuffer,
  contentType: string,
  uuid: string,
  publicBase: string,
): Promise<Response> {
  const key = `kv:img_${uuid}`;
  try {
    await c.env.IMAGE_KV.put(key, mediaData, {
      metadata: { contentType, size: mediaData.byteLength },
    });
  } catch (err) {
    console.error('[images] IMAGE_KV.put 失败', err);
    return c.json(
      { ok: false, error_code: 'MEDIA_UPLOAD_FAILED', message: '存储失败，请重试' },
      500,
    );
  }
  const url = `${publicBase}/img/${key}`;
  const sizeBytes = mediaData.byteLength;
  const usage_after = await finalizePublicMediaUpload(c.env, 'kv', key, sizeBytes);
  return uploadSuccessJson(c, key, url, 'kv', sizeBytes, usage_after);
}
