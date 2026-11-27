/** M-REFACTOR-1c：媒体存储 view model */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient, type MediaStoragePatchInput, type MediaStorageSetting, type MediaStorageUsageEntry } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { showToast } from '../../../lib/toast';
import { t } from '../../../lib/i18n';
import { setStatus } from './useSettingsSession';

export type MediaStorageConfirmKind = 'clear-b2' | 'clear-filebase' | 'gc-orphan-kv';

// 阈值默认值（M8-14-9，与 Worker A 默认值一致）
export const DEFAULT_KV_HIGH_WATERMARK = 0.90;
export const DEFAULT_KV_PREFERRED_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_R2_HIGH_WATERMARK = 0.90;
export const DEFAULT_R2_TARGET_WATERMARK = 0.70;

/** M8-14-9：从 API 响应更新阈值 signal */
function applyThresholdResponse(s: MediaStorageSetting): void {
  if (s.thresholds) {
    mediaStorageKvHighWatermark.value = s.thresholds.kv_high_watermark;
    mediaStorageKvPreferredMaxMb.value = s.thresholds.kv_preferred_max_bytes / (1024 * 1024);
    mediaStorageR2HighWatermark.value = s.thresholds.r2_high_watermark;
    mediaStorageR2TargetWatermark.value = s.thresholds.r2_target_watermark;
  }
}

export const mediaStorageBackend = signal<'kv' | 'b2' | 'filebase'>('kv');
export const mediaStorageMode = signal<'router' | 'manual'>('manual');
export const mediaStorageActiveWrite = signal<string>('kv');
export const mediaStorageUsage = signal<MediaStorageSetting['usage']>(undefined);
export const mediaStorageR2Bound = signal<boolean>(false);
export const mediaStorageB2KeyId = signal<string>('');
export const mediaStorageB2AppKey = signal<string>('');
export const mediaStorageB2AppKeySet = signal<boolean>(false);
export const mediaStorageB2Bucket = signal<string>('');
export const mediaStorageB2Endpoint = signal<string>('');
export const mediaStorageB2Region = signal<string>('');
export const mediaStorageFilebaseKeyId = signal<string>('');
export const mediaStorageFilebaseAppKey = signal<string>('');
export const mediaStorageFilebaseAppKeySet = signal<boolean>(false);
export const mediaStorageFilebaseBucket = signal<string>('');
export const mediaStorageFilebaseEndpoint = signal<string>('https://s3.filebase.io');
export const mediaStorageFilebaseRegion = signal<string>('auto');
export const mediaStorageProbeStatus = signal<string>('unknown');
export const mediaStorageLoading = signal<boolean>(false);
export const mediaStorageSaving = signal<boolean>(false);
export const mediaStorageCalibrating = signal<boolean>(false);
export const mediaStorageConfirmKind = signal<MediaStorageConfirmKind | null>(null);

// M8-14-9：阈值表单 signal（初始值与默认值对齐）
export const mediaStorageKvHighWatermark = signal<number>(DEFAULT_KV_HIGH_WATERMARK);
export const mediaStorageKvPreferredMaxMb = signal<number>(DEFAULT_KV_PREFERRED_MAX_BYTES / (1024 * 1024));
export const mediaStorageR2HighWatermark = signal<number>(DEFAULT_R2_HIGH_WATERMARK);
export const mediaStorageR2TargetWatermark = signal<number>(DEFAULT_R2_TARGET_WATERMARK);

export function formatStorageBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function usageBarPercent(entry: MediaStorageUsageEntry): number {
  if (entry.bytes_threshold != null && entry.bytes_threshold > 0) {
    return Math.min(100, Math.round((entry.bytes_used / entry.bytes_threshold) * 100));
  }
  return 0;
}

export async function refreshMediaStorageSetting(baseUrl: string): Promise<void> {
  mediaStorageLoading.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const setting = await client.getMediaStorageSetting();
    mediaStorageMode.value = setting.mode ?? 'manual';
    mediaStorageActiveWrite.value = setting.active_write_backend ?? setting.backend;
    mediaStorageUsage.value = setting.usage;
    // M8-14-9：R2 绑定状态
    mediaStorageR2Bound.value = setting.r2_bound ?? false;
    // M8-14-9：阈值
    if (setting.thresholds) {
      mediaStorageKvHighWatermark.value = setting.thresholds.kv_high_watermark ?? DEFAULT_KV_HIGH_WATERMARK;
      mediaStorageKvPreferredMaxMb.value = (setting.thresholds.kv_preferred_max_bytes ?? DEFAULT_KV_PREFERRED_MAX_BYTES) / (1024 * 1024);
      mediaStorageR2HighWatermark.value = setting.thresholds.r2_high_watermark ?? DEFAULT_R2_HIGH_WATERMARK;
      mediaStorageR2TargetWatermark.value = setting.thresholds.r2_target_watermark ?? DEFAULT_R2_TARGET_WATERMARK;
    } else {
      // 未返回阈值时使用默认值（向后兼容旧节点）
      mediaStorageKvHighWatermark.value = DEFAULT_KV_HIGH_WATERMARK;
      mediaStorageKvPreferredMaxMb.value = DEFAULT_KV_PREFERRED_MAX_BYTES / (1024 * 1024);
      mediaStorageR2HighWatermark.value = DEFAULT_R2_HIGH_WATERMARK;
      mediaStorageR2TargetWatermark.value = DEFAULT_R2_TARGET_WATERMARK;
    }
    mediaStorageBackend.value =
      setting.backend === 'filebase' ? 'filebase' : setting.backend === 'b2' ? 'b2' : 'kv';
    mediaStorageProbeStatus.value = setting.probe_status;
    mediaStorageB2AppKey.value = '';
    mediaStorageFilebaseAppKey.value = '';
    if (setting.b2) {
      mediaStorageB2KeyId.value = setting.b2.key_id;
      mediaStorageB2AppKeySet.value = setting.b2.app_key_set;
      mediaStorageB2Bucket.value = setting.b2.bucket_name;
      mediaStorageB2Endpoint.value = setting.b2.endpoint;
      mediaStorageB2Region.value = setting.b2.region ?? '';
    } else {
      mediaStorageB2KeyId.value = '';
      mediaStorageB2AppKeySet.value = false;
      mediaStorageB2Bucket.value = '';
      mediaStorageB2Endpoint.value = '';
      mediaStorageB2Region.value = '';
    }
    if (setting.filebase) {
      mediaStorageFilebaseKeyId.value = setting.filebase.key_id;
      mediaStorageFilebaseAppKeySet.value = setting.filebase.app_key_set;
      mediaStorageFilebaseBucket.value = setting.filebase.bucket_name;
      mediaStorageFilebaseEndpoint.value = setting.filebase.endpoint;
      mediaStorageFilebaseRegion.value = setting.filebase.region ?? 'auto';
    } else {
      mediaStorageFilebaseKeyId.value = '';
      mediaStorageFilebaseAppKeySet.value = false;
      mediaStorageFilebaseBucket.value = '';
      mediaStorageFilebaseEndpoint.value = 'https://s3.filebase.io';
      mediaStorageFilebaseRegion.value = 'auto';
    }
  } catch (err) {
    setStatus('error', err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsMediaStorageLoadFailed')));
  } finally {
    mediaStorageLoading.value = false;
  }
}

export async function handleMediaStorageSave(e: Event): Promise<void> {
  e.preventDefault();
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || mediaStorageSaving.value) return;
  mediaStorageSaving.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });

    // M8-14-9：阈值 payload（与凭证等 patch 一起发送，阈值立即生效）
    const thresholdPatch: MediaStoragePatchInput = {
      thresholds: {
        kv_high_watermark: mediaStorageKvHighWatermark.value,
        kv_preferred_max_bytes: Math.round(mediaStorageKvPreferredMaxMb.value * 1024 * 1024),
        r2_high_watermark: mediaStorageR2HighWatermark.value,
        r2_target_watermark: mediaStorageR2TargetWatermark.value,
      },
    };

    const patch: MediaStoragePatchInput = { mode: mediaStorageMode.value, ...thresholdPatch };

    if (mediaStorageMode.value === 'manual') {
      if (mediaStorageBackend.value === 'kv') {
        const updated = await client.setMediaStorageSetting({ ...patch, backend: 'kv' });
        mediaStorageBackend.value = 'kv';
        mediaStorageProbeStatus.value = updated.probe_status;
        mediaStorageUsage.value = updated.usage;
        mediaStorageMode.value = updated.mode ?? mediaStorageMode.value;
        applyThresholdResponse(updated);
        showToast(t('settingsMediaStorageSaved'), 'info');
        return;
      }
      if (mediaStorageBackend.value === 'filebase') {
        const key_id = mediaStorageFilebaseKeyId.value.trim();
        const bucket_name = mediaStorageFilebaseBucket.value.trim();
        const endpoint = mediaStorageFilebaseEndpoint.value.trim();
        const region = mediaStorageFilebaseRegion.value.trim();
        const app_key = mediaStorageFilebaseAppKey.value.trim();
        const filebase: NonNullable<MediaStoragePatchInput['filebase']> = {
          key_id,
          bucket_name,
          endpoint,
          ...(region ? { region } : {}),
          ...(app_key ? { app_key } : {}),
        };
        const updated = await client.setMediaStorageSetting({ ...patch, backend: 'filebase', filebase });
        mediaStorageBackend.value = 'filebase';
        mediaStorageProbeStatus.value = updated.probe_status;
        mediaStorageUsage.value = updated.usage;
        mediaStorageMode.value = updated.mode ?? mediaStorageMode.value;
        applyThresholdResponse(updated);
        mediaStorageFilebaseAppKey.value = '';
        if (updated.filebase) {
          mediaStorageFilebaseAppKeySet.value = updated.filebase.app_key_set;
        }
        showToast(t('settingsMediaStorageSaved'), 'info');
        return;
      }
      const key_id = mediaStorageB2KeyId.value.trim();
      const bucket_name = mediaStorageB2Bucket.value.trim();
      const endpoint = mediaStorageB2Endpoint.value.trim();
      const region = mediaStorageB2Region.value.trim();
      const app_key = mediaStorageB2AppKey.value.trim();
      const b2: NonNullable<MediaStoragePatchInput['b2']> = {
        key_id,
        bucket_name,
        endpoint,
        ...(region ? { region } : {}),
        ...(app_key ? { app_key } : {}),
      };
      const updated = await client.setMediaStorageSetting({ ...patch, backend: 'b2', b2 });
      mediaStorageBackend.value = 'b2';
      mediaStorageProbeStatus.value = updated.probe_status;
      mediaStorageUsage.value = updated.usage;
      mediaStorageMode.value = updated.mode ?? mediaStorageMode.value;
      applyThresholdResponse(updated);
      mediaStorageB2AppKey.value = '';
      if (updated.b2) {
        mediaStorageB2AppKeySet.value = updated.b2.app_key_set;
      }
      showToast(t('settingsMediaStorageSaved'), 'info');
      return;
    }

    // router 模式：可同时保存 Filebase / B2 凭证，或仅切换 mode
    const fbKey = mediaStorageFilebaseKeyId.value.trim();
    const fbBucket = mediaStorageFilebaseBucket.value.trim();
    const fbEndpoint = mediaStorageFilebaseEndpoint.value.trim();
    const fbAppKey = mediaStorageFilebaseAppKey.value.trim();
    const b2Key = mediaStorageB2KeyId.value.trim();
    const b2Bucket = mediaStorageB2Bucket.value.trim();
    const b2Endpoint = mediaStorageB2Endpoint.value.trim();
    const b2AppKey = mediaStorageB2AppKey.value.trim();
    const updated = await client.setMediaStorageSetting({
      mode: 'router',
      ...thresholdPatch,
      ...(fbKey && fbBucket && fbEndpoint
        ? {
            filebase: {
              key_id: fbKey,
              bucket_name: fbBucket,
              endpoint: fbEndpoint,
              ...(mediaStorageFilebaseRegion.value.trim() ? { region: mediaStorageFilebaseRegion.value.trim() } : {}),
              ...(fbAppKey ? { app_key: fbAppKey } : {}),
            },
          }
        : {}),
      ...(b2Key && b2Bucket && b2Endpoint
        ? {
            b2: {
              key_id: b2Key,
              bucket_name: b2Bucket,
              endpoint: b2Endpoint,
              ...(mediaStorageB2Region.value.trim() ? { region: mediaStorageB2Region.value.trim() } : {}),
              ...(b2AppKey ? { app_key: b2AppKey } : {}),
            },
          }
        : {}),
    });
    mediaStorageUsage.value = updated.usage;
    mediaStorageMode.value = updated.mode ?? 'router';
    mediaStorageActiveWrite.value = updated.active_write_backend ?? updated.backend;
    mediaStorageProbeStatus.value = updated.probe_status;
    applyThresholdResponse(updated);
    mediaStorageFilebaseAppKey.value = '';
    mediaStorageB2AppKey.value = '';
    if (updated.filebase) mediaStorageFilebaseAppKeySet.value = updated.filebase.app_key_set;
    if (updated.b2) mediaStorageB2AppKeySet.value = updated.b2.app_key_set;
    showToast(t('settingsMediaStorageSaved'), 'info');
  } catch (err) {
    showToast(err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsMediaStorageSaveFailed')), 'error');
  } finally {
    mediaStorageSaving.value = false;
  }
}

export async function handleClearB2Config(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || mediaStorageSaving.value) return;
  mediaStorageConfirmKind.value = 'clear-b2';
}

export async function confirmClearB2Config(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || mediaStorageSaving.value) return;
  mediaStorageSaving.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const updated = await client.setMediaStorageSetting({ backend: 'kv', clear_b2: true });
    mediaStorageBackend.value =
      updated.backend === 'filebase' ? 'filebase' : updated.backend === 'b2' ? 'b2' : 'kv';
    mediaStorageProbeStatus.value = updated.probe_status;
    mediaStorageB2KeyId.value = '';
    mediaStorageB2AppKey.value = '';
    mediaStorageB2AppKeySet.value = false;
    mediaStorageB2Bucket.value = '';
    mediaStorageB2Endpoint.value = '';
    mediaStorageB2Region.value = '';
    mediaStorageConfirmKind.value = null;
    showToast(t('settingsMediaStorageSaved'), 'info');
  } catch (err) {
    showToast(err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsMediaStorageClearB2Failed')), 'error');
  } finally {
    mediaStorageSaving.value = false;
  }
}

export async function handleClearFilebaseConfig(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || mediaStorageSaving.value) return;
  mediaStorageConfirmKind.value = 'clear-filebase';
}

export async function confirmClearFilebaseConfig(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || mediaStorageSaving.value) return;
  mediaStorageSaving.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const updated = await client.setMediaStorageSetting({ backend: 'kv', clear_filebase: true });
    mediaStorageBackend.value =
      updated.backend === 'filebase' ? 'filebase' : updated.backend === 'b2' ? 'b2' : 'kv';
    mediaStorageProbeStatus.value = updated.probe_status;
    mediaStorageFilebaseKeyId.value = '';
    mediaStorageFilebaseAppKey.value = '';
    mediaStorageFilebaseAppKeySet.value = false;
    mediaStorageFilebaseBucket.value = '';
    mediaStorageFilebaseEndpoint.value = 'https://s3.filebase.io';
    mediaStorageFilebaseRegion.value = 'auto';
    mediaStorageConfirmKind.value = null;
    showToast(t('settingsMediaStorageSaved'), 'info');
  } catch (err) {
    showToast(err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsMediaStorageClearFilebaseFailed')), 'error');
  } finally {
    mediaStorageSaving.value = false;
  }
}

export async function handleMediaStorageCalibrate(
  patch: Pick<
    MediaStoragePatchInput,
    'recalibrate_filebase' | 'recalibrate_b2' | 'recalibrate_r2' | 'recalibrate_kv' | 'gc_orphan_kv' | 'backfill_usage'
  >,
): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || mediaStorageCalibrating.value || mediaStorageSaving.value) return;
  mediaStorageCalibrating.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const updated = await client.setMediaStorageSetting(patch);
    mediaStorageUsage.value = updated.usage;
    mediaStorageActiveWrite.value = updated.active_write_backend ?? updated.backend;
    showToast(t('settingsMediaStorageCalibrated'), 'info');
  } catch (err) {
    showToast(
      err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsMediaStorageCalibrateFailed')),
      'error',
    );
  } finally {
    mediaStorageCalibrating.value = false;
  }
}

/** M8-14-10c：打开清理孤儿 KV 确认框 */
export function handleGcOrphanKv(): void {
  if (mediaStorageCalibrating.value || mediaStorageSaving.value) return;
  mediaStorageConfirmKind.value = 'gc-orphan-kv';
}

export async function confirmGcOrphanKv(): Promise<void> {
  mediaStorageConfirmKind.value = null;
  await handleMediaStorageCalibrate({ gc_orphan_kv: true });
}

/** M8-14-9：客户端校验阈值 */
function validateThresholds(
  kvHigh: number,
  kvMb: number,
  r2High: number,
  r2Target: number,
): string | null {
  if (!(kvHigh > 0.01 && kvHigh < 0.99)) return t('settingsMediaStorageR2KvHighInvalid');
  if (!(r2High > 0.01 && r2High < 0.99)) return t('settingsMediaStorageR2R2HighInvalid');
  if (r2Target >= r2High) return t('settingsMediaStorageR2TargetMustBeLower');
  if (kvMb < 1) return t('settingsMediaStorageR2KvPreferredMin');
  return null;
}

/** M8-14-9：单独保存阈值表单（无需重新部署） */
export async function handleSaveThresholds(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || mediaStorageSaving.value) return;
  const kvHigh = mediaStorageKvHighWatermark.value;
  const kvMb = mediaStorageKvPreferredMaxMb.value;
  const r2High = mediaStorageR2HighWatermark.value;
  const r2Target = mediaStorageR2TargetWatermark.value;
  const err = validateThresholds(kvHigh, kvMb, r2High, r2Target);
  if (err) {
    showToast(err, 'error');
    return;
  }
  mediaStorageSaving.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const updated = await client.setMediaStorageSetting({
      thresholds: {
        kv_high_watermark: kvHigh,
        kv_preferred_max_bytes: Math.round(kvMb * 1024 * 1024),
        r2_high_watermark: r2High,
        r2_target_watermark: r2Target,
      },
    });
    applyThresholdResponse(updated);
    showToast(t('settingsMediaStorageR2ThresholdsSaved'), 'info');
  } catch (e) {
    showToast(
      e instanceof ApiError ? e.displayMessage : getErrorMessage({}, t('settingsMediaStorageR2ThresholdsSaveFailed')),
      'error',
    );
  } finally {
    mediaStorageSaving.value = false;
  }
}
