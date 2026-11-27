/**
 * GRP-NICKNAME-1：群昵称（按群、只存本机）。
 *
 * 为什么不写进节点 D1：
 * - 群昵称只用于「让成员在群里认出谁在说话」，随消息明文（已 E2EE）下发即可；
 * - 存进节点库等于把可关联昵称长期留成明文元数据，违背最小暴露；
 * - 换设备后重新设置一次即可，不需要跨端同步。
 *
 * 显示优先级：消息里携带的群昵称 > 发送者 handle（旧消息 / 未设置时回落）。
 */
const STORAGE_KEY = 'hailuo:group-nicknames';

/** 群昵称上限（按 Unicode 码点计，避免截断 emoji）。 */
export const GROUP_NICKNAME_MAX = 24;

function readStore(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [groupId, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[groupId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 隐私模式 / 配额满：昵称只是展示增强，失败不阻断聊天
  }
}

/** 归一化：折叠换行与多余空白，按码点截断到上限。 */
export function normalizeGroupNickname(raw: string): string {
  const collapsed = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(collapsed).slice(0, GROUP_NICKNAME_MAX).join('');
}

/** 读取本机为某个群设置的昵称；未设置返回空串。 */
export function readGroupNickname(groupId: string): string {
  if (!groupId) return '';
  return readStore()[groupId] ?? '';
}

/** 群消息里可用于推导成员昵称的最小字段集。 */
export interface GroupNicknameSource {
  readonly sender_handle: string;
  readonly sender_nickname?: string;
  readonly created_at: string;
}

/**
 * 从本机已解密的群消息推导「每个 handle 最近一次使用的群昵称」。
 *
 * 只读本机已有明文，零新增请求；从未发言 / 旧消息没带昵称的成员不在表里，
 * 调用方直接回落 `@handle`。同名 handle 以 `created_at` 更晚的一条为准。
 */
export function collectMemberNicknames(
  sources: readonly GroupNicknameSource[],
): Record<string, string> {
  const latest = new Map<string, { nickname: string; at: string }>();
  for (const m of sources) {
    const handle = m.sender_handle.trim().toLowerCase();
    const nickname = (m.sender_nickname ?? '').trim();
    if (!handle || !nickname) continue;
    const prev = latest.get(handle);
    if (!prev || m.created_at >= prev.at) latest.set(handle, { nickname, at: m.created_at });
  }
  const out: Record<string, string> = {};
  for (const [handle, row] of latest) out[handle] = row.nickname;
  return out;
}

/**
 * 保存本机群昵称；传空串表示清除（回落到 @handle）。
 * @returns 归一化后的实际保存值
 */
export function writeGroupNickname(groupId: string, raw: string): string {
  if (!groupId) return '';
  const next = normalizeGroupNickname(raw);
  const store = readStore();
  if (next) store[groupId] = next;
  else delete store[groupId];
  writeStore(store);
  return next;
}
