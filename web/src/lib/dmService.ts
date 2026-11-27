/**
 * M10-4：私信发送、解密、hydrate 编排（浏览器端）。
 */
import { randomDmNonceHex } from '@hailuo/shared-crypto';
import type { DmEnvelope, MessagingMediaSigned } from '@hailuo/shared-types';
import {
  buildMessagingMediaSigned,
  decryptMessagingMediaBytes,
  encryptMessagingMediaBytes,
} from '@hailuo/shared-crypto';
import { ApiError } from './errors';
import {
  decryptDmCiphertext,
  deriveConversationId,
  deriveIdentityPublicKeyHex,
  deriveMessageKeyForReceive,
  deriveMessageKeyForSend,
  encryptDmPlaintext,
  generateDmIdentityKeyPair,
  generateEphemeralKeyPair,
  newDmMessageId,
  unwrapIdentityPrivateKey,
  unwrapSessionKeyPayload,
  wrapIdentityPrivateKey,
  wrapSessionKeyPayload,
  type DmSessionKeyPayload,
  type DmWrappedIdentityJson,
  type DmWrappedKeyJson,
} from './dmCrypto';
import {
  deleteDmPlaintextByConversation,
  deleteDmSessionKeysByConversation,
  getDmIdentity,
  getDmPlaintext,
  getDmSessionKey,
  listDmPlaintexts,
  listDmSessionKeys,
  messageKeyFromHex,
  messageKeyToHex,
  saveDmIdentity,
  saveDmPlaintext,
  saveDmSessionKey,
  type DmMediaView,
  type DmPlaintextRecord,
  type DmSessionKeyRecord,
} from './dmLocalDb';
import { createWorkerBClient } from './api';
import type { createWorkerAClient, DmMessageItem, DmWrappedKeyItem } from './workerA';
import { setDmLegacyIdentityPending } from './dmSession';
import { businessUnwrapMaterials, requireVaultWrapMaterial } from './vaultWrapMaterial';
import {
  fetchDmMessagingCiphertext,
  newClientMessagingMediaId,
  uploadDmMessagingMedia,
} from './messagingMediaClient';
import {
  isCallSignalPayload,
  type CallSignalPayload,
} from './rtc/types';

type WorkerAClient = ReturnType<typeof createWorkerAClient>;
/** 兼容旧调用方传入的浏览器 Worker B client；DM-PEER-PUBKEY-1 起不再用于投递。 */
type WorkerBClient = ReturnType<typeof createWorkerBClient>;

async function unwrapIdentityFlexible(
  wrapped: DmWrappedIdentityJson,
  passwordHash?: string | null,
): Promise<string> {
  const materials = businessUnwrapMaterials(passwordHash);
  if (materials.length === 0) throw new Error('缺少密钥材料，无法解开私信身份');
  let last: unknown;
  for (const material of materials) {
    try {
      return await unwrapIdentityPrivateKey(wrapped, material);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('无法解开私信身份包裹');
}

/** 解开会话密钥包裹并保留 pub/priv；旧 32 字节包裹只有 message_key_hex。 */
async function unwrapSessionPayloadFlexible(
  wrapped: DmWrappedKeyJson,
  conversationId: string,
  passwordHash?: string | null,
): Promise<DmSessionKeyPayload> {
  const materials = businessUnwrapMaterials(passwordHash);
  if (materials.length === 0) throw new Error('缺少密钥材料，无法解开私信会话钥');
  let last: unknown;
  for (const material of materials) {
    try {
      return await unwrapSessionKeyPayload(wrapped, material, conversationId);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('无法解开私信会话钥包裹');
}

export interface DmConversationSummary {
  readonly conversation_id: string;
  readonly peer_handle: string;
  readonly last_message_at: string;
  readonly last_preview: string;
  readonly unread_count: number;
}

const KEY_EPOCH = 1;

/**
 * 会话密钥包裹列表短缓存：一次收/发同步会解密几十条，逐条拉 `/api/dm/wrapped-keys`
 * 会让 1s 轮询变成几十个子请求。5s TTL + 写后失效足够。
 */
const WRAPPED_KEYS_TTL_MS = 5_000;
let wrappedKeysCache: { at: number; items: readonly DmWrappedKeyItem[] } | null = null;

async function listDmWrappedKeysCached(
  client: WorkerAClient,
): Promise<readonly DmWrappedKeyItem[]> {
  if (wrappedKeysCache && Date.now() - wrappedKeysCache.at < WRAPPED_KEYS_TTL_MS) {
    return wrappedKeysCache.items;
  }
  const { items } = await client.listDmWrappedKeys();
  wrappedKeysCache = { at: Date.now(), items };
  return items;
}

function invalidateWrappedKeysCache(): void {
  wrappedKeysCache = null;
}
const MAX_DM_IMAGE_BYTES = 10 * 1024 * 1024;
/** M10-P3：短语音条上限（与 Messaging Media KV 兜底兼容）。 */
export const MAX_DM_VOICE_BYTES = 5 * 1024 * 1024;
export const MAX_DM_VOICE_DURATION_MS = 60_000;

interface DmPlaintextPayloadV1 {
  readonly v: 1;
  readonly text: string;
  readonly media_meta?: readonly {
    readonly media_id: string;
    readonly mime: string;
    readonly width?: number;
    readonly height?: number;
    readonly duration_ms?: number;
  }[];
}

export type DecryptedDmContent =
  | { readonly kind: 'chat'; readonly text: string }
  | {
      readonly kind: 'call_signal';
      readonly signal: CallSignalPayload;
    };

function isAudioMime(mime: string | undefined): boolean {
  return Boolean(mime?.startsWith('audio/'));
}

/** 会话列表预览：无正文时按媒体类型占位。 */
export function dmMediaListPreview(media?: readonly DmMediaView[]): string {
  if (!media?.length) return '';
  return isAudioMime(media[0]?.mime) ? '[语音]' : '[图片]';
}

function serializeDmPlaintextPayload(
  text: string,
  mediaMeta?: DmPlaintextPayloadV1['media_meta'],
): string {
  if (!mediaMeta?.length) return text;
  const payload: DmPlaintextPayloadV1 = { v: 1, text, media_meta: mediaMeta };
  return JSON.stringify(payload);
}

function serializeCallSignalPayload(signal: CallSignalPayload): string {
  return JSON.stringify(signal);
}

function parseDmPlaintextPayload(raw: string): {
  text: string;
  mediaMeta?: DmPlaintextPayloadV1['media_meta'];
  callSignal?: CallSignalPayload;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isCallSignalPayload(parsed)) {
      return { text: '', callSignal: parsed };
    }
    const chat = parsed as DmPlaintextPayloadV1;
    if (chat?.v === 1 && typeof chat.text === 'string') {
      return { text: chat.text, mediaMeta: chat.media_meta };
    }
  } catch {
    // 旧版纯文本 ciphertext
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

async function hydrateDmMediaView(
  client: WorkerAClient,
  item: DmMessageItem,
  messageKey: Uint8Array,
  mediaMeta: NonNullable<DmPlaintextPayloadV1['media_meta']>[number],
  envelopeMedia: MessagingMediaSigned,
): Promise<DmMediaView | null> {
  try {
    const cipher = await fetchDmMessagingCiphertext(client, {
      envelopeMedia,
      messageId: item.message_id,
      conversationId: item.conversation_id,
      direction: item.direction,
    });
    const plainBytes = await decryptMessagingMediaBytes(
      cipher,
      messageKey,
      item.message_id,
      envelopeMedia.media_id,
      envelopeMedia.ciphertext_sha256,
    );
    const plainView = new Uint8Array(plainBytes);
    const blob = new Blob([plainView], { type: mediaMeta.mime || 'image/jpeg' });
    return {
      media_id: mediaMeta.media_id,
      mime: mediaMeta.mime,
      width: mediaMeta.width,
      height: mediaMeta.height,
      duration_ms: mediaMeta.duration_ms,
      object_url: URL.createObjectURL(blob),
    };
  } catch {
    return null;
  }
}

export type DmIdentityHydrateResult = 'restored' | 'created' | 'legacy_pending';

/**
 * 登录 hydrate：从 D1 包裹身份恢复或首次创建，禁止静默覆盖存量 dm_pubkey。
 * M-VAULT-5：新建/写回挂 vault；解开先试 vault，再试 password_hash（至 M-VAULT-7）。
 */
export async function hydrateDmWrappedIdentity(
  client: WorkerAClient,
  passwordHash: string,
): Promise<DmIdentityHydrateResult> {
  const me = await client.getMe();
  const local = await getDmIdentity();
  if (local) {
    const pub = await deriveIdentityPublicKeyHex(local.private_key_hex);
    if (!me.dm_pubkey) {
      // DM-PEER-PUBKEY-1：本地有私钥但服务端 users.dm_pubkey 为空。
      // 旧逻辑直接返回 restored，导致公开资料永远没有 dm_pubkey（对端一直报未配置）。
      // 这里补登记公钥；PUT /api/me/dm-pubkey 会同步 users.dm_pubkey + STATE_KV。
      await client.setDmPubkey(pub);
      setDmLegacyIdentityPending(false);
      return 'restored';
    }
    if (pub.toLowerCase() === me.dm_pubkey.toLowerCase()) {
      setDmLegacyIdentityPending(false);
      return 'restored';
    }
  }

  const remote = await client.getDmWrappedIdentity();
  if (remote) {
    const wrapped = JSON.parse(remote.wrapped_identity_json) as DmWrappedIdentityJson;
    const privateKeyHex = await unwrapIdentityFlexible(wrapped, passwordHash);
    const pubHex = await deriveIdentityPublicKeyHex(privateKeyHex);
    if (pubHex.toLowerCase() !== remote.public_key_hex.toLowerCase()) {
      throw new Error('云端身份包裹校验失败');
    }
    if (me.dm_pubkey && me.dm_pubkey.toLowerCase() !== pubHex.toLowerCase()) {
      throw new Error('身份公钥与节点登记不一致');
    }
    await saveDmIdentity({ public_key_hex: pubHex, private_key_hex: privateKeyHex });
    if (!me.dm_pubkey) {
      // 服务端 users.dm_pubkey 为空（历史从云端恢复的路径漏登记）→ 补登记公开公钥，
      // 否则对端永远拿不到 dm_pubkey（DM-PEER-PUBKEY-1）。
      await client.setDmPubkey(pubHex);
    }
    setDmLegacyIdentityPending(false);
    return 'restored';
  }

  if (me.dm_pubkey) {
    setDmLegacyIdentityPending(true);
    return 'legacy_pending';
  }

  const vault = requireVaultWrapMaterial();
  const pair = await generateDmIdentityKeyPair();
  const wrappedJson = await wrapIdentityPrivateKey(pair.privateKeyHex, vault);
  await client.putDmWrappedIdentity({
    public_key_hex: pair.publicKeyHex,
    wrapped_identity_json: JSON.stringify(wrappedJson),
  });
  await saveDmIdentity({
    public_key_hex: pair.publicKeyHex,
    private_key_hex: pair.privateKeyHex,
  });
  setDmLegacyIdentityPending(false);
  return 'created';
}

/** 设置页显式轮换：生成新身份并原子上传包裹 + dm_pubkey（挂 vault）。 */
export async function rotateDmIdentity(
  client: WorkerAClient,
  _passwordHash?: string,
): Promise<void> {
  const vault = requireVaultWrapMaterial();
  const pair = await generateDmIdentityKeyPair();
  const wrappedJson = await wrapIdentityPrivateKey(pair.privateKeyHex, vault);
  await client.putDmWrappedIdentity({
    public_key_hex: pair.publicKeyHex,
    wrapped_identity_json: JSON.stringify(wrappedJson),
  });
  await saveDmIdentity({
    public_key_hex: pair.publicKeyHex,
    private_key_hex: pair.privateKeyHex,
  });
  setDmLegacyIdentityPending(false);
}

/** 确保本机 X25519 身份存在（须先 hydrateDmWrappedIdentity）。 */
export async function ensureDmIdentity(client: WorkerAClient, passwordHash: string): Promise<void> {
  const result = await hydrateDmWrappedIdentity(client, passwordHash);
  if (result === 'legacy_pending') {
    throw new Error('私信身份未云端备份，请在设置中重新生成并备份');
  }
}

/** 登录后 unwrap D1 会话钥写入本机缓存（vault 优先，旧 password 可回退）。 */
export async function hydrateDmWrappedKeys(
  client: WorkerAClient,
  passwordHash: string,
): Promise<void> {
  wrappedKeysCache = null;
  const { items } = await client.listDmWrappedKeys();
  wrappedKeysCache = { at: Date.now(), items };
  for (const item of items) {
    await unwrapAndCacheSessionKey(item, passwordHash);
  }
}

/**
 * 写回本机会话钥。
 *
 * v2 包裹自带 pub/priv，直接用包裹内容；只有旧 32 字节包裹（无 pub/priv）时才在
 * 同一把 mk 的前提下继承本机 ephemeral，避免把「上一把钥的 ephemeral」错配到新钥。
 */
async function unwrapAndCacheSessionKey(
  item: DmWrappedKeyItem,
  passwordHash: string,
): Promise<void> {
  const wrapped = JSON.parse(item.wrapped_key_json) as DmWrappedKeyJson;
  const payload = await unwrapSessionPayloadFlexible(wrapped, item.conversation_id, passwordHash);
  const existing = await getDmSessionKey(item.conversation_id, item.key_epoch);
  const sameKey = existing?.message_key_hex === payload.message_key_hex;
  await saveDmSessionKey({
    key_id: `${item.conversation_id}:${item.key_epoch}`,
    conversation_id: item.conversation_id,
    key_epoch: item.key_epoch,
    peer_handle: item.peer_handle,
    message_key_hex: payload.message_key_hex,
    ephemeral_pubkey_hex: payload.ephemeral_pubkey_hex ?? (sameKey ? existing?.ephemeral_pubkey_hex : undefined),
    ephemeral_private_key_hex:
      payload.ephemeral_private_key_hex ?? (sameKey ? existing?.ephemeral_private_key_hex : undefined),
  });
}

/**
 * 改密后 re-wrap 身份私钥与会话密钥（M10-5c）。
 *
 * **P0-7 三段流（2026-09-16 闭环）**：
 *   1. **内存** unwrap 旧 wrap（oldPasswordHash）→ 私钥 → wrap newPasswordHash → newWrapped；
 *      内存 verify（unwrap newWrapped with newPasswordHash）必须等于私钥。
 *   2. **内存** 收集每条会话密钥的 newWrapped（unwrap oldPasswordHash → wrap newPasswordHash）。
 *   3. **服务器** 先 `putDmWrappedIdentity`（单原子写），再逐条 `putDmWrappedKey`。
 *      - 步骤 3 任一抛错 → throw，**本地状态不变**；旧 wrap 仍能解锁旧消息（用户可重试）。
 *      - 步骤 4 全部成功 → **本地** `saveDmIdentity` + `saveDmSessionKey`。
 *   legacy 状态（`legacy_pending`）→ 抛错，引导用户走"重新生成并备份"流程而非 rewrap。
 */
export async function rewrapAllDmSecrets(
  client: WorkerAClient,
  oldPasswordHash: string,
  newPasswordHash: string,
): Promise<void> {
  // ─── ① 内存 unwrap + wrap + verify 身份私钥 ───
  const identity = await client.getDmWrappedIdentity();
  let nextWrappedIdentityJson: string | null = null;
  let nextIdentityPublicKeyHex: string | null = null;
  let verifiedPrivateKeyHex: string | null = null;

  // M-VAULT-5：新包裹挂 vault；旧材料仅用于解开存量
  const vault = requireVaultWrapMaterial();
  void newPasswordHash; // 改密主路径已不再调用；保留参数兼容旧调用方

  if (identity) {
    const wrapped = JSON.parse(identity.wrapped_identity_json) as DmWrappedIdentityJson;
    const privateKeyHex = await unwrapIdentityFlexible(wrapped, oldPasswordHash);
    const pubHex = await deriveIdentityPublicKeyHex(privateKeyHex);
    const nextWrapped = await wrapIdentityPrivateKey(privateKeyHex, vault);
    const verified = await unwrapIdentityPrivateKey(nextWrapped, vault);
    if (verified !== privateKeyHex) {
      throw new Error('re-wrap 身份私钥验证失败（vault 不能解开 newWrapped）');
    }
    nextWrappedIdentityJson = JSON.stringify(nextWrapped);
    nextIdentityPublicKeyHex = pubHex;
    verifiedPrivateKeyHex = privateKeyHex;
  }

  // ─── ② 内存 unwrap + wrap 每条会话密钥（保留 pub/priv，换客户端仍可发信）───
  const { items } = await client.listDmWrappedKeys();
  const rewrappedKeys: Array<{
    conversation_id: string;
    key_epoch: number;
    peer_handle: string;
    wrapped_key_json: string;
    payload: DmSessionKeyPayload;
  }> = [];
  for (const item of items) {
    const wrapped = JSON.parse(item.wrapped_key_json) as DmWrappedKeyJson;
    const payload = await unwrapSessionPayloadFlexible(wrapped, item.conversation_id, oldPasswordHash);
    const next = await wrapSessionKeyPayload(payload, vault, item.conversation_id, item.key_epoch);
    const verifiedKey = await unwrapSessionKeyPayload(next, vault, item.conversation_id);
    if (
      verifiedKey.message_key_hex !== payload.message_key_hex ||
      verifiedKey.ephemeral_pubkey_hex !== payload.ephemeral_pubkey_hex ||
      verifiedKey.ephemeral_private_key_hex !== payload.ephemeral_private_key_hex
    ) {
      throw new Error(
        `re-wrap 会话密钥验证失败（conversation_id=${item.conversation_id}）`,
      );
    }
    rewrappedKeys.push({
      conversation_id: item.conversation_id,
      key_epoch: item.key_epoch,
      peer_handle: item.peer_handle,
      wrapped_key_json: JSON.stringify(next),
      payload,
    });
  }

  // ─── ③ 服务器写入（先 identity，再逐条 session key）───
  if (nextWrappedIdentityJson && nextIdentityPublicKeyHex) {
    await client.putDmWrappedIdentity({
      public_key_hex: nextIdentityPublicKeyHex,
      wrapped_identity_json: nextWrappedIdentityJson,
    });
  }
  for (const item of rewrappedKeys) {
    await client.putDmWrappedKey({
      conversation_id: item.conversation_id,
      key_epoch: item.key_epoch,
      peer_handle: item.peer_handle,
      wrapped_key_json: item.wrapped_key_json,
    });
  }
  invalidateWrappedKeysCache();

  // ─── ④ 服务器全成功后，才写本地（失败抛错时本地状态不变）───
  if (verifiedPrivateKeyHex && nextIdentityPublicKeyHex) {
    await saveDmIdentity({
      public_key_hex: nextIdentityPublicKeyHex,
      private_key_hex: verifiedPrivateKeyHex,
    });
    setDmLegacyIdentityPending(false);
  }
  for (const item of rewrappedKeys) {
    // 保留 pub/priv：改密后换客户端仍能用同一把会话钥继续发信
    await saveDmSessionKey({
      key_id: `${item.conversation_id}:${item.key_epoch}`,
      conversation_id: item.conversation_id,
      key_epoch: item.key_epoch,
      peer_handle: item.peer_handle,
      message_key_hex: item.payload.message_key_hex,
      ephemeral_pubkey_hex: item.payload.ephemeral_pubkey_hex,
      ephemeral_private_key_hex: item.payload.ephemeral_private_key_hex,
    });
  }
}

/**
 * 改密后 re-wrap 全部会话密钥（M10-3b · 仅 keys，不动 identity）。
 *
 * 行为对齐 `rewrapAllDmSecrets` 的 P0-7 三段流：
 *   1. 内存 unwrap + wrap + verify 每条
 *   2. 服务器逐条 put（任一失败抛错，已上传的不回滚）
 *   3. 服务器全成功后，本地逐条 save（任一失败抛错，**未写的不写**）
 *
 * 用于 `requires_dm_key_rewrap` 但 identity 已是 legacy 或本机尚未 hydrate 时的"只 rewrap keys"路径。
 */
export async function rewrapAllDmKeys(
  client: WorkerAClient,
  oldPasswordHash: string,
  newPasswordHash: string,
): Promise<void> {
  const vault = requireVaultWrapMaterial();
  void newPasswordHash;
  const { items } = await client.listDmWrappedKeys();
  const rewrappedKeys: Array<{
    conversation_id: string;
    key_epoch: number;
    peer_handle: string;
    wrapped_key_json: string;
    payload: DmSessionKeyPayload;
  }> = [];
  // ① 内存 unwrap + wrap + verify（新包裹挂 vault，保留 pub/priv）
  for (const item of items) {
    const wrapped = JSON.parse(item.wrapped_key_json) as DmWrappedKeyJson;
    const payload = await unwrapSessionPayloadFlexible(wrapped, item.conversation_id, oldPasswordHash);
    const next = await wrapSessionKeyPayload(payload, vault, item.conversation_id, item.key_epoch);
    const verifiedKey = await unwrapSessionKeyPayload(next, vault, item.conversation_id);
    if (
      verifiedKey.message_key_hex !== payload.message_key_hex ||
      verifiedKey.ephemeral_pubkey_hex !== payload.ephemeral_pubkey_hex ||
      verifiedKey.ephemeral_private_key_hex !== payload.ephemeral_private_key_hex
    ) {
      throw new Error(`re-wrap 会话密钥验证失败（conversation_id=${item.conversation_id}）`);
    }
    rewrappedKeys.push({
      conversation_id: item.conversation_id,
      key_epoch: item.key_epoch,
      peer_handle: item.peer_handle,
      wrapped_key_json: JSON.stringify(next),
      payload,
    });
  }
  // ② 服务器写入（任一抛错 → throw，**本地状态不变**）
  for (const item of rewrappedKeys) {
    await client.putDmWrappedKey({
      conversation_id: item.conversation_id,
      key_epoch: item.key_epoch,
      peer_handle: item.peer_handle,
      wrapped_key_json: item.wrapped_key_json,
    });
  }
  invalidateWrappedKeysCache();
  // ③ 服务器全成功后，本地写入（保留 pub/priv）
  for (const item of rewrappedKeys) {
    await saveDmSessionKey({
      key_id: `${item.conversation_id}:${item.key_epoch}`,
      conversation_id: item.conversation_id,
      key_epoch: item.key_epoch,
      peer_handle: item.peer_handle,
      message_key_hex: item.payload.message_key_hex,
      ephemeral_pubkey_hex: item.payload.ephemeral_pubkey_hex,
      ephemeral_private_key_hex: item.payload.ephemeral_private_key_hex,
    });
  }
}

interface ResolvedSendSession {
  readonly epoch: number;
  readonly messageKey: Uint8Array;
  readonly ephemeralPub: string;
}

/**
 * 发信会话钥解析（MULTI-CLIENT-KEY-1）。
 *
 * 同一 conversation + epoch 只维护一把共享钥：
 *   1. 本机缓存有 `mk + pub + priv` → 直接复用（只有自己生成过 ephemeral 才允许发信）。
 *   2. 否则从本节点 D1 包裹里找同一会话、带 `mk + pub + priv` 的最大 epoch，解开后复用。
 *   3. 都没有（首次通信 / 旧包只有裸 mk）→ 用 `max(epoch)+1` 新建，**绝不覆盖旧 epoch**，
 *      否则旧消息会因同一 epoch 换钥而永久解不开。
 */
async function resolveMessageKeyForSend(
  conversationId: string,
  peerHandle: string,
  recipientDmPubkey: string,
  passwordHash: string,
  client: WorkerAClient,
): Promise<ResolvedSendSession> {
  const localRows = (await listDmSessionKeys()).filter(
    (row) => row.conversation_id === conversationId,
  );
  // 只有“自己生成过 ephemeral 私钥”的会话钥才允许发信：接收端采纳的钥没有私钥，
  // 用它发信时对端只能靠 ECDH 推导，历史钥一旦分叉就永远解不开（2026-11-26 实测踩坑）。
  const usableLocal = localRows
    .filter(
      (row) =>
        row.message_key_hex &&
        row.ephemeral_pubkey_hex &&
        row.ephemeral_private_key_hex,
    )
    .sort((a, b) => b.key_epoch - a.key_epoch);
  if (usableLocal[0]) {
    return {
      epoch: usableLocal[0].key_epoch,
      messageKey: messageKeyFromHex(usableLocal[0].message_key_hex),
      ephemeralPub: usableLocal[0].ephemeral_pubkey_hex as string,
    };
  }

  const items = await listDmWrappedKeysCached(client);
  const remoteRows = items
    .filter((row) => row.conversation_id === conversationId)
    .sort((a, b) => b.key_epoch - a.key_epoch);
  for (const row of remoteRows) {
    try {
      const wrapped = JSON.parse(row.wrapped_key_json) as DmWrappedKeyJson;
      const payload = await unwrapSessionPayloadFlexible(wrapped, conversationId, passwordHash);
      if (
        !payload.message_key_hex ||
        !payload.ephemeral_pubkey_hex ||
        !payload.ephemeral_private_key_hex
      ) {
        continue;
      }
      await saveDmSessionKey({
        key_id: `${conversationId}:${row.key_epoch}`,
        conversation_id: conversationId,
        key_epoch: row.key_epoch,
        peer_handle: peerHandle,
        message_key_hex: payload.message_key_hex,
        ephemeral_pubkey_hex: payload.ephemeral_pubkey_hex,
        ephemeral_private_key_hex: payload.ephemeral_private_key_hex,
      });
      return {
        epoch: row.key_epoch,
        messageKey: messageKeyFromHex(payload.message_key_hex),
        ephemeralPub: payload.ephemeral_pubkey_hex,
      };
    } catch {
      // 单个包裹解不开（旧 password 世代 / 损坏）→ 尝试下一行，最后才新建
    }
  }

  const knownEpochs = [...localRows, ...remoteRows].map((row) => row.key_epoch);
  const nextEpoch = knownEpochs.length === 0 ? KEY_EPOCH : Math.max(...knownEpochs) + 1;
  const eph = await generateEphemeralKeyPair();
  const messageKey = await deriveMessageKeyForSend(
    eph.privateKeyHex,
    recipientDmPubkey,
    conversationId,
  );
  void passwordHash; // 写路径改挂 vault；参数保留兼容 SendDmInput
  const vault = requireVaultWrapMaterial();
  const wrapped = await wrapSessionKeyPayload(
    {
      message_key_hex: messageKeyToHex(messageKey),
      ephemeral_pubkey_hex: eph.publicKeyHex,
      ephemeral_private_key_hex: eph.privateKeyHex,
    },
    vault,
    conversationId,
    nextEpoch,
  );
  await client.putDmWrappedKey({
    conversation_id: conversationId,
    key_epoch: nextEpoch,
    peer_handle: peerHandle,
    wrapped_key_json: JSON.stringify(wrapped),
  });
  invalidateWrappedKeysCache();
  await saveDmSessionKey({
    key_id: `${conversationId}:${nextEpoch}`,
    conversation_id: conversationId,
    key_epoch: nextEpoch,
    peer_handle: peerHandle,
    message_key_hex: messageKeyToHex(messageKey),
    ephemeral_pubkey_hex: eph.publicKeyHex,
    ephemeral_private_key_hex: eph.privateKeyHex,
  });
  return { epoch: nextEpoch, messageKey, ephemeralPub: eph.publicKeyHex };
}

interface MessageKeyCandidate {
  readonly key: Uint8Array;
  readonly source: 'local' | 'remote' | 'derived';
  readonly payload?: DmSessionKeyPayload;
}

/**
 * 收信候选钥（按可信度排序）：本机缓存 → D1 包裹 → 信封 ephemeral + 身份私钥推导。
 * 逐把尝试解密，避免“同一 epoch 存了另一方向的钥”时静默丢消息。
 */
async function listMessageKeyCandidates(
  item: DmMessageItem,
  passwordHash: string,
  client: WorkerAClient,
): Promise<MessageKeyCandidate[]> {
  const candidates: MessageKeyCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: MessageKeyCandidate) => {
    const hex = messageKeyToHex(candidate.key).toLowerCase();
    if (seen.has(hex)) return;
    seen.add(hex);
    candidates.push(candidate);
  };

  const cached = await getDmSessionKey(item.conversation_id, item.envelope.key_epoch);
  if (cached?.message_key_hex) {
    push({ key: messageKeyFromHex(cached.message_key_hex), source: 'local' });
  }

  try {
    const items = await listDmWrappedKeysCached(client);
    const row = items.find(
      (entry) =>
        entry.conversation_id === item.conversation_id &&
        entry.key_epoch === item.envelope.key_epoch,
    );
    if (row) {
      const wrapped = JSON.parse(row.wrapped_key_json) as DmWrappedKeyJson;
      const payload = await unwrapSessionPayloadFlexible(wrapped, item.conversation_id, passwordHash);
      push({ key: messageKeyFromHex(payload.message_key_hex), source: 'remote', payload });
    }
  } catch {
    // D1 包裹不可用不阻断：下面还有 ECDH 推导
  }

  const identity = await getDmIdentity();
  if (identity) {
    try {
      const derived = await deriveMessageKeyForReceive(
        item.envelope.ephemeral_pubkey,
        identity.private_key_hex,
        item.conversation_id,
      );
      push({ key: derived, source: 'derived' });
    } catch {
      // ephemeral 公钥格式异常时跳过
    }
  }

  if (candidates.length === 0) throw new Error('私信身份未初始化');
  return candidates;
}

/** 解密成功后的收信侧缓存：不改写另一方向的同名 epoch 钥，避免互相覆盖。 */
async function cacheReceivedSessionKey(
  item: DmMessageItem,
  candidate: MessageKeyCandidate,
  client: WorkerAClient,
): Promise<void> {
  const local = await getDmSessionKey(item.conversation_id, item.envelope.key_epoch);
  const same = local?.message_key_hex === messageKeyToHex(candidate.key);
  if (!same) {
    await saveDmSessionKey({
      key_id: `${item.conversation_id}:${item.envelope.key_epoch}`,
      conversation_id: item.conversation_id,
      key_epoch: item.envelope.key_epoch,
      peer_handle: item.peer_handle,
      message_key_hex: messageKeyToHex(candidate.key),
      // 收信侧只拿到对方信封里的 ephemeral 公钥，无私钥
      ephemeral_pubkey_hex: candidate.payload?.ephemeral_pubkey_hex ?? item.envelope.ephemeral_pubkey,
      ephemeral_private_key_hex: candidate.payload?.ephemeral_private_key_hex,
    });
  }
  // D1 包裹只在“本机没有对应 epoch 行 / 行内缺 mk”时补写；同名 epoch 已有钥则不覆盖
  if (!candidate.payload) {
    try {
      const items = await listDmWrappedKeysCached(client);
      const exists = items.some(
        (entry) =>
          entry.conversation_id === item.conversation_id &&
          entry.key_epoch === item.envelope.key_epoch,
      );
      if (!exists) {
        const vault = requireVaultWrapMaterial();
        const wrapped = await wrapSessionKeyPayload(
          {
            message_key_hex: messageKeyToHex(candidate.key),
            ephemeral_pubkey_hex: item.envelope.ephemeral_pubkey,
          },
          vault,
          item.conversation_id,
          item.envelope.key_epoch,
        );
        await client.putDmWrappedKey({
          conversation_id: item.conversation_id,
          key_epoch: item.envelope.key_epoch,
          peer_handle: item.peer_handle,
          wrapped_key_json: JSON.stringify(wrapped),
        });
        invalidateWrappedKeysCache();
      }
    } catch {
      // 写回失败不影响本机解密
    }
  }
}

export async function decryptDmMessageItem(
  item: DmMessageItem,
  passwordHash: string,
  client: WorkerAClient,
): Promise<DecryptedDmContent> {
  const cached = await getDmPlaintext(item.message_id);
  if (cached && (!item.envelope.media || (cached.media?.length ?? 0) > 0)) {
    return { kind: 'chat', text: cached.plaintext };
  }
  const header = { ...item.envelope };
  const candidates = await listMessageKeyCandidates(item, passwordHash, client);
  let messageKey: Uint8Array | null = null;
  let matched: MessageKeyCandidate | null = null;
  let decryptedRaw: string | null = null;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      decryptedRaw = await decryptDmCiphertext(item.envelope.ciphertext, candidate.key, header);
      messageKey = candidate.key;
      matched = candidate;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!messageKey || !matched || decryptedRaw == null) {
    throw lastError instanceof Error ? lastError : new Error('私信解密失败');
  }
  await cacheReceivedSessionKey(item, matched, client);
  const parsed = parseDmPlaintextPayload(decryptedRaw);

  // M-RTC-1：通话信令不入聊天气泡，避免列表预览刷 JSON
  if (parsed.callSignal) {
    return { kind: 'call_signal', signal: parsed.callSignal };
  }

  let media: readonly DmMediaView[] | undefined = cached?.media;
  if (item.envelope.media && parsed.mediaMeta?.[0]) {
    const view = await hydrateDmMediaView(
      client,
      item,
      messageKey,
      parsed.mediaMeta[0],
      item.envelope.media,
    );
    media = view ? [view] : undefined;
  }

  await saveDmPlaintext({
    message_id: item.message_id,
    conversation_id: item.conversation_id,
    peer_handle: item.peer_handle,
    direction: item.direction,
    plaintext: parsed.text,
    created_at: item.created_at,
    media,
  });
  return { kind: 'chat', text: parsed.text };
}

export interface SendDmInput {
  readonly client: WorkerAClient;
  /**
   * 历史字段：曾误用于投递。MSG-FIX-1 起投递改按 `recipientWorkerBUrl` 建对端 client；
   * 保留以兼容 pending/retry 形状，调用方可传任意 WorkerBClient。
   */
  readonly api: WorkerBClient;
  readonly senderHandle: string;
  readonly senderWorkerBUrl: string;
  readonly recipientHandle: string;
  readonly recipientWorkerBUrl: string;
  readonly recipientDmPubkey: string;
  readonly plaintext: string;
  readonly passwordHash: string;
  readonly imageFile?: File;
  /** M10-P3：1:1 语音条（与 imageFile 互斥）。 */
  readonly voiceFile?: File;
  readonly voiceDurationMs?: number;
}

export async function sendDmMessage(input: SendDmInput): Promise<DmPlaintextRecord> {
  const {
    client,
    senderHandle,
    senderWorkerBUrl,
    recipientHandle,
    recipientWorkerBUrl,
    recipientDmPubkey,
    plaintext,
    passwordHash,
  } = input;
  void input.api; // MSG-FIX-1：投递不再使用调用方 api
  const trimmed = plaintext.trim();
  if (input.imageFile && input.voiceFile) throw new Error('不能同时发送图片与语音');
  if (!trimmed && !input.imageFile && !input.voiceFile) throw new Error('消息不能为空');
  if (!recipientDmPubkey) throw new Error('对方尚未配置私信公钥，无法发送');
  if (input.imageFile && input.imageFile.size > MAX_DM_IMAGE_BYTES) {
    throw new Error('图片过大，请压缩后重试');
  }
  if (input.voiceFile) {
    if (!isAudioMime(input.voiceFile.type || 'audio/webm')) {
      throw new Error('仅支持语音音频文件');
    }
    if (input.voiceFile.size > MAX_DM_VOICE_BYTES) {
      throw new Error('语音过大，请缩短后重试');
    }
    if (
      input.voiceDurationMs != null &&
      input.voiceDurationMs > MAX_DM_VOICE_DURATION_MS
    ) {
      throw new Error('语音不能超过 60 秒');
    }
  }

  await ensureDmIdentity(client, passwordHash);
  const conversationId = await deriveConversationId(senderHandle, recipientHandle);
  const ticket = await client.issueDmSendTicket({
    recipient_handle: recipientHandle,
    recipient_worker_b_url: recipientWorkerBUrl,
  });

  const resolved = await resolveMessageKeyForSend(
    conversationId,
    recipientHandle,
    recipientDmPubkey,
    passwordHash,
    client,
  );
  const messageKey = resolved.messageKey;
  const ephemeralPub = resolved.ephemeralPub;
  const keyEpoch = resolved.epoch;

  const createdAt = new Date().toISOString();
  const messageId = newDmMessageId();
  let mediaBlock: MessagingMediaSigned | undefined;
  let mediaMeta: DmPlaintextPayloadV1['media_meta'];
  let mediaViews: readonly DmMediaView[] | undefined;

  const attachFile = input.voiceFile ?? input.imageFile;
  if (attachFile) {
    const mediaId = newClientMessagingMediaId();
    const isVoice = Boolean(input.voiceFile);
    const mime = attachFile.type || (isVoice ? 'audio/webm' : 'image/jpeg');
    const dims = isVoice ? {} : await readImageDimensions(attachFile);
    const durationMs = isVoice
      ? Math.max(0, Math.min(input.voiceDurationMs ?? 0, MAX_DM_VOICE_DURATION_MS))
      : undefined;
    const plainBytes = await attachFile.arrayBuffer();
    const encrypted = await encryptMessagingMediaBytes(plainBytes, messageKey, messageId, mediaId);
    const uploaded = await uploadDmMessagingMedia(client, {
      mediaId,
      plainMime: mime,
      ciphertext: encrypted.ciphertext,
    });
    mediaBlock = buildMessagingMediaSigned({
      mediaId: uploaded.media_id,
      senderStorageKey: uploaded.storage_key,
      senderWorkerBUrl,
      sizeBytes: uploaded.size_bytes,
      ciphertextSha256: encrypted.ciphertextSha256,
    });
    mediaMeta = [
      {
        media_id: uploaded.media_id,
        mime,
        width: dims.width,
        height: dims.height,
        duration_ms: durationMs || undefined,
      },
    ];
    mediaViews = [
      {
        media_id: uploaded.media_id,
        mime,
        width: dims.width,
        height: dims.height,
        duration_ms: durationMs || undefined,
        object_url: URL.createObjectURL(new Blob([new Uint8Array(plainBytes)], { type: mime })),
      },
    ];
  }

  const ciphertextPayload = serializeDmPlaintextPayload(trimmed, mediaMeta);
  const unsigned: Omit<DmEnvelope, 'sig' | 'ciphertext'> = {
    v: 1,
    conversation_id: conversationId,
    message_id: messageId,
    sender_handle: senderHandle,
    sender_worker_b_url: senderWorkerBUrl,
    recipient_handle: recipientHandle,
    created_at: createdAt,
    nonce: randomDmNonceHex(16),
    key_epoch: keyEpoch,
    ephemeral_pubkey: ephemeralPub,
    aad_version: 1,
    send_ticket: ticket,
    media: mediaBlock,
  };
  const ciphertext = await encryptDmPlaintext(ciphertextPayload, messageKey, unsigned);
  const signed = await client.signDmEnvelope({ ...unsigned, ciphertext });
  const record: DmPlaintextRecord = {
    message_id: signed.message_id,
    conversation_id: conversationId,
    peer_handle: recipientHandle,
    direction: 'outbox',
    plaintext: trimmed,
    created_at: createdAt,
    media: mediaViews,
    delivery_status: 'pending',
  };
  // MSG-FIX-2 local-first：先落本机出件箱 + 明文，再投递（避免对端已收而本端超时变幽灵）
  await client.saveDmOutbox(signed, { delivery_status: 'pending' });
  await saveDmPlaintext(record);
  // DM-PEER-PUBKEY-1：由本机 Worker A 服务端转发到收件人 Worker B /dm/inbox，
  // 浏览器不再直连对端 workers.dev（绕开网络阻断与 CORS）。
  try {
    await client.deliverDmEnvelope(recipientWorkerBUrl, signed);
  } catch (err) {
    // 对端已入库 → 同 nonce 重放视为幂等成功
    if (err instanceof ApiError && err.code === 'DM_NONCE_REPLAY') {
      // 仅翻状态，避免对已落库信封再做全量 INSERT OR REPLACE
      await client.patchDmOutboxDeliveryStatus(signed.message_id, 'sent');
      const sent: DmPlaintextRecord = { ...record, delivery_status: 'sent' };
      await saveDmPlaintext(sent);
      return sent;
    }
    await client.patchDmOutboxDeliveryStatus(signed.message_id, 'failed');
    const failed: DmPlaintextRecord = { ...record, delivery_status: 'failed' };
    await saveDmPlaintext(failed);
    throw new DmDeliveryFailedError(failed, err);
  }
  // 投递成功：同样只 PATCH 状态（信封已在 pending 时写入）
  await client.patchDmOutboxDeliveryStatus(signed.message_id, 'sent');
  const sent: DmPlaintextRecord = { ...record, delivery_status: 'sent' };
  await saveDmPlaintext(sent);
  return sent;
}

/**
 * MSG-FIX-2：投递失败但本机已落出件箱时抛出；UI 可用 `record` 上屏并用 `message_id` 同信封重试。
 */
export class DmDeliveryFailedError extends Error {
  readonly code = 'DM_DELIVERY_FAILED';
  readonly record: DmPlaintextRecord;
  readonly causeError: unknown;

  constructor(record: DmPlaintextRecord, causeError: unknown) {
    const msg =
      causeError instanceof ApiError ? causeError.displayMessage : '投递失败，请稍后重试';
    super(msg);
    this.name = 'DmDeliveryFailedError';
    this.record = record;
    this.causeError = causeError;
  }
}

/** MSG-FIX-2：把出件箱行 + 本地明文合并成带投递态的记录。 */
async function mergeOutboxPlaintextStatus(
  item: DmMessageItem,
  deliveryStatus: 'pending' | 'sent' | 'failed',
): Promise<DmPlaintextRecord> {
  const cached = await getDmPlaintext(item.message_id);
  if (cached) return { ...cached, delivery_status: deliveryStatus };
  return {
    message_id: item.message_id,
    conversation_id: item.conversation_id,
    peer_handle: item.peer_handle,
    direction: 'outbox',
    plaintext: '',
    created_at: item.created_at,
    delivery_status: deliveryStatus,
  };
}

/** MSG-FIX-2：重放本机已存的同一 signed envelope（同 message_id / nonce）。 */
export async function retryDmOutbox(input: {
  readonly client: WorkerAClient;
  readonly senderHandle: string;
  readonly senderWorkerBUrl: string;
  readonly messageId: string;
}): Promise<DmPlaintextRecord> {
  const item = await input.client.getDmOutboxMessage(input.messageId);
  const envelope = item.envelope;
  if (!envelope?.message_id) throw new Error('出件箱 envelope 无效');
  const peerUrl =
    item.peer_worker_b_url ||
    envelope.send_ticket?.recipient_worker_b_url ||
    '';
  if (!peerUrl) throw new Error('缺少对端节点地址，无法重试投递');
  await input.client.patchDmOutboxDeliveryStatus(envelope.message_id, 'pending');
  try {
    await input.client.deliverDmEnvelope(peerUrl, envelope);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'DM_NONCE_REPLAY') {
      await input.client.patchDmOutboxDeliveryStatus(envelope.message_id, 'sent');
      const sent = await mergeOutboxPlaintextStatus(item, 'sent');
      await saveDmPlaintext(sent);
      return sent;
    }
    await input.client.patchDmOutboxDeliveryStatus(envelope.message_id, 'failed');
    const failed = await mergeOutboxPlaintextStatus(item, 'failed');
    await saveDmPlaintext(failed);
    throw new DmDeliveryFailedError(failed, err);
  }
  await input.client.patchDmOutboxDeliveryStatus(envelope.message_id, 'sent');
  const sent = await mergeOutboxPlaintextStatus(item, 'sent');
  await saveDmPlaintext(sent);
  return sent;
}

export interface SendDmCallSignalInput {
  readonly client: WorkerAClient;
  /** 同 SendDmInput.api：不再用于投递。 */
  readonly api: WorkerBClient;
  readonly senderHandle: string;
  readonly senderWorkerBUrl: string;
  readonly recipientHandle: string;
  readonly recipientWorkerBUrl: string;
  readonly recipientDmPubkey: string;
  readonly passwordHash: string;
  readonly signal: CallSignalPayload;
}

/** M-RTC-1：发送通话信令（同 DM 投递链，不写入聊天气泡本地库）。 */
export async function sendDmCallSignal(input: SendDmCallSignalInput): Promise<void> {
  const {
    client,
    senderHandle,
    senderWorkerBUrl,
    recipientHandle,
    recipientWorkerBUrl,
    recipientDmPubkey,
    passwordHash,
    signal,
  } = input;
  void input.api; // MSG-FIX-1：投递不再使用调用方 api
  if (!isCallSignalPayload(signal)) throw new Error('无效的通话信令');
  if (!recipientDmPubkey) throw new Error('对方尚未配置私信公钥，无法呼叫');

  await ensureDmIdentity(client, passwordHash);
  const conversationId = await deriveConversationId(senderHandle, recipientHandle);
  const ticket = await client.issueDmSendTicket({
    recipient_handle: recipientHandle,
    recipient_worker_b_url: recipientWorkerBUrl,
  });

  const resolved = await resolveMessageKeyForSend(
    conversationId,
    recipientHandle,
    recipientDmPubkey,
    passwordHash,
    client,
  );
  const messageKey = resolved.messageKey;
  const ephemeralPub = resolved.ephemeralPub;
  const keyEpoch = resolved.epoch;

  const createdAt = new Date().toISOString();
  const messageId = newDmMessageId();
  const ciphertextPayload = serializeCallSignalPayload(signal);
  const unsigned: Omit<DmEnvelope, 'sig' | 'ciphertext'> = {
    v: 1,
    conversation_id: conversationId,
    message_id: messageId,
    sender_handle: senderHandle,
    sender_worker_b_url: senderWorkerBUrl,
    recipient_handle: recipientHandle,
    created_at: createdAt,
    nonce: randomDmNonceHex(16),
    key_epoch: keyEpoch,
    ephemeral_pubkey: ephemeralPub,
    aad_version: 1,
    send_ticket: ticket,
  };
  const ciphertext = await encryptDmPlaintext(ciphertextPayload, messageKey, unsigned);
  const signed = await client.signDmEnvelope({ ...unsigned, ciphertext });
  try {
    await client.deliverDmEnvelope(recipientWorkerBUrl, signed);
  } catch (err) {
    // 信令同样：对端已收视为成功；否则不落 outbox（通话态由 RTC 层处理）
    if (!(err instanceof ApiError && err.code === 'DM_NONCE_REPLAY')) {
      const msg = err instanceof ApiError ? err.displayMessage : '通话信令投递失败';
      throw new ApiError(0, { error_code: 'DM_DELIVERY_FAILED' }, msg);
    }
  }
  await client.saveDmOutbox(signed, { delivery_status: 'sent' });
}

export interface InboundCallSignal {
  readonly message_id: string;
  readonly peer_handle: string;
  readonly direction: 'inbox' | 'outbox';
  readonly signal: CallSignalPayload;
}

export interface SyncInboxResult {
  readonly items: readonly DmMessageItem[];
  readonly callSignals: readonly InboundCallSignal[];
}

/**
 * 多客户端 / 刷新后只收不发：本地 DM 身份可能还没 hydrate。
 * 不先恢复身份，`decryptDmMessageItem` 会抛「私信身份未初始化」，被下方
 * 单条 catch 静默吞掉 → 收件箱消息在 D1 里但 UI 永远不显示（两端不一致）。
 * 每个页面会话只尝试一次；失败留待下次轮询重试。
 */
let dmIdentityHydratedForSession = false;

async function ensureDmIdentityOnce(
  client: WorkerAClient,
  passwordHash: string,
): Promise<void> {
  if (dmIdentityHydratedForSession) return;
  try {
    await ensureDmIdentity(client, passwordHash);
    dmIdentityHydratedForSession = true;
  } catch {
    // 保持 false，下次轮询重试；解密单条失败仍由下方 catch 兜底
  }
}

/** 解密失败不再静默：只记录非敏感定位信息，便于多客户端排障。 */
function warnDmDecryptFailure(
  scope: 'inbox' | 'outbox',
  item: DmMessageItem,
  err: unknown,
): void {
  const reason = err instanceof Error ? err.name || 'Error' : typeof err;
  console.warn(
    `[dm] ${scope} decrypt failed message_id=${item.message_id} conversation_id=${item.conversation_id} epoch=${item.envelope?.key_epoch} reason=${reason}`,
  );
}

export async function syncInboxMessages(
  client: WorkerAClient,
  passwordHash: string,
): Promise<SyncInboxResult> {
  await ensureDmIdentityOnce(client, passwordHash);
  const data = await client.listDmInbox({ limit: 50 });
  const decrypted: DmMessageItem[] = [];
  const callSignals: InboundCallSignal[] = [];
  for (const item of data.items) {
    try {
      const content = await decryptDmMessageItem(item, passwordHash, client);
      if (item.direction === 'inbox' && !item.read_at) {
        await client.markDmMessageRead(item.message_id);
      }
      if (content.kind === 'call_signal') {
        callSignals.push({
          message_id: item.message_id,
          peer_handle: item.peer_handle,
          direction: item.direction,
          signal: content.signal,
        });
        continue;
      }
      decrypted.push(item);
    } catch (err) {
      warnDmDecryptFailure('inbox', item, err);
    }
  }
  return { items: decrypted, callSignals };
}

export interface SyncOutboxResult {
  readonly items: readonly DmMessageItem[];
}

/**
 * MULTI-CLIENT-KEY-1：从本节点 D1 outbox 回灌“我发出的历史消息”。
 *
 * 本地明文只存 sessionStorage（登出/换客户端即清空），不回灌就会出现
 * “重新登录后自己发过的消息全没了”。出件箱 envelope 是本人用同一把会话钥
 * 加密的，`decryptDmMessageItem` 能从 D1 包裹恢复会话钥后解开。
 */
export async function syncOutboxMessages(
  client: WorkerAClient,
  passwordHash: string,
): Promise<SyncOutboxResult> {
  await ensureDmIdentityOnce(client, passwordHash);
  const data = await client.listDmOutbox({ limit: 50 });
  const decrypted: DmMessageItem[] = [];
  for (const item of data.items) {
    try {
      const cached = await getDmPlaintext(item.message_id);
      if (!cached) {
        const content = await decryptDmMessageItem(item, passwordHash, client);
        if (content.kind === 'call_signal') continue;
      } else if (
        item.delivery_status === 'pending' ||
        item.delivery_status === 'sent' ||
        item.delivery_status === 'failed'
      ) {
        // 回灌投递态，避免换客户端后仍显示 pending
        await saveDmPlaintext({ ...cached, delivery_status: item.delivery_status });
      }
      decrypted.push(item);
    } catch (err) {
      warnDmDecryptFailure('outbox', item, err);
    }
  }
  return { items: decrypted };
}

export async function buildConversationSummaries(): Promise<DmConversationSummary[]> {
  const rows = await listDmPlaintexts();
  const map = new Map<string, DmConversationSummary>();
  for (const row of rows) {
    const prev = map.get(row.conversation_id);
    if (!prev || row.created_at > prev.last_message_at) {
      map.set(row.conversation_id, {
        conversation_id: row.conversation_id,
        peer_handle: row.peer_handle,
        last_message_at: row.created_at,
        last_preview: row.plaintext.slice(0, 80) || dmMediaListPreview(row.media),
        unread_count: 0,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

export async function listPlaintextsForConversation(
  conversationId: string,
): Promise<DmPlaintextRecord[]> {
  const rows = await listDmPlaintexts();
  return rows
    .filter((r) => r.conversation_id === conversationId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** M-RT-3：单条 send 失败时供 UI 重试；输入项必含方向 + 会话对方。 */
export interface RetryDmInput {
  readonly client: WorkerAClient;
  readonly api: WorkerBClient;
  readonly senderHandle: string;
  readonly senderWorkerBUrl: string;
  readonly recipientHandle: string;
  readonly recipientWorkerBUrl: string;
  readonly recipientDmPubkey: string;
  readonly passwordHash: string;
  readonly plaintext: string;
  readonly media?: DmMediaView | null;
  readonly voiceFile?: File | null;
  readonly voiceDurationMs?: number | null;
}

/**
 * M-RT-3：用同一会话密钥重新加密 + 复用 sendDmMessage 走原 send 链路。
 * 仅重发"我方"消息，因此 sender 永远是当前站主；不处理收到的他人消息。
 */
export async function retryDmMessage(input: RetryDmInput): Promise<DmPlaintextRecord> {
  const imageFile =
    input.media && input.media.mime.startsWith('image/') && input.media.object_url
      ? await fetchAsFile(input.media.object_url, input.media.mime, 'retry-image')
      : null;
  return sendDmMessage({
    client: input.client,
    api: input.api,
    senderHandle: input.senderHandle,
    senderWorkerBUrl: input.senderWorkerBUrl,
    recipientHandle: input.recipientHandle,
    recipientWorkerBUrl: input.recipientWorkerBUrl,
    recipientDmPubkey: input.recipientDmPubkey,
    plaintext: input.plaintext,
    passwordHash: input.passwordHash,
    imageFile: imageFile ?? undefined,
    voiceFile: input.voiceFile ?? undefined,
    voiceDurationMs: input.voiceDurationMs ?? undefined,
  });
}

async function fetchAsFile(url: string, mime: string, name: string): Promise<File | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (!blob || blob.size === 0) return null;
    return new File([blob], name, { type: mime || blob.type || 'application/octet-stream' });
  } catch {
    return null;
  }
}

/** M-RT-3：游标分页 — cursor=null/空取首页（最近），cursor=字符串取更早一页（仅 inbox）。 */
export async function loadOlderDmMessages(
  client: WorkerAClient,
  passwordHash: string,
  conversationId: string,
  cursor: string | null,
): Promise<{ items: readonly DmPlaintextRecord[]; nextCursor: string | null; hasMore: boolean }> {
  // 游标同时携带 inbox / outbox 两条分页（`inbox~outbox`），否则换客户端后
  // “更早的我发出的消息”永远翻不到（它们不在 inbox 列表里）。
  const [inboxCursor, outboxCursor] = (cursor ?? '').split('~');
  const inboxPage = await client.listDmInbox({ limit: 50, cursor: inboxCursor || undefined });
  const outboxPage = await client.listDmOutbox({ limit: 50, cursor: outboxCursor || undefined });
  const out: DmPlaintextRecord[] = [];
  for (const item of [...inboxPage.items, ...outboxPage.items]) {
    if (item.conversation_id !== conversationId) continue;
    try {
      // 复用既有解密 + 落库；返回值仅用于 UI 即时插入
      await decryptDmMessageItem(item, passwordHash, client);
      const cached = await getDmPlaintext(item.message_id);
      if (cached) out.push(cached);
    } catch {
      // 单条解密失败不阻断整页加载
    }
  }
  const nextInbox = inboxPage.has_more ? inboxPage.cursor : null;
  const nextOutbox = outboxPage.has_more ? outboxPage.cursor : null;
  const hasMore = Boolean(nextInbox || nextOutbox);
  return {
    items: out
      .filter((row, index, rows) => rows.findIndex((r) => r.message_id === row.message_id) === index)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    nextCursor: hasMore ? `${nextInbox ?? ''}~${nextOutbox ?? ''}` : null,
    hasMore,
  };
}

export async function deleteLocalConversation(conversationId: string): Promise<void> {
  await deleteDmPlaintextByConversation(conversationId);
  await deleteDmSessionKeysByConversation(conversationId);
}
