/**
 * M-VAULT-7：登录后把旧 password_hash 直包一次性迁到 vault。
 * 幂等：已是 VAULT-HKDF-v1 则跳过；单类失败可跳过，不阻断登录。
 * 禁止日志打印 password / vault 明文 / 完整 wrapped JSON。
 */
import {
  DM_WRAP_KDF_VAULT,
  deriveIdentityPublicKeyHex,
  unwrapIdentityPrivateKey,
  unwrapMessageKey,
  wrapIdentityPrivateKey,
  wrapMessageKey,
  type DmWrappedIdentityJson,
  type DmWrappedKeyJson,
} from './dmCrypto';
import {
  GROUP_WRAP_KDF_VAULT,
  isGroupWrappedKeyV2,
  unwrapGroupKey,
  wrapGroupKey,
  type GroupWrappedKeyJson,
} from './groupCrypto';
import { listGroups } from './groupService';
import { setGroupSessionKey } from './groupSession';
import {
  NOTES_WRAP_KDF_VAULT,
  PRIVATE_NOTES_KEY_EPOCH,
  unwrapPrivateNotesMasterKey,
  wrapPrivateNotesMasterKey,
  type PrivateNotesWrappedKeyJson,
} from './privateNotesCrypto';
import { setPrivateNotesMasterKey } from './privateNotesSession';
import { businessUnwrapMaterials, requireVaultWrapMaterial } from './vaultWrapMaterial';
import type { createWorkerAClient } from './workerA';
import {
  messageKeyToHex,
  saveDmIdentity,
  saveDmSessionKey,
} from './dmLocalDb';

type WorkerAClient = ReturnType<typeof createWorkerAClient>;

export type VaultMigrateSlot =
  | 'migrated'
  | 'already_vault'
  | 'missing'
  | 'failed'
  | 'skipped_no_vault';

export interface VaultMigrateResult {
  readonly dmIdentity: VaultMigrateSlot;
  readonly dmKeysMigrated: number;
  readonly dmKeysFailed: number;
  readonly dmKeysAlreadyVault: number;
  readonly groupKeysMigrated: number;
  readonly groupKeysFailed: number;
  readonly groupKeysAlreadyVault: number;
  readonly notes: VaultMigrateSlot;
}

function isVaultKdf(kdf: unknown): boolean {
  return kdf === DM_WRAP_KDF_VAULT || kdf === GROUP_WRAP_KDF_VAULT || kdf === NOTES_WRAP_KDF_VAULT;
}

async function unwrapWithMaterials<T>(
  materials: readonly string[],
  tryOne: (material: string) => Promise<T>,
  emptyMsg: string,
): Promise<T> {
  if (materials.length === 0) throw new Error(emptyMsg);
  let last: unknown;
  for (const material of materials) {
    try {
      return await tryOne(material);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error(emptyMsg);
}

async function migrateDmIdentity(
  client: WorkerAClient,
  materials: readonly string[],
  vault: string,
): Promise<VaultMigrateSlot> {
  const remote = await client.getDmWrappedIdentity();
  if (!remote) return 'missing';
  let wrapped: DmWrappedIdentityJson;
  try {
    wrapped = JSON.parse(remote.wrapped_identity_json) as DmWrappedIdentityJson;
  } catch {
    return 'failed';
  }
  if (isVaultKdf(wrapped.kdf)) return 'already_vault';
  try {
    const privateKeyHex = await unwrapWithMaterials(
      materials,
      (m) => unwrapIdentityPrivateKey(wrapped, m),
      '无法解开旧私信身份',
    );
    const pubHex = await deriveIdentityPublicKeyHex(privateKeyHex);
    const next = await wrapIdentityPrivateKey(privateKeyHex, vault);
    await client.putDmWrappedIdentity({
      public_key_hex: pubHex,
      wrapped_identity_json: JSON.stringify(next),
    });
    await saveDmIdentity({ public_key_hex: pubHex, private_key_hex: privateKeyHex });
    return 'migrated';
  } catch {
    return 'failed';
  }
}

async function migrateDmSessionKeys(
  client: WorkerAClient,
  materials: readonly string[],
  vault: string,
): Promise<{ migrated: number; failed: number; already: number }> {
  let migrated = 0;
  let failed = 0;
  let already = 0;
  const { items } = await client.listDmWrappedKeys();
  for (const item of items) {
    let wrapped: DmWrappedKeyJson;
    try {
      wrapped = JSON.parse(item.wrapped_key_json) as DmWrappedKeyJson;
    } catch {
      failed += 1;
      continue;
    }
    if (isVaultKdf(wrapped.kdf)) {
      already += 1;
      continue;
    }
    try {
      const messageKey = await unwrapWithMaterials(
        materials,
        (m) => unwrapMessageKey(wrapped, m, item.conversation_id),
        '无法解开旧私信会话钥',
      );
      const next = await wrapMessageKey(messageKey, vault, item.conversation_id, item.key_epoch);
      await client.putDmWrappedKey({
        conversation_id: item.conversation_id,
        key_epoch: item.key_epoch,
        peer_handle: item.peer_handle,
        wrapped_key_json: JSON.stringify(next),
      });
      await saveDmSessionKey({
        key_id: `${item.conversation_id}:${item.key_epoch}`,
        conversation_id: item.conversation_id,
        key_epoch: item.key_epoch,
        peer_handle: item.peer_handle,
        message_key_hex: messageKeyToHex(messageKey),
      });
      migrated += 1;
    } catch {
      failed += 1;
    }
  }
  return { migrated, failed, already };
}

async function migrateGroupKeys(
  client: WorkerAClient,
  materials: readonly string[],
  vault: string,
): Promise<{ migrated: number; failed: number; already: number }> {
  let migrated = 0;
  let failed = 0;
  let already = 0;
  let groups: Awaited<ReturnType<typeof listGroups>>;
  try {
    groups = await listGroups(client);
  } catch {
    return { migrated: 0, failed: 0, already: 0 };
  }
  for (const g of groups) {
    if (g.key_state !== 'active') continue;
    let items: Awaited<ReturnType<WorkerAClient['listGroupWrappedKeys']>>['items'];
    try {
      ({ items } = await client.listGroupWrappedKeys(g.group_id, g.epoch));
    } catch {
      failed += 1;
      continue;
    }
    for (const item of items) {
      let wrapped: GroupWrappedKeyJson;
      try {
        wrapped = JSON.parse(item.wrapped_key_json) as GroupWrappedKeyJson;
      } catch {
        failed += 1;
        continue;
      }
      // REKEY-2 v2 是成员 DH 密封，不是 password→vault 迁移对象。
      if (isGroupWrappedKeyV2(wrapped)) {
        already += 1;
        continue;
      }
      if (isVaultKdf(wrapped.kdf)) {
        already += 1;
        continue;
      }
      try {
        const groupKey = await unwrapWithMaterials(
          materials,
          (m) => unwrapGroupKey(wrapped, m, g.group_id),
          '无法解开旧群密钥',
        );
        const next = await wrapGroupKey(groupKey, vault, g.group_id, item.epoch);
        await client.putGroupWrappedKey(g.group_id, {
          epoch: item.epoch,
          wrapped_key_json: JSON.stringify(next),
        });
        setGroupSessionKey(g.group_id, item.epoch, groupKey);
        migrated += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { migrated, failed, already };
}

async function migrateNotes(
  client: WorkerAClient,
  materials: readonly string[],
  vault: string,
): Promise<VaultMigrateSlot> {
  const remote = await client.getPrivateNotesWrappedKey();
  if (!remote.enabled || !remote.wrapped_key_json) return 'missing';
  let wrapped: PrivateNotesWrappedKeyJson;
  try {
    wrapped = JSON.parse(remote.wrapped_key_json) as PrivateNotesWrappedKeyJson;
  } catch {
    return 'failed';
  }
  if (isVaultKdf(wrapped.kdf)) return 'already_vault';
  try {
    const masterKey = await unwrapWithMaterials(
      materials,
      (m) => unwrapPrivateNotesMasterKey(wrapped, m),
      '无法解开旧笔记主密钥',
    );
    const next = await wrapPrivateNotesMasterKey(
      masterKey,
      vault,
      remote.key_epoch ?? PRIVATE_NOTES_KEY_EPOCH,
    );
    await client.putPrivateNotesWrappedKey({
      wrapped_key_json: JSON.stringify(next),
      key_epoch: remote.key_epoch ?? PRIVATE_NOTES_KEY_EPOCH,
    });
    setPrivateNotesMasterKey(masterKey);
    return 'migrated';
  } catch {
    return 'failed';
  }
}

/**
 * 登录 hydrate 之后调用：把仍挂 password 的业务包裹迁到 vault。
 * 无 vault 会话 → skipped_no_vault（各槽）；不抛错。
 */
export async function migrateLegacyWrapsToVault(
  client: WorkerAClient,
  passwordHash: string,
): Promise<VaultMigrateResult> {
  const empty: VaultMigrateResult = {
    dmIdentity: 'skipped_no_vault',
    dmKeysMigrated: 0,
    dmKeysFailed: 0,
    dmKeysAlreadyVault: 0,
    groupKeysMigrated: 0,
    groupKeysFailed: 0,
    groupKeysAlreadyVault: 0,
    notes: 'skipped_no_vault',
  };

  let vault: string;
  try {
    vault = requireVaultWrapMaterial();
  } catch {
    return empty;
  }

  const materials = businessUnwrapMaterials(passwordHash);
  const dmIdentity = await migrateDmIdentity(client, materials, vault);
  const dmKeys = await migrateDmSessionKeys(client, materials, vault);
  const groupKeys = await migrateGroupKeys(client, materials, vault);
  const notes = await migrateNotes(client, materials, vault);

  return {
    dmIdentity,
    dmKeysMigrated: dmKeys.migrated,
    dmKeysFailed: dmKeys.failed,
    dmKeysAlreadyVault: dmKeys.already,
    groupKeysMigrated: groupKeys.migrated,
    groupKeysFailed: groupKeys.failed,
    groupKeysAlreadyVault: groupKeys.already,
    notes,
  };
}
