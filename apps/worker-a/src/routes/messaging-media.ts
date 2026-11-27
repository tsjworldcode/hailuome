/**
 * MM-2：Messaging Media 上传 / proxy / 本节点 blob。
 * 云能力查询见 messaging-capacity：GET /api/messaging/cloud-capability。
 * SSOT：docs/m10-p2-dm-media-plan.md v1.3 · docs/worker-a-api.md §Messaging Media
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { buildMessagingMediaStorageKey, isMessagingMediaStorageKey } from '@hailuo/shared-utils';
import type { Env, AppVariables } from '../env';
import { uploadToB2Stream } from '../lib/b2upload';
import { uploadToFilebaseStream } from '../lib/filebaseupload';
import { toB2UploadConfig, toFilebaseUploadConfig } from '../lib/mediaStorage';
import {
  assertMessagingMediaReadable,
  finalizeMessagingMediaUpload,
  type MessagingUploadPurpose,
} from '../lib/mediaObjectRegistry';
import {
  resolveMessagingCloudBackend,
  resolveUploadBackend,
  type MediaUsageBackend,
  type UsageAfterSnapshot,
} from '../lib/mediaStorageUsage';
import { resolveMaxMediaRequestBytes } from '../lib/mediaUploadLimits';
import { newMessagingMediaId, resolveMessagingMediaMaxBytes } from '../lib/messagingMediaLimits';
import { serveMediaObject } from '../lib/mediaServe';
import { messagingDb } from '../lib/messagingDb';
import { fetchMemberGroupEnvelopeJson } from '../lib/messagingShard';
import {
  fetchDmMediaFromSenderWorkerB,
  issueDmMediaFetchTicket,
} from '../lib/dmMediaFetchTicket';
import {
  fetchGroupMediaFromSenderWorkerB,
  issueGroupMediaFetchTicket,
} from '../lib/groupMediaFetchTicket';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const messagingMediaApp = new Hono<AppEnv>();

const MAX_KV_BYTES = 25 * 1024 * 1024;
const OCTET_STREAM = 'application/octet-stream';

function errorJson(
  c: Context<AppEnv>,
  status: 400 | 404 | 411 | 500 | 502 | 507,
  code: string,
  message: string,
): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

function parsePurpose(raw: string | undefined): MessagingUploadPurpose | null {
  if (raw === 'dm' || raw === 'group') return raw;
  return null;
}

/** MM-3/MM-5：浏览器远端读唯一入口（DM + 群） */
messagingMediaApp.get('/proxy', async (c) => {
  const messageId = c.req.query('message_id')?.trim() ?? '';
  const mediaId = c.req.query('media_id')?.trim() ?? '';
  const conversationId = c.req.query('conversation_id')?.trim() ?? '';
  const groupId = c.req.query('group_id')?.trim() ?? '';
  if (groupId) {
    return proxyGroupMedia(c, messageId, mediaId, groupId);
  }
  if (!messageId || !mediaId || !conversationId) {
    return errorJson(c, 400, 'INVALID_QUERY', '缺少 message_id / media_id / conversation_id');
  }

  const localRow = await messagingDb(c.env)
    .prepare(
      `SELECT local_storage_key, storage_state FROM messaging_media_local
        WHERE message_id = ? AND media_id = ? LIMIT 1`,
    )
    .bind(messageId, mediaId)
    .first<{ local_storage_key: string | null; storage_state: string }>();

  if (localRow?.local_storage_key && localRow.storage_state === 'mirrored') {
    return serveMediaObject(c.env, localRow.local_storage_key);
  }

  const inboxRow = await messagingDb(c.env)
    .prepare(
      `SELECT envelope_json FROM dm_messages WHERE message_id = ? AND direction = 'inbox' LIMIT 1`,
    )
    .bind(messageId)
    .first<{ envelope_json: string }>();
  if (!inboxRow) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '私信消息不存在');
  }

  let senderStorageKey = '';
  let senderWorkerB = '';
  let expectedSizeBytes: number | undefined;
  let expectedSha256Hex: string | undefined;
  try {
    const parsed = JSON.parse(inboxRow.envelope_json) as {
      conversation_id?: string;
      media?: {
        media_id?: string;
        sender_storage_key?: string;
        sender_worker_b_url?: string;
        size_bytes?: number;
        ciphertext_sha256?: string;
      };
    };
    if (parsed.conversation_id !== conversationId) {
      return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '会话不匹配');
    }
    if (parsed.media?.media_id !== mediaId) {
      return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在');
    }
    senderStorageKey = parsed.media.sender_storage_key?.trim() ?? '';
    senderWorkerB = parsed.media.sender_worker_b_url?.trim() ?? '';
    if (typeof parsed.media.size_bytes === 'number') expectedSizeBytes = parsed.media.size_bytes;
    if (typeof parsed.media.ciphertext_sha256 === 'string') {
      expectedSha256Hex = parsed.media.ciphertext_sha256;
    }
  } catch {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在');
  }
  if (!senderStorageKey || !senderWorkerB) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '消息不含媒体');
  }

  const ticket = await issueDmMediaFetchTicket(c.env, {
    message_id: messageId,
    media_id: mediaId,
    conversation_id: conversationId,
    sender_storage_key: senderStorageKey,
  });
  if (!ticket) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在或无权访问');
  }

  const maxBytes = await resolveMessagingMediaMaxBytes(c.env);
  const bytes = await fetchDmMediaFromSenderWorkerB(c.env, senderWorkerB, senderStorageKey, ticket, {
    maxBytes,
    expectedSizeBytes,
    expectedSha256Hex,
  });
  if (!bytes) {
    return errorJson(c, 502, 'MESSAGING_MEDIA_UPSTREAM_FAILED', '远端媒体拉取失败');
  }
  return new Response(bytes, {
    headers: {
      'Content-Type': OCTET_STREAM,
      'Cache-Control': 'private, no-store',
    },
  });
});

async function proxyGroupMedia(
  c: Context<AppEnv>,
  messageId: string,
  mediaId: string,
  groupId: string,
): Promise<Response> {
  if (!messageId || !mediaId || !groupId) {
    return errorJson(c, 400, 'INVALID_QUERY', '缺少 message_id / media_id / group_id');
  }

  const localRow = await messagingDb(c.env)
    .prepare(
      `SELECT local_storage_key, storage_state FROM messaging_media_local
        WHERE message_id = ? AND media_id = ? LIMIT 1`,
    )
    .bind(messageId, mediaId)
    .first<{ local_storage_key: string | null; storage_state: string }>();

  if (localRow?.local_storage_key && localRow.storage_state === 'mirrored') {
    return serveMediaObject(c.env, localRow.local_storage_key);
  }

  const envelopeJson = await fetchMemberGroupEnvelopeJson(c.env, groupId, messageId);
  if (!envelopeJson) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '群消息不存在');
  }

  let senderStorageKey = '';
  let senderWorkerB = '';
  let expectedSizeBytes: number | undefined;
  let expectedSha256Hex: string | undefined;
  try {
    const parsed = JSON.parse(envelopeJson) as {
      group_id?: string;
      media?: {
        media_id?: string;
        sender_storage_key?: string;
        sender_worker_b_url?: string;
        size_bytes?: number;
        ciphertext_sha256?: string;
      };
    };
    if (parsed.group_id !== groupId) {
      return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '群不匹配');
    }
    if (parsed.media?.media_id !== mediaId) {
      return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在');
    }
    senderStorageKey = parsed.media.sender_storage_key?.trim() ?? '';
    senderWorkerB = parsed.media.sender_worker_b_url?.trim() ?? '';
    if (typeof parsed.media.size_bytes === 'number') expectedSizeBytes = parsed.media.size_bytes;
    if (typeof parsed.media.ciphertext_sha256 === 'string') {
      expectedSha256Hex = parsed.media.ciphertext_sha256;
    }
  } catch {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在');
  }
  if (!senderStorageKey || !senderWorkerB) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '消息不含媒体');
  }

  const ticket = await issueGroupMediaFetchTicket(c.env, {
    group_id: groupId,
    message_id: messageId,
    media_id: mediaId,
    sender_storage_key: senderStorageKey,
    sender_worker_b_url: senderWorkerB,
  });
  if (!ticket) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在或无权访问');
  }

  const maxBytes = await resolveMessagingMediaMaxBytes(c.env);
  const bytes = await fetchGroupMediaFromSenderWorkerB(c.env, senderWorkerB, senderStorageKey, ticket, {
    maxBytes,
    expectedSizeBytes,
    expectedSha256Hex,
  });
  if (!bytes) {
    return errorJson(c, 502, 'MESSAGING_MEDIA_UPSTREAM_FAILED', '远端媒体拉取失败');
  }
  return new Response(bytes, {
    headers: {
      'Content-Type': OCTET_STREAM,
      'Cache-Control': 'private, no-store',
    },
  });
}

messagingMediaApp.get('/:storage_key', async (c) => {
  const rawKey = c.req.param('storage_key');
  const storageKey = decodeURIComponent(rawKey);
  if (!isMessagingMediaStorageKey(storageKey)) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在或无权访问');
  }
  const allowed = await assertMessagingMediaReadable(c.env, storageKey);
  if (!allowed) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '媒体不存在或无权访问');
  }
  return serveMediaObject(c.env, storageKey);
});

messagingMediaApp.put('/', async (c) => {
  const purpose = parsePurpose(c.req.query('purpose'));
  if (!purpose) {
    return errorJson(
      c,
      400,
      'MESSAGING_MEDIA_INVALID_PURPOSE',
      'purpose 必填且须为 dm 或 group',
    );
  }

  const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
  if (contentType !== OCTET_STREAM) {
    return errorJson(
      c,
      400,
      'MESSAGING_MEDIA_INVALID_TYPE',
      'Content-Type 须为 application/octet-stream',
    );
  }

  const plainMime = (c.req.header('X-Hailuo-Plain-Mime') ?? '').trim();
  if (!plainMime) {
    return errorJson(
      c,
      400,
      'MESSAGING_MEDIA_MIME_REQUIRED',
      '缺少 X-Hailuo-Plain-Mime 请求头',
    );
  }

  const contentLengthHeader = c.req.header('Content-Length') ?? null;
  const declaredSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
  const hasValidLength = declaredSize !== null && !Number.isNaN(declaredSize);

  const maxMessagingBytes = await resolveMessagingMediaMaxBytes(c.env);
  if (hasValidLength && declaredSize! > maxMessagingBytes) {
    return errorJson(
      c,
      400,
      'MESSAGING_MEDIA_TOO_LARGE',
      `单图不能超过 ${Math.round(maxMessagingBytes / 1024 / 1024)} MB`,
    );
  }

  const routeOpts = { contentType: plainMime, sizeBytes: declaredSize };
  const target =
    purpose === 'group'
      ? await resolveMessagingCloudBackend(c.env, routeOpts)
      : await resolveUploadBackend(c.env, routeOpts);

  if (!target) {
    if (purpose === 'group') {
      return errorJson(
        c,
        507,
        'GROUP_MEDIA_CLOUD_REQUIRED',
        '群图发送须配置可用的 Filebase、B2 或 R2 云存储',
      );
    }
    return errorJson(
      c,
      507,
      'MEDIA_STORAGE_FULL',
      '所有可用存储后端已满或未配置，无法上传',
    );
  }

  const useKv = target.backend === 'kv';
  // M10-P3：DM 语音条与图片同走 Messaging Media；KV Free 兜底放行 audio/*（短语音）
  if (useKv && !plainMime.startsWith('image/') && !plainMime.startsWith('audio/')) {
    return errorJson(
      c,
      400,
      'MESSAGING_MEDIA_INVALID_TYPE',
      'KV 后端仅支持 image/* 或 audio/* 原图 MIME',
    );
  }

  const maxBytes = useKv ? MAX_KV_BYTES : resolveMaxMediaRequestBytes(c.env);
  if (hasValidLength && declaredSize! > maxBytes) {
    const limitMB = Math.round(maxBytes / 1024 / 1024);
    return errorJson(
      c,
      400,
      'MESSAGING_MEDIA_TOO_LARGE',
      `文件不能超过 ${limitMB} MB`,
    );
  }

  const mediaIdHeader = c.req.header('X-Hailuo-Media-Id')?.trim() ?? '';
  const mediaId =
    /^[0-9a-f]{32}$/i.test(mediaIdHeader) ? mediaIdHeader.toLowerCase() : newMessagingMediaId();
  const objectName = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  const storageKey = buildMessagingMediaStorageKey(target.backend, objectName);
  if (!storageKey) {
    return errorJson(c, 500, 'INTERNAL_ERROR', '生成 storage_key 失败');
  }

  const senderWorkerBUrl = await resolveLocalPublicBaseUrl(c.env);
  if (!senderWorkerBUrl) {
    return errorJson(c, 500, 'MISCONFIGURED', 'Worker B 地址未配置');
  }
  let sizeBytes = hasValidLength ? declaredSize! : 0;

  if (target.backend === 'filebase') {
    if (!contentLengthHeader) {
      return errorJson(
        c,
        411,
        'MEDIA_LENGTH_REQUIRED',
        'Filebase 上传需要 Content-Length 请求头',
      );
    }
    const bodyStream = c.req.raw.body;
    if (!bodyStream) {
      return errorJson(c, 400, 'MEDIA_REQUIRED', '文件内容不能为空');
    }
    try {
      await uploadToFilebaseStream(
        toFilebaseUploadConfig(target.filebaseStored!),
        objectName,
        bodyStream,
        OCTET_STREAM,
        contentLengthHeader,
      );
    } catch (err) {
      console.error('[messaging-media] Filebase 上传失败', err);
      return errorJson(c, 500, 'MEDIA_UPLOAD_FAILED', 'Filebase 上传失败，请重试');
    }
  } else if (target.backend === 'b2') {
    if (!contentLengthHeader) {
      return errorJson(
        c,
        411,
        'MEDIA_LENGTH_REQUIRED',
        'B2 上传需要 Content-Length 请求头',
      );
    }
    const bodyStream = c.req.raw.body;
    if (!bodyStream) {
      return errorJson(c, 400, 'MEDIA_REQUIRED', '文件内容不能为空');
    }
    try {
      await uploadToB2Stream(
        toB2UploadConfig(target.b2Stored!),
        objectName,
        bodyStream,
        OCTET_STREAM,
        contentLengthHeader,
      );
    } catch (err) {
      console.error('[messaging-media] B2 上传失败', err);
      return errorJson(c, 500, 'MEDIA_UPLOAD_FAILED', 'B2 上传失败，请重试');
    }
  } else if (target.backend === 'r2') {
    const bodyStream = c.req.raw.body;
    if (!bodyStream) {
      return errorJson(c, 400, 'MEDIA_REQUIRED', '文件内容不能为空');
    }
    try {
      await c.env.HAILUO_IMAGE_R2!.put(storageKey, bodyStream, {
        httpMetadata: { contentType: OCTET_STREAM },
      });
    } catch (err) {
      console.error('[messaging-media] R2 上传失败', err);
      return errorJson(c, 500, 'MEDIA_UPLOAD_FAILED', 'R2 上传失败，请重试');
    }
  } else {
    const mediaData = await c.req.arrayBuffer();
    if (mediaData.byteLength === 0) {
      return errorJson(c, 400, 'MEDIA_REQUIRED', '文件内容不能为空');
    }
    if (mediaData.byteLength > MAX_KV_BYTES) {
      return errorJson(
        c,
        400,
        'MESSAGING_MEDIA_TOO_LARGE',
        '图片不能超过 25 MB（KV 后端限制）',
      );
    }
    sizeBytes = mediaData.byteLength;
    try {
      await c.env.IMAGE_KV.put(storageKey, mediaData, {
        metadata: { contentType: OCTET_STREAM, size: sizeBytes },
      });
    } catch (err) {
      console.error('[messaging-media] IMAGE_KV.put 失败', err);
      return errorJson(c, 500, 'MEDIA_UPLOAD_FAILED', '存储失败，请重试');
    }
  }

  const usage_after =
    sizeBytes > 0
      ? await finalizeMessagingMediaUpload(c.env, target.backend, storageKey, sizeBytes, {
          mediaId,
          purpose,
          senderWorkerBUrl,
        })
      : null;

  return uploadSuccessJson(c, storageKey, target.backend, sizeBytes, mediaId, usage_after);
});

function uploadSuccessJson(
  c: Context<AppEnv>,
  storageKey: string,
  backend: MediaUsageBackend,
  sizeBytes: number,
  mediaId: string,
  usage_after: UsageAfterSnapshot | null,
): Response {
  return c.json({
    ok: true,
    data: {
      storage_key: storageKey,
      backend,
      size_bytes: sizeBytes,
      media_id: mediaId,
      ...(usage_after ? { usage_after } : {}),
    },
  });
}
