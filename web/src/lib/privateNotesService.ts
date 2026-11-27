/**
 * M11-6：私有记录加密启用、hydrate 与 re-wrap。
 * M-VAULT-6：新建/重包挂 vault；解包 vault 优先、旧 password 可回退。
 */
import type { PrivateNoteItem, WorkerAClient } from './workerA';
import {
  decryptPrivateNotePlaintext,
  encryptPrivateNotePlaintext,
  generatePrivateNotesMasterKey,
  isEncryptedPrivateNoteContent,
  PRIVATE_NOTES_KEY_EPOCH,
  type PrivateNotesWrappedKeyJson,
  unwrapPrivateNotesMasterKey,
  wrapPrivateNotesMasterKey,
} from './privateNotesCrypto';
import {
  clearPrivateNotesMasterKey,
  getPrivateNotesMasterKey,
  setPrivateNotesMasterKey,
} from './privateNotesSession';
import { businessUnwrapMaterials, requireVaultWrapMaterial } from './vaultWrapMaterial';

export function hasPrivateNotesMasterKeyInSession(): boolean {
  return getPrivateNotesMasterKey() !== null;
}

async function unwrapNotesMasterFlexible(
  wrapped: PrivateNotesWrappedKeyJson,
  passwordHash?: string | null,
): Promise<Uint8Array> {
  const materials = businessUnwrapMaterials(passwordHash);
  if (materials.length === 0) throw new Error('缺少密钥材料，无法解开私密笔记主密钥');
  let last: unknown;
  for (const material of materials) {
    try {
      return await unwrapPrivateNotesMasterKey(wrapped, material);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('无法解开私密笔记主密钥包裹');
}

export async function hydratePrivateNotesMasterKey(
  client: WorkerAClient,
  passwordHash: string,
): Promise<boolean> {
  const remote = await client.getPrivateNotesWrappedKey();
  if (!remote.enabled || !remote.wrapped_key_json) return false;
  const wrapped = JSON.parse(remote.wrapped_key_json) as PrivateNotesWrappedKeyJson;
  const masterKey = await unwrapNotesMasterFlexible(wrapped, passwordHash);
  setPrivateNotesMasterKey(masterKey);
  return true;
}

export async function enablePrivateNotesEncryption(
  client: WorkerAClient,
  passwordHash: string,
): Promise<void> {
  const remote = await client.getPrivateNotesWrappedKey();
  if (remote.enabled) {
    await hydratePrivateNotesMasterKey(client, passwordHash);
    return;
  }
  const vault = requireVaultWrapMaterial();
  const masterKey = generatePrivateNotesMasterKey();
  const wrapped = await wrapPrivateNotesMasterKey(masterKey, vault, PRIVATE_NOTES_KEY_EPOCH);
  await client.putPrivateNotesWrappedKey({
    wrapped_key_json: JSON.stringify(wrapped),
    key_epoch: PRIVATE_NOTES_KEY_EPOCH,
  });
  setPrivateNotesMasterKey(masterKey);
}

/** 存量迁移辅助：旧材料解 → vault 重包（改密主路径已不再调用） */
export async function rewrapPrivateNotesMasterKey(
  client: WorkerAClient,
  oldPasswordHash: string,
  newPasswordHash: string,
): Promise<void> {
  void newPasswordHash;
  const remote = await client.getPrivateNotesWrappedKey();
  if (!remote.enabled || !remote.wrapped_key_json) return;
  const vault = requireVaultWrapMaterial();
  let masterKey = getPrivateNotesMasterKey();
  if (!masterKey) {
    const wrapped = JSON.parse(remote.wrapped_key_json) as PrivateNotesWrappedKeyJson;
    masterKey = await unwrapNotesMasterFlexible(wrapped, oldPasswordHash);
  }
  const nextWrapped = await wrapPrivateNotesMasterKey(
    masterKey,
    vault,
    remote.key_epoch ?? PRIVATE_NOTES_KEY_EPOCH,
  );
  await client.putPrivateNotesWrappedKey({
    wrapped_key_json: JSON.stringify(nextWrapped),
    key_epoch: remote.key_epoch ?? PRIVATE_NOTES_KEY_EPOCH,
  });
  setPrivateNotesMasterKey(masterKey);
}

export async function decryptPrivateNoteItem(
  note: PrivateNoteItem,
  masterKey: Uint8Array | null,
): Promise<PrivateNoteItem> {
  if (!masterKey || !isEncryptedPrivateNoteContent(note.content)) return note;
  try {
    const content = await decryptPrivateNotePlaintext(note.content, masterKey);
    return { ...note, content };
  } catch {
    return { ...note, content: '无法解密此记录，请确认已用正确密码登录' };
  }
}

export async function encryptPrivateNoteContentForApi(
  content: string,
  masterKey: Uint8Array | null,
): Promise<string> {
  if (!masterKey) return content;
  return encryptPrivateNotePlaintext(content, masterKey);
}

export function clearPrivateNotesSessionSecrets(): void {
  clearPrivateNotesMasterKey();
}
