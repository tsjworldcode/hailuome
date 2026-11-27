/**
 * M16-4d：群聊明文 sessionStorage 缓存（关闭标签页即清除，对齐 dmLocalDb）。
 */
const GROUP_PLAINTEXT_SS = 'hailuo:group-plaintexts';

export interface GroupPlaintextRecord {
  readonly message_id: string;
  readonly group_id: string;
  readonly sender_handle: string;
  /** GRP-NICKNAME-1：发送者在本群自设的昵称（旧消息 / 未设置时缺省，回落 sender_handle）。 */
  readonly sender_nickname?: string;
  readonly plaintext: string;
  readonly created_at: string;
  /** M16-7b：system 踢人预告等居中灰条展示；缺省为 chat 气泡。 */
  readonly msg_kind?: 'chat' | 'system';
  readonly media?: readonly GroupMediaView[];
}

export interface GroupMediaView {
  readonly media_id: string;
  readonly mime: string;
  readonly width?: number;
  readonly height?: number;
  readonly object_url: string;
}

function readStore(): GroupPlaintextRecord[] {
  if (typeof window === 'undefined') return [];
  const raw = window.sessionStorage.getItem(GROUP_PLAINTEXT_SS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as GroupPlaintextRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(rows: GroupPlaintextRecord[]): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(GROUP_PLAINTEXT_SS, JSON.stringify(rows));
}

export async function saveGroupPlaintext(record: GroupPlaintextRecord): Promise<void> {
  const rows = readStore().filter((r) => r.message_id !== record.message_id);
  rows.push(record);
  writeStore(rows);
}

export async function getGroupPlaintext(messageId: string): Promise<GroupPlaintextRecord | null> {
  return readStore().find((r) => r.message_id === messageId) ?? null;
}

export async function listGroupPlaintexts(groupId?: string): Promise<GroupPlaintextRecord[]> {
  const rows = readStore();
  return groupId ? rows.filter((r) => r.group_id === groupId) : rows;
}

export function clearGroupPlaintexts(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(GROUP_PLAINTEXT_SS);
}
