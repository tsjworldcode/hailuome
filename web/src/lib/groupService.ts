/**
 * M16-4d + MM-5：群聊编排 — list/create/join/send/sync/hydrate（含群图）。
 */
import { randomDmNonceHex } from '@hailuo/shared-crypto';
import type { GroupMessageEnvelope, GroupSyncDown, MessagingMediaSigned } from '@hailuo/shared-types';
import {
  buildMessagingMediaSigned,
  decryptMessagingMediaBytes,
  encryptMessagingMediaBytes,
} from '@hailuo/shared-crypto';
import { bytesToHex, hexToBytes } from '@hailuo/shared-utils';
import {
  decodeGroupSystemPlaintext,
  decryptGroupPlaintext,
  encryptGroupPlaintext,
  fingerprintGroupKey,
  generateGroupKey,
  groupMessageAadFromEnvelope,
  isGroupWrappedKeyV2,
  newGroupMessageId,
  unwrapGroupKey,
  unwrapGroupKeyWithDh,
  wrapGroupKey,
  wrapGroupKeyForMemberDh,
  type GroupMessageAadInput,
  type GroupWrappedKeyJson,
} from './groupCrypto';
import { getDmIdentity } from './dmLocalDb';
import { ensureDmIdentity } from './dmService';
import {
  getGroupPlaintext,
  listGroupPlaintexts,
  saveGroupPlaintext,
  type GroupMediaView,
  type GroupPlaintextRecord,
} from './groupLocalDb';
import { getGroupSessionKey, setGroupSessionKey } from './groupSession';
import { normalizeGroupNickname } from './groupNickname';
import {
  fetchGroupMessagingCiphertext,
  newClientMessagingMediaId,
  uploadGroupMessagingMedia,
} from './messagingMediaClient';
import { businessUnwrapMaterials, requireVaultWrapMaterial } from './vaultWrapMaterial';
import type {
  createWorkerAClient,
  GroupLocalMessageItem,
  GroupLocalMessagesResponse,
  LocalGroupItem,
} from './workerA';

type WorkerAClient = ReturnType<typeof createWorkerAClient>;

const GROUP_MESSAGE_TTL_MS = 5 * 60 * 1000;
const MAX_GROUP_IMAGE_BYTES = 10 * 1024 * 1024;

/** 与 Worker `REKEY_WRAP_BATCH_MAX` 对齐；单批上传上限 */
export const REKEY_WRAP_BATCH_MAX = 32;

/** M-VAULT-6：vault 优先，旧 password 可回退；REKEY-2 v2 走本机 DH */
async function unwrapGroupKeyFlexible(
  wrapped: GroupWrappedKeyJson,
  groupId: string,
  passwordHash?: string | null,
): Promise<Uint8Array> {
  if (isGroupWrappedKeyV2(wrapped)) {
    const identity = await getDmIdentity();
    if (!identity?.private_key_hex) {
      throw new Error('本机尚未就绪群 DH 身份，无法解开成员密封的群密钥');
    }
    return unwrapGroupKeyWithDh(wrapped, identity.private_key_hex, groupId);
  }
  const materials = businessUnwrapMaterials(passwordHash);
  if (materials.length === 0) throw new Error('缺少密钥材料，无法解开群密钥');
  let last: unknown;
  for (const material of materials) {
    try {
      return await unwrapGroupKey(wrapped, material, groupId);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('无法解开群密钥包裹');
}

/**
 * REKEY-2：把本机 X25519 公钥登记为群 `member_dh_pubkey`（复用私信身份，职责仍与 Ed25519 分离）。
 */
export async function registerGroupMemberDhPubkey(
  client: WorkerAClient,
  passwordHash: string,
  groupId: string,
): Promise<{ group_id: string; member_worker_b_url: string; member_dh_pubkey: string }> {
  await ensureDmIdentity(client, passwordHash);
  const identity = await getDmIdentity();
  if (!identity?.public_key_hex) {
    throw new Error('本机 DH 公钥未就绪');
  }
  return client.putGroupMemberDhPubkey(groupId, identity.public_key_hex);
}

export type RekeyBatchProgress = {
  readonly uploaded: number;
  readonly total: number;
  readonly next_epoch: number;
};

/**
 * @deprecated OWNER-KEY-5：优先 `ownerGroupRekey`（群主节点服务端代封）。
 * 本函数仅作缺 `GROUP_OWNER_KEY_WRAP_SECRET` / 非群主节点时的迁移期兜底。
 *
 * REKEY-2 / SEC-AUDIT-2026-10-16：生成新钥 → 密封 → 真 batch PUT（≤32）+ 同源 fingerprint。
 * 首批带 replace_key，清掉上一轮未完成的异源 wraps。crash-safe：未 commit 前旧 epoch 仍可用。
 */
export async function batchWrapNextEpochKeys(
  client: WorkerAClient,
  passwordHash: string,
  input: {
    readonly groupId: string;
    readonly currentEpoch: number;
    readonly localWorkerBUrl: string;
    readonly members: readonly {
      readonly member_worker_b_url: string;
      readonly member_dh_pubkey: string | null;
    }[];
    readonly onProgress?: (p: RekeyBatchProgress) => void;
  },
): Promise<{
  readonly next_epoch: number;
  readonly group_key: Uint8Array;
  readonly uploaded: number;
  readonly key_fingerprint: string;
}> {
  void passwordHash;
  const vault = requireVaultWrapMaterial();
  const nextEpoch = input.currentEpoch + 1;
  // SEC-AUDIT-2026-10-15：只密封已登记 DH 的成员（含本人 vault）；缺 DH 离线成员留给 commit deferred
  const sealable = input.members.filter((m) => {
    if (typeof m.member_worker_b_url !== 'string' || !m.member_worker_b_url) return false;
    if (m.member_worker_b_url === input.localWorkerBUrl) return true;
    const dh = (m.member_dh_pubkey ?? '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(dh);
  });
  if (sealable.length === 0) {
    throw new Error('没有可密封的活跃成员（均未登记 member_dh_pubkey）');
  }

  const groupKey = await generateGroupKey();
  const keyFingerprint = await fingerprintGroupKey(groupKey);
  const payloads: { member_worker_b_url: string; wrapped_key_json: string }[] = [];
  for (const m of sealable) {
    const isSelf = m.member_worker_b_url === input.localWorkerBUrl;
    const wrapped = isSelf
      ? await wrapGroupKey(groupKey, vault, input.groupId, nextEpoch)
      : await wrapGroupKeyForMemberDh(
          groupKey,
          (m.member_dh_pubkey ?? '').trim().toLowerCase(),
          input.groupId,
          nextEpoch,
        );
    payloads.push({
      member_worker_b_url: m.member_worker_b_url,
      wrapped_key_json: JSON.stringify(wrapped),
    });
  }

  let uploaded = 0;
  for (let i = 0; i < payloads.length; i += REKEY_WRAP_BATCH_MAX) {
    const batch = payloads.slice(i, i + REKEY_WRAP_BATCH_MAX);
    // 真 batch：一次 HTTP 写整批；首批 replace_key 清异源残留
    await client.putGroupWrappedKeysBatch(input.groupId, {
      epoch: nextEpoch,
      key_fingerprint: keyFingerprint,
      replace_key: i === 0,
      items: batch,
    });
    uploaded += batch.length;
    input.onProgress?.({ uploaded, total: payloads.length, next_epoch: nextEpoch });
  }

  setGroupSessionKey(input.groupId, nextEpoch, groupKey);
  return {
    next_epoch: nextEpoch,
    group_key: groupKey,
    uploaded,
    key_fingerprint: keyFingerprint,
  };
}

/** wraps 齐备后 CAS epoch++（须管理员；服务端再验齐备）。 */
export async function commitGroupEpochRekey(
  client: WorkerAClient,
  groupId: string,
  expectedEpoch: number,
): Promise<{
  group_id: string;
  previous_epoch: number;
  new_epoch: number;
  rekey_scheduled: false;
  wrapped_count: number;
  deferred_count?: number;
}> {
  return client.commitGroupRekey(groupId, { expected_epoch: expectedEpoch });
}

/**
 * OWNER-KEY-5：群主节点服务端换钥。
 * Worker 单次最多代封 32 人（Free CPU）；本 helper 轮询至 remaining_unsealed=0 并 commit。
 */
export async function ownerServerRekey(
  client: WorkerAClient,
  groupId: string,
  expectedEpoch: number,
  opts?: {
    readonly onProgress?: (p: {
      readonly sealed_batch: number;
      readonly remaining_unsealed: number;
      readonly wrapped_count: number;
    }) => void;
  },
): Promise<Awaited<ReturnType<WorkerAClient['ownerGroupRekey']>>> {
  // 安全上限：2000 人 / 32 ≈ 63 批；再加余量防脏数据死循环
  const maxRounds = 80;
  let last: Awaited<ReturnType<WorkerAClient['ownerGroupRekey']>> | null = null;
  for (let round = 0; round < maxRounds; round++) {
    last = await client.ownerGroupRekey(groupId, {
      expected_epoch: expectedEpoch,
      commit: true,
    });
    opts?.onProgress?.({
      sealed_batch: last.sealed,
      remaining_unsealed: last.remaining_unsealed,
      wrapped_count: last.wrapped_count,
    });
    if (last.committed || last.remaining_unsealed <= 0) {
      return last;
    }
  }
  throw new Error(
    last
      ? `服务端换钥未完成：仍有 ${last.remaining_unsealed} 人待代封`
      : '服务端换钥未完成',
  );
}

/** 服务端换钥不可用时回落浏览器 Batch（缺 wrap secret / 非群主节点）。 */
export function shouldFallbackBrowserRekeyWrap(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = 'code' in err && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : '';
  return (
    code === 'GROUP_OWNER_KEY_WRAP_SECRET_MISSING' ||
    code === 'GROUP_OWNER_KEY_MISSING' ||
    code === 'GROUP_NOT_MEMBER'
  );
}

export type { GroupPlaintextRecord, GroupMediaView, LocalGroupItem, GroupLocalMessageItem, GroupLocalMessagesResponse };

interface GroupPlaintextPayloadV1 {
  readonly v: 1;
  readonly text: string;
  readonly media_meta?: readonly {
    readonly media_id: string;
    readonly mime: string;
    readonly width?: number;
    readonly height?: number;
  }[];
  /** GRP-NICKNAME-1：发送者在本群自设的昵称（明文在内层，已受 E2EE 保护）。 */
  readonly nickname?: string;
}

function serializeGroupPlaintextPayload(
  text: string,
  mediaMeta?: GroupPlaintextPayloadV1['media_meta'],
  nickname?: string,
): string {
  const trimmedNickname = (nickname ?? '').trim();
  // 无媒体、无昵称时保持旧版纯文本，兼容旧客户端与旧缓存
  if (!mediaMeta?.length && !trimmedNickname) return text;
  return JSON.stringify({
    v: 1,
    text,
    ...(mediaMeta?.length ? { media_meta: mediaMeta } : {}),
    ...(trimmedNickname ? { nickname: trimmedNickname } : {}),
  } satisfies GroupPlaintextPayloadV1);
}

function parseGroupPlaintextPayload(raw: string): {
  text: string;
  mediaMeta?: GroupPlaintextPayloadV1['media_meta'];
  nickname?: string;
} {
  try {
    const parsed = JSON.parse(raw) as GroupPlaintextPayloadV1;
    if (parsed?.v === 1 && typeof parsed.text === 'string') {
      // 旧版 JSON 没有 nickname；非字符串一律按未设置处理
      const nickname = typeof parsed.nickname === 'string' ? parsed.nickname.trim() : '';
      return { text: parsed.text, mediaMeta: parsed.media_meta, nickname: nickname || undefined };
    }
  } catch {
    // 旧版纯文本
  }
  return { text: raw };
}

async function readImageDimensions(file: File): Promise<{ width?: number; height?: number }> {
  if (typeof window === 'undefined') return {};
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({});
    };
    img.src = url;
  });
}

export async function listGroups(client: WorkerAClient): Promise<readonly LocalGroupItem[]> {
  const data = await client.listLocalGroups();
  return data.items;
}

export async function listGroupMessages(
  client: WorkerAClient,
  groupId: string,
  params?: { limit?: number; cursor?: string },
): Promise<GroupLocalMessagesResponse> {
  return client.listLocalGroupMessages(groupId, params);
}

/**
 * OWNER-KEY-2：群主会话在解出明文群钥后，若持钥表未落盘则一次性 bootstrap。
 * 非群主 / 缺 secret / 已 held → 静默跳过。
 */
async function maybeBootstrapOwnerEpochKey(
  client: WorkerAClient,
  groupId: string,
  epoch: number,
  groupKey: Uint8Array,
): Promise<void> {
  try {
    const status = await client.getGroupOwnerEpochKey(groupId, epoch);
    if (status.held) return;
    await client.putGroupOwnerEpochKey(groupId, {
      epoch,
      group_key_hex: bytesToHex(groupKey),
    });
  } catch {
    // 非群主、未配 GROUP_OWNER_KEY_WRAP_SECRET、或网络失败 — 不挡聊天
  }
}

export async function createGroupWithKeys(
  client: WorkerAClient,
  passwordHash: string,
  input: { name: string; announcement?: string },
): Promise<{ group: Awaited<ReturnType<WorkerAClient['createGroup']>>; groupKey: Uint8Array }> {
  void passwordHash; // 写路径挂 vault；参数保留兼容 UI
  const vault = requireVaultWrapMaterial();
  const group = await client.createGroup({
    name: input.name,
    announcement: input.announcement,
  });
  // OWNER-KEY-2：优先用服务端生成并已写入持钥表的钥；否则本机生成并尝试 bootstrap
  let groupKey: Uint8Array;
  const serverHex =
    typeof group.group_key_hex === 'string' ? group.group_key_hex.trim().toLowerCase() : '';
  if (group.owner_key_held && /^[0-9a-f]{64}$/.test(serverHex)) {
    groupKey = hexToBytes(serverHex);
  } else {
    groupKey = await generateGroupKey();
    await maybeBootstrapOwnerEpochKey(client, group.group_id, group.epoch, groupKey);
  }
  const wrapped = await wrapGroupKey(groupKey, vault, group.group_id, group.epoch);
  await client.putGroupWrappedKey(group.group_id, {
    epoch: group.epoch,
    wrapped_key_json: JSON.stringify(wrapped),
  });
  setGroupSessionKey(group.group_id, group.epoch, groupKey);
  return { group, groupKey };
}

export async function hydrateGroupKeys(
  client: WorkerAClient,
  passwordHash: string,
  groupId: string,
  epoch?: number,
): Promise<void> {
  let { items } = await client.listGroupWrappedKeys(groupId, epoch);
  // EPOCH v0.3 P1：本地缺当前 epoch wrap 时向群主 Fast-Pull
  if ((!items || items.length === 0) && epoch != null && epoch > 0) {
    try {
      const pulled = await client.fastPullGroupKey(groupId, epoch);
      items = [
        {
          epoch: pulled.epoch,
          member_worker_b_url: pulled.member_worker_b_url,
          wrapped_key_json: pulled.wrapped_key_json,
          updated_at: new Date().toISOString(),
        },
      ];
    } catch {
      // 密钥尚未分发时保持空；UI 继续 pending
    }
  } else if (items.length > 0 && epoch != null && epoch > 0) {
    // EPOCH-UX-2：已有 wrap 仍走一次 fast-pull，触发本机 pending_key→active
    try {
      await client.fastPullGroupKey(groupId, epoch);
    } catch {
      // 翻态失败不挡本地解密
    }
  }
  for (const item of items) {
    const wrapped = JSON.parse(item.wrapped_key_json) as GroupWrappedKeyJson;
    const groupKey = await unwrapGroupKeyFlexible(wrapped, groupId, passwordHash);
    setGroupSessionKey(groupId, item.epoch, groupKey);
    // OWNER-KEY-2：老群首次打开 → 把会话明文上传到群主持钥表（一次性）
    await maybeBootstrapOwnerEpochKey(client, groupId, item.epoch, groupKey);
  }
}

/** EPOCH-UX-2：需要解包 / 补钥的 key_state（含 pending，不只 active） */
function needsGroupKeyHydration(keyState: string): boolean {
  return (
    keyState === 'active' ||
    keyState === 'pending_key' ||
    keyState === 'epoch_rotation_pending'
  );
}

export async function hydrateAllGroupKeys(
  client: WorkerAClient,
  passwordHash: string,
  /** 已拉到的群列表可复用，避免首屏再打一次 listGroups */
  knownGroups?: readonly LocalGroupItem[],
): Promise<void> {
  const groups = knownGroups ?? (await listGroups(client));
  // UX-MSG-PERF：各群密钥并行解包；EPOCH-UX-2 含 pending_key 以便 Fast-Pull 翻态
  await Promise.allSettled(
    groups
      .filter((g) => needsGroupKeyHydration(g.key_state))
      .map((g) => hydrateGroupKeys(client, passwordHash, g.group_id, g.epoch)),
  );
}

async function resolveGroupKey(
  groupId: string,
  epoch: number,
  passwordHash: string,
  client: WorkerAClient,
): Promise<Uint8Array> {
  const cached = getGroupSessionKey(groupId, epoch);
  if (cached) return cached;
  try {
    await hydrateGroupKeys(client, passwordHash, groupId, epoch);
  } catch {
    // unwrap 失败：保险箱未开、或存量仍挂旧 password 且材料不匹配（至 M-VAULT-7）
    throw new Error(
      '群密钥无法解锁。请重新登录打开保险箱；若仍失败，可能是改密前创建的旧包裹，待迁移后再试',
    );
  }
  const loaded = getGroupSessionKey(groupId, epoch);
  if (!loaded) {
    throw new Error('群密钥未就绪，请等待密钥分发或先同步');
  }
  return loaded;
}

/**
 * 存量迁移辅助：旧材料解包 → vault 重包。
 * 改密主路径已不再调用（M-VAULT-4）；M-VAULT-7 可复用。
 */
export async function rewrapAllGroupKeys(
  client: WorkerAClient,
  oldPasswordHash: string,
  newPasswordHash: string,
): Promise<void> {
  void newPasswordHash;
  const vault = requireVaultWrapMaterial();
  const groups = await listGroups(client);
  for (const g of groups) {
    if (g.key_state !== 'active') continue;
    const { items } = await client.listGroupWrappedKeys(g.group_id, g.epoch);
    for (const item of items) {
      const wrapped = JSON.parse(item.wrapped_key_json) as GroupWrappedKeyJson;
      const groupKey = await unwrapGroupKeyFlexible(wrapped, g.group_id, oldPasswordHash);
      const next = await wrapGroupKey(groupKey, vault, g.group_id, item.epoch);
      await client.putGroupWrappedKey(g.group_id, {
        epoch: item.epoch,
        wrapped_key_json: JSON.stringify(next),
      });
      setGroupSessionKey(g.group_id, item.epoch, groupKey);
    }
  }
}

function aadFromLocalMessage(
  row: GroupLocalMessageItem,
  ownerWorkerBUrl: string,
): GroupMessageAadInput {
  return {
    group_id: row.group_id,
    message_id: row.message_id,
    epoch: row.epoch,
    sender_handle: row.sender_handle,
    sender_worker_b_url: row.sender_worker_b_url,
    owner_worker_b_url: ownerWorkerBUrl,
    msg_kind: row.msg_kind as 'chat' | 'system',
  };
}

async function hydrateGroupMediaView(
  client: WorkerAClient,
  row: GroupLocalMessageItem,
  groupKey: Uint8Array,
  mediaMeta: NonNullable<GroupPlaintextPayloadV1['media_meta']>[number],
  envelopeMedia: MessagingMediaSigned,
  meWorkerBUrl: string,
): Promise<GroupMediaView | null> {
  try {
    const cipher = await fetchGroupMessagingCiphertext(client, {
      groupId: row.group_id,
      messageId: row.message_id,
      envelopeMedia,
      senderWorkerBUrl: row.sender_worker_b_url,
      meWorkerBUrl,
    });
    const plainBytes = await decryptMessagingMediaBytes(
      cipher,
      groupKey,
      row.message_id,
      envelopeMedia.media_id,
      envelopeMedia.ciphertext_sha256,
    );
    const blob = new Blob([new Uint8Array(plainBytes)], { type: mediaMeta.mime || 'image/jpeg' });
    return {
      media_id: mediaMeta.media_id,
      mime: mediaMeta.mime,
      width: mediaMeta.width,
      height: mediaMeta.height,
      object_url: URL.createObjectURL(blob),
    };
  } catch {
    return null;
  }
}

export async function decryptGroupLocalMessage(
  row: GroupLocalMessageItem,
  ownerWorkerBUrl: string,
  passwordHash: string,
  client: WorkerAClient,
  meWorkerBUrl: string,
): Promise<GroupPlaintextRecord> {
  // system 消息：服务端 UTF-8 base64 明文，全群可见，不走 AES-GCM（§9.4）
  if (row.msg_kind === 'system') {
    const cached = await getGroupPlaintext(row.message_id);
    if (cached?.msg_kind === 'system') return cached;
    const record: GroupPlaintextRecord = {
      message_id: row.message_id,
      group_id: row.group_id,
      sender_handle: row.sender_handle,
      plaintext: decodeGroupSystemPlaintext(row.ciphertext),
      created_at: row.created_at,
      msg_kind: 'system',
    };
    await saveGroupPlaintext(record);
    return record;
  }

  const cached = await getGroupPlaintext(row.message_id);
  if (cached && (!row.media || (cached.media?.length ?? 0) > 0)) {
    return cached;
  }
  const groupKey = await resolveGroupKey(row.group_id, row.epoch, passwordHash, client);
  const plaintextRaw = await decryptGroupPlaintext(
    row.ciphertext,
    groupKey,
    aadFromLocalMessage(row, ownerWorkerBUrl),
  );
  const parsed = parseGroupPlaintextPayload(plaintextRaw);

  let media: readonly GroupMediaView[] | undefined = cached?.media;
  if (row.media && parsed.mediaMeta?.[0]) {
    const view = await hydrateGroupMediaView(
      client,
      row,
      groupKey,
      parsed.mediaMeta[0],
      row.media,
      meWorkerBUrl,
    );
    media = view ? [view] : undefined;
  }

  const record: GroupPlaintextRecord = {
    message_id: row.message_id,
    group_id: row.group_id,
    sender_handle: row.sender_handle,
    ...(parsed.nickname ? { sender_nickname: parsed.nickname } : {}),
    plaintext: parsed.text,
    created_at: row.created_at,
    media,
  };
  await saveGroupPlaintext(record);
  return record;
}

export interface SendGroupMessageInput {
  readonly client: WorkerAClient;
  readonly passwordHash: string;
  readonly senderHandle: string;
  /** GRP-NICKNAME-1：本群昵称（可选，随消息密文下发）。 */
  readonly senderNickname?: string;
  readonly senderWorkerBUrl: string;
  readonly groupId: string;
  readonly ownerWorkerBUrl: string;
  readonly epoch: number;
  readonly plaintext: string;
  readonly imageFile?: File;
}

export async function sendGroupMessage(input: SendGroupMessageInput): Promise<GroupPlaintextRecord> {
  const trimmed = input.plaintext.trim();
  if (!trimmed && !input.imageFile) throw new Error('消息不能为空');
  if (input.imageFile && input.imageFile.size > MAX_GROUP_IMAGE_BYTES) {
    throw new Error('图片过大，请压缩后重试');
  }

  const groupKey = await resolveGroupKey(
    input.groupId,
    input.epoch,
    input.passwordHash,
    input.client,
  );

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + GROUP_MESSAGE_TTL_MS).toISOString();
  const messageId = newGroupMessageId();
  // GRP-NICKNAME-1：归一化后随密文下发；为空则不写字段（回落 @handle）
  const senderNickname = normalizeGroupNickname(input.senderNickname ?? '');

  let mediaBlock: MessagingMediaSigned | undefined;
  let mediaMeta: GroupPlaintextPayloadV1['media_meta'];
  let mediaViews: readonly GroupMediaView[] | undefined;

  if (input.imageFile) {
    const cap = await input.client.getMessagingCloudCapability();
    if (!cap.can_send_group_media) {
      throw new Error('群图发送须配置可用的云存储（Filebase/B2/R2）');
    }
    const mediaId = newClientMessagingMediaId();
    const mime = input.imageFile.type || 'image/jpeg';
    const dims = await readImageDimensions(input.imageFile);
    const plainBytes = await input.imageFile.arrayBuffer();
    const encrypted = await encryptMessagingMediaBytes(plainBytes, groupKey, messageId, mediaId);
    const uploaded = await uploadGroupMessagingMedia(input.client, {
      mediaId,
      plainMime: mime,
      ciphertext: encrypted.ciphertext,
    });
    mediaBlock = buildMessagingMediaSigned({
      mediaId: uploaded.media_id,
      senderStorageKey: uploaded.storage_key,
      senderWorkerBUrl: input.senderWorkerBUrl,
      sizeBytes: uploaded.size_bytes,
      ciphertextSha256: encrypted.ciphertextSha256,
    });
    mediaMeta = [{ media_id: uploaded.media_id, mime, width: dims.width, height: dims.height }];
    mediaViews = [
      {
        media_id: uploaded.media_id,
        mime,
        width: dims.width,
        height: dims.height,
        object_url: URL.createObjectURL(new Blob([new Uint8Array(plainBytes)], { type: mime })),
      },
    ];
  }

  const header: Omit<GroupMessageEnvelope, 'sig' | 'ciphertext'> = {
    v: 1,
    kind: 'GROUP_MESSAGE',
    group_id: input.groupId,
    message_id: messageId,
    epoch: input.epoch,
    sender_handle: input.senderHandle.trim().toLowerCase(),
    sender_worker_b_url: input.senderWorkerBUrl,
    owner_worker_b_url: input.ownerWorkerBUrl,
    created_at: createdAt,
    expires_at: expiresAt,
    nonce: randomDmNonceHex(16),
    msg_kind: 'chat',
    ...(mediaBlock ? { media: mediaBlock } : {}),
  };
  const ciphertext = await encryptGroupPlaintext(
    serializeGroupPlaintextPayload(trimmed, mediaMeta, senderNickname),
    groupKey,
    groupMessageAadFromEnvelope({ ...header, ciphertext: '' }),
  );
  const signed = await input.client.signGroupEnvelope({ ...header, ciphertext });
  await input.client.sendGroupMessage(input.groupId, signed);

  const record: GroupPlaintextRecord = {
    message_id: signed.message_id,
    group_id: input.groupId,
    sender_handle: signed.sender_handle,
    ...(senderNickname ? { sender_nickname: senderNickname } : {}),
    plaintext: trimmed,
    created_at: createdAt,
    media: mediaViews,
  };
  await saveGroupPlaintext(record);
  return record;
}

export async function syncGroup(
  client: WorkerAClient,
  groupId: string,
  input?: { cursor?: string | null; acks?: readonly string[]; heartbeat?: boolean },
): Promise<GroupSyncDown> {
  return client.syncGroup(groupId, input);
}

export async function joinGroupByInvite(
  client: WorkerAClient,
  passwordHash: string,
  input: {
    groupId?: string;
    ownerWorkerBUrl: string;
    inviteToken: string;
    wrappedKeyJson?: string;
  },
): Promise<Awaited<ReturnType<WorkerAClient['acceptGroupInvite']>>> {
  // SEC-AUDIT-2026-10-15：入群前确保本机 DH 就绪并随请求提交
  await ensureDmIdentity(client, passwordHash);
  const identity = await getDmIdentity();
  const dh = (identity?.public_key_hex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dh)) {
    throw new Error('本机 DH 公钥未就绪，无法入群');
  }
  return client.acceptGroupInvite(input.groupId ?? null, {
    owner_worker_b_url: input.ownerWorkerBUrl,
    invite_token: input.inviteToken,
    member_dh_pubkey: dh,
    wrapped_key_json: input.wrappedKeyJson,
  });
}

/** M16-JOIN-POLICY-2/3：按固定群号加入。 */
export async function joinGroupById(
  client: WorkerAClient,
  passwordHash: string,
  input: {
    groupId: string;
    ownerWorkerBUrl: string;
    wrappedKeyJson?: string;
  },
): Promise<Awaited<ReturnType<WorkerAClient['joinGroup']>>> {
  await ensureDmIdentity(client, passwordHash);
  const identity = await getDmIdentity();
  const dh = (identity?.public_key_hex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dh)) {
    throw new Error('本机 DH 公钥未就绪，无法入群');
  }
  return client.joinGroup({
    owner_worker_b_url: input.ownerWorkerBUrl,
    group_id: input.groupId,
    member_dh_pubkey: dh,
    wrapped_key_json: input.wrappedKeyJson,
  });
}

export async function createGroupInvite(
  client: WorkerAClient,
  groupId: string,
  opts?: Parameters<WorkerAClient['createGroupInvite']>[1],
): Promise<Awaited<ReturnType<WorkerAClient['createGroupInvite']>>> {
  return client.createGroupInvite(groupId, opts);
}

export async function leaveGroup(
  client: WorkerAClient,
  groupId: string,
): Promise<Awaited<ReturnType<WorkerAClient['leaveGroup']>>> {
  return client.leaveGroup(groupId);
}

/** M16-7a：群主解散群（写 dissolved_at，成员经 sync 获知）。 */
export async function dissolveGroup(
  client: WorkerAClient,
  groupId: string,
): Promise<Awaited<ReturnType<WorkerAClient['dissolveGroup']>>> {
  return client.dissolveGroup(groupId);
}

export async function updateGroupLocalSettings(
  client: WorkerAClient,
  groupId: string,
  localRetentionDays: number,
): Promise<Awaited<ReturnType<WorkerAClient['putGroupLocalSettings']>>> {
  return client.putGroupLocalSettings(groupId, { local_retention_days: localRetentionDays });
}

/** UX-GROUPS-7b：群主改群名称（群号 group_id 不可改）。 */
export async function updateGroupName(
  client: WorkerAClient,
  groupId: string,
  name: string,
): Promise<Awaited<ReturnType<WorkerAClient['putGroupName']>>> {
  return client.putGroupName(groupId, name);
}

/** UX-GROUPS-7c：群主或管理员改公告（assertGroupOwnerOrAdmin，比群名收敛）。 */
export async function updateGroupAnnouncement(
  client: WorkerAClient,
  groupId: string,
  announcement: string,
): Promise<Awaited<ReturnType<WorkerAClient['putGroupAnnouncement']>>> {
  return client.putGroupAnnouncement(groupId, announcement);
}

/** UX-GROUPS-7e：群主任命/撤销管理员（透传到 client.putGroupAdmin）。 */
export async function setGroupAdmin(
  client: WorkerAClient,
  groupId: string,
  input: { member_worker_b_url: string; is_admin: boolean },
): Promise<Awaited<ReturnType<WorkerAClient['putGroupAdmin']>>> {
  return client.putGroupAdmin(groupId, input);
}

/**
 * MOD-1：踢人先隔绝，完整换钥交由 REKEY；不得用未分发新钥覆盖当前 epoch 缓存。
 */
export async function kickGroupMember(
  client: WorkerAClient,
  groupId: string,
  memberWorkerBUrl: string,
  options?: {
    expectedEpoch: number;
    meWorkerBUrl: string;
  },
): Promise<Awaited<ReturnType<WorkerAClient['kickGroupMember']>>> {
  const expectedEpoch = options?.expectedEpoch ?? 0;
  return client.kickGroupMember(groupId, memberWorkerBUrl, {
    expected_epoch: expectedEpoch > 0 ? expectedEpoch : undefined,
  });
}

/** UX-GROUPS-7g：拉群成员列表（透传到 client.listGroupMembers）。GRP-MEMBER-PAGE-1：可选分页 / 裁剪字段。 */
export async function listGroupMembers(
  client: WorkerAClient,
  groupId: string,
  params?: { readonly limit?: number; readonly offset?: number; readonly includeDh?: boolean },
): Promise<Awaited<ReturnType<WorkerAClient['listGroupMembers']>>> {
  return client.listGroupMembers(groupId, params);
}

/** M16-7d：Settings 打开前拉取 MESSAGING_DB 容量粗算。 */
export async function fetchMessagingDbCapacity(
  client: WorkerAClient,
): Promise<Awaited<ReturnType<WorkerAClient['getMessagingDbCapacity']>>> {
  return client.getMessagingDbCapacity();
}

export async function pollAndDecryptGroupMessages(
  client: WorkerAClient,
  groupId: string,
  passwordHash: string,
  ownerWorkerBUrl: string,
  meWorkerBUrl: string,
): Promise<GroupPlaintextRecord[]> {
  const page = await listGroupMessages(client, groupId, { limit: 50 });
  const out: GroupPlaintextRecord[] = [];
  for (const row of page.items) {
    try {
      out.push(
        await decryptGroupLocalMessage(row, ownerWorkerBUrl, passwordHash, client, meWorkerBUrl),
      );
    } catch {
      // 单条解密失败不阻断轮询
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** M-RT-3：游标分页 — cursor=null/空取首页，cursor=字符串取更早一页（解密入 IDB）。 */
export async function loadOlderGroupPlaintexts(
  client: WorkerAClient,
  groupId: string,
  passwordHash: string,
  ownerWorkerBUrl: string,
  meWorkerBUrl: string,
  cursor: string | null,
): Promise<{ items: readonly GroupPlaintextRecord[]; nextCursor: string | null; hasMore: boolean }> {
  const page = await listGroupMessages(client, groupId, { limit: 50, cursor: cursor ?? undefined });
  const out: GroupPlaintextRecord[] = [];
  for (const row of page.items) {
    try {
      const record = await decryptGroupLocalMessage(
        row,
        ownerWorkerBUrl,
        passwordHash,
        client,
        meWorkerBUrl,
      );
      out.push(record);
    } catch {
      // 单条解密失败不阻断整页
    }
  }
  return {
    items: out.sort((a, b) => a.created_at.localeCompare(b.created_at)),
    nextCursor: page.has_more ? page.cursor : null,
    hasMore: page.has_more,
  };
}

export async function listDecryptedPlaintexts(groupId: string): Promise<GroupPlaintextRecord[]> {
  const rows = await listGroupPlaintexts(groupId);
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
