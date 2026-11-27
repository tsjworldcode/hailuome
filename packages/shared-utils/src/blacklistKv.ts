/**
 * M6-4：STATE_KV 黑名单键前缀 SSOT（Worker A 写 / Worker B 读共用）。
 */

/** 站主本地拉黑（M6-3，D1 blacklist 表同步）。 */
export const BLACKLIST_KV_LOCAL_PREFIX = 'blacklist:local:';

/** 注册中心全局封禁（M6-4，Cron 拉取同步）。 */
export const BLACKLIST_KV_REGISTRY_PREFIX = 'blacklist:registry:';

/** 联邦全网生效集（生产默认 enforce；显式 FEDERATION_BLACKLIST_ENFORCE=false 才不写）。 */
export const BLACKLIST_KV_FEDERATED_PREFIX = 'blacklist:federated:';

/** 升级前遗留键（M6-3 旧前缀）；读侧兼容，写侧不再产生。 */
export const BLACKLIST_KV_LEGACY_PREFIX = 'blacklist:';

export function blacklistLocalKey(nodeUrl: string): string {
  return `${BLACKLIST_KV_LOCAL_PREFIX}${nodeUrl}`;
}

export function blacklistRegistryKey(workerBUrl: string): string {
  return `${BLACKLIST_KV_REGISTRY_PREFIX}${workerBUrl}`;
}

export function blacklistFederatedKey(workerBUrl: string): string {
  return `${BLACKLIST_KV_FEDERATED_PREFIX}${workerBUrl}`;
}

export function blacklistLegacyKey(nodeUrl: string): string {
  return `${BLACKLIST_KV_LEGACY_PREFIX}${nodeUrl}`;
}

/** Worker B 按优先级返回待探测的 KV 键（local → registry → federated → legacy）。 */
export function blacklistKvKeysForSub(sub: string): readonly string[] {
  return [
    blacklistLocalKey(sub),
    blacklistRegistryKey(sub),
    blacklistFederatedKey(sub),
    blacklistLegacyKey(sub),
  ];
}

/** 是否为 M6-3 升级前应清理的遗留键（blacklist:https://… 且非 local/registry/federated）。 */
export function isLegacyBlacklistKvKey(key: string): boolean {
  if (!key.startsWith(BLACKLIST_KV_LEGACY_PREFIX)) return false;
  if (key.startsWith(BLACKLIST_KV_LOCAL_PREFIX)) return false;
  if (key.startsWith(BLACKLIST_KV_REGISTRY_PREFIX)) return false;
  if (key.startsWith(BLACKLIST_KV_FEDERATED_PREFIX)) return false;
  const rest = key.slice(BLACKLIST_KV_LEGACY_PREFIX.length);
  return rest.startsWith('https://') || rest.startsWith('http://');
}
