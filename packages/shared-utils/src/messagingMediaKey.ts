/**
 * MM-1：私信/群聊 E2EE 图片 storage_key 解析（msg_ 前缀，独立于公开帖 img_）。
 * SSOT：docs/m10-p2-dm-media-plan.md §2.2
 */

export type MessagingMediaBackend = 'kv' | 'b2' | 'filebase' | 'r2';

const MSG_OBJECT_RE = /^msg_[a-f0-9]{16,64}$/;

const PREFIX_RES: ReadonlyArray<{ prefix: string; backend: MessagingMediaBackend }> = [
  { prefix: 'filebase:', backend: 'filebase' },
  { prefix: 'b2:', backend: 'b2' },
  { prefix: 'r2:', backend: 'r2' },
  { prefix: 'kv:', backend: 'kv' },
];

/** 校验裸对象名 msg_{hex}。 */
export function isMessagingMediaObjectName(name: string): boolean {
  return MSG_OBJECT_RE.test(name.trim());
}

/** 解析完整 storage_key（如 b2:msg_abcd…）→ 后端 + 裸对象名；非法返回 null。 */
export function parseMessagingMediaStorageKey(
  storageKey: string,
): { backend: MessagingMediaBackend; objectName: string } | null {
  const trimmed = storageKey.trim();
  for (const { prefix, backend } of PREFIX_RES) {
    if (!trimmed.startsWith(prefix)) continue;
    const objectName = trimmed.slice(prefix.length);
    if (!isMessagingMediaObjectName(objectName)) return null;
    return { backend, objectName };
  }
  return null;
}

/** 从 storage_key 推断后端（不含 img_ 公开帖 key）。 */
export function parseMessagingMediaBackend(storageKey: string): MessagingMediaBackend | null {
  return parseMessagingMediaStorageKey(storageKey)?.backend ?? null;
}

/** 构造 storage_key：`{backend}:msg_{hex}`。 */
export function buildMessagingMediaStorageKey(
  backend: MessagingMediaBackend,
  objectName: string,
): string | null {
  const name = objectName.trim();
  if (!isMessagingMediaObjectName(name)) return null;
  return `${backend}:${name}`;
}

/** 与公开帖 img_ key 互斥：msg_ 专用。 */
export function isMessagingMediaStorageKey(storageKey: string): boolean {
  return parseMessagingMediaStorageKey(storageKey) !== null;
}
