/** M-REFACTOR-1c：注册中心状态 / 日同步 / 运行日志 view model */
import { signal, effect } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import {
  createWorkerAClient,
  type OperationLogItem,
  type RegistryOfficialFeedStatus,
  type RegistryDailySyncDiagnostics,
} from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { showToast } from '../../../lib/toast';
import { t } from '../../../lib/i18n';
import { parseSearchHandle } from '../../../lib/handleSearch';
import { deleteInterestSignalsByPrefix } from '../../../lib/localDb';
import { AUTHOR_KEY_PREFIX, resetNegativeFeedbackDedup } from '../../../lib/forYou';

export const logItems = signal<readonly OperationLogItem[]>([]);
export const logStatus = signal<RegistryOfficialFeedStatus | null>(null);
export const dailySyncStatus = signal<RegistryDailySyncDiagnostics | null>(null);
export const dailySyncRunning = signal(false);
/** M16-DAILY-SYNC-COOLDOWN-1：手动 daily-sync 1 天节流；剩余小时数（null = 未节流）。 */
export const manualSyncCooldownHours = signal<number | null>(null);
const MANUAL_DAILY_SYNC_COOLDOWN_HOURS = 24;

function recomputeCooldownHours(): void {
  const last = dailySyncStatus.value?.last_manual_at ?? null;
  if (!last) {
    manualSyncCooldownHours.value = null;
    return;
  }
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) {
    manualSyncCooldownHours.value = null;
    return;
  }
  const remainingMs = lastMs + MANUAL_DAILY_SYNC_COOLDOWN_HOURS * 3600 * 1000 - Date.now();
  if (remainingMs <= 0) {
    manualSyncCooldownHours.value = null;
    return;
  }
  manualSyncCooldownHours.value = Math.max(1, Math.ceil(remainingMs / (3600 * 1000)));
}

/** M16-DAILY-SYNC-COOLDOWN-1：dailySyncStatus 变化时重算 cooldown 剩余小时（与 dailySyncStatus 派生）。 */
effect(() => {
  // 读 dailySyncStatus.value 以建立依赖
  void dailySyncStatus.value;
  recomputeCooldownHours();
});
// 立即跑一次（effect 默认是首次同步执行；这里冗余双保险）
recomputeCooldownHours();
export const federationProbeHandle = signal('');
export const federationProbeRunning = signal(false);
export const publicHealthProbe = signal<{ ok: boolean; http_status: number | null; latency_ms: number; error: string | null; checked_at: string } | null>(null);
export const publicHealthProbing = signal(false);
export const logsLoading = signal<boolean>(false);
export const officialPulling = signal<boolean>(false);
export const restoringHiddenPosts = signal<boolean>(false);
export const logsMsg = signal<string>('');
export const registryEndpointsLoading = signal<boolean>(false);

export async function refreshOperationLogs(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    logsMsg.value = t('settingsLogsEndpointMissing');
    return;
  }
  logsLoading.value = true;
  logsMsg.value = '';
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const [status, dailySync, logs] = await Promise.all([
      client.getRegistryOfficialFeedStatus(),
      client.getRegistryDailySyncStatus(),
      client.listOperationLogs({ limit: 80 }),
    ]);
    logStatus.value = status;
    dailySyncStatus.value = dailySync;
    logItems.value = logs.items;
    logsMsg.value = t('settingsLogsRefreshed', undefined, { count: logs.items.length });
  } catch (err) {
    logsMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsLogsRefreshFailed'));
  } finally {
    logsLoading.value = false;
  }
}

export async function handleCleanupLogs(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) return;
  logsLoading.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const result = await client.cleanupOperationLogs();
    logsMsg.value = t('settingsLogsCleaned', undefined, { deleted: result.deleted });
    await refreshOperationLogs();
  } catch (err) {
    logsMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsLogsCleanupFailed'));
  } finally {
    logsLoading.value = false;
  }
}

export async function handleProbePublicHealth(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    logsMsg.value = t('settingsPublicHealthEndpointMissing');
    return;
  }
  publicHealthProbing.value = true;
  logsMsg.value = '';
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const result = await client.probePublicHealth();
    publicHealthProbe.value = result;
    logsMsg.value = result.ok
      ? t('settingsPublicHealthOk', undefined, { status: result.http_status ?? 200, ms: result.latency_ms })
      : t('settingsPublicHealthFail', undefined, { error: result.error ?? t('settingsPublicHealthUnknown') });
  } catch (err) {
    logsMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsPublicHealthProbeFailed'));
  } finally {
    publicHealthProbing.value = false;
  }
}

export async function handleRunDailySyncNow(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    logsMsg.value = t('settingsDailySyncEndpointMissing');
    return;
  }
  dailySyncRunning.value = true;
  logsMsg.value = '';
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    // M16-DAILY-SYNC-COOLDOWN-1：手动 daily-sync 1 天节流
    // - 后端 429 → MANUAL_DAILY_SYNC_COOLDOWN，data 包含 last_manual_at / retry_after_hours
    // - 前端按钮已在 UI 层根据 last_manual_at 算 cooldown 直接 disabled
    // - 命中冷却时：用后端返回的 retry_after_hours 直接显示「还需等待 N 小时」
    try {
      const result = await client.runRegistryDailySync();
      dailySyncStatus.value = result.diagnostics;
      logStatus.value = result.diagnostics.official_feed;
      logsMsg.value = t('settingsDailySyncTriggered');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MANUAL_DAILY_SYNC_COOLDOWN') {
        // 中文注释：冷却字段在 ApiError.body.data（transport 透传完整 JSON），不是 err.data
        const payload = err.body?.data as { retry_after_hours?: number } | undefined;
        const hours = Math.max(1, Number(payload?.retry_after_hours ?? 24));
        // 中文注释：刷新 diagnostics（让 UI 重新读 last_manual_at 派生 cooldown 状态）
        try {
          dailySyncStatus.value = await client.getRegistryDailySyncStatus();
        } catch {
          /* 诊断读失败不影响冷却提示 */
        }
        logsMsg.value = t('settingsDailySyncCooldownActive', undefined, { hours: String(hours) });
        return;
      }
      throw err;
    }
    await refreshOperationLogs();
  } catch (err) {
    logsMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsDailySyncRunFailed'));
  } finally {
    dailySyncRunning.value = false;
  }
}

/** M9-3-CL4：站主试解析 → 写 last_lookup → 刷新日同步诊断 */
export async function handleFederationProbeLookup(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  // 中文注释：与右栏搜人一致，允许主中心裸名或 handle@registry_id
  const parsed = parseSearchHandle(federationProbeHandle.value);
  if (!baseUrl) {
    logsMsg.value = t('settingsDailySyncEndpointMissing');
    return;
  }
  if (!parsed.ok) {
    logsMsg.value =
      parsed.reason === 'did' ? t('searchDidDisabled') : t('searchHandleInvalid');
    return;
  }
  const handle = parsed.handle;
  federationProbeRunning.value = true;
  logsMsg.value = '';
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    try {
      await client.lookup(handle);
      logsMsg.value = t('settingsFederationProbeOk');
    } catch (err) {
      // 503 等也已写入 last_lookup；仍刷新诊断
      logsMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsFederationProbeFailed'));
    }
    dailySyncStatus.value = await client.getRegistryDailySyncStatus();
  } catch (err) {
    logsMsg.value =
      err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsFederationProbeFailed'));
  } finally {
    federationProbeRunning.value = false;
  }
}

export async function handlePullOfficialFeedNow(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    logsMsg.value = t('settingsLogsOfficialEndpointMissing');
    return;
  }
  officialPulling.value = true;
  logsMsg.value = '';
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const result = await client.pullRegistryOfficialFeedNow();
    logsMsg.value = t('settingsLogsOfficialPulled', undefined, {
      fetched: result.fetched_count,
      inserted: result.inserted_count,
      remaining: result.remaining_today,
    });
    await refreshOperationLogs();
  } catch (err) {
    logsMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsLogsOfficialPullFailed'));
  } finally {
    officialPulling.value = false;
  }
}

export async function handleRestoreHiddenPosts(): Promise<void> {
  if (restoringHiddenPosts.value) return;
  restoringHiddenPosts.value = true;
  try {
    // “隐藏帖子”由 session Set + author:@handle 负权重共同决定，恢复时两处都清理。
    resetNegativeFeedbackDedup();
    const deleted = await deleteInterestSignalsByPrefix(AUTHOR_KEY_PREFIX);
    logsMsg.value = t('settingsHiddenPostsRestored', undefined, { deleted });
    showToast(t('settingsHiddenPostsRestoreToast'), 'info');
  } catch (err) {
    logsMsg.value = getErrorMessage({ message: err instanceof Error ? err.message : '' }, t('settingsHiddenPostsRestoreFailed'));
    showToast(t('settingsHiddenPostsRestoreFailed'), 'error');
  } finally {
    restoringHiddenPosts.value = false;
  }
}
