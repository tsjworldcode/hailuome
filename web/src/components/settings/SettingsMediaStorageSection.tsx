/** @jsxImportSource preact */
/** M-REFACTOR-1c：媒体存储 section */
import type { VNode } from 'preact';
import { Trash2 } from 'lucide-preact';
import { ConfirmDialog } from '../ConfirmDialog';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_INPUT_CLASS,
  SETTINGS_OPTION_ROW_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
  SETTINGS_SECONDARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  mediaStorageBackend,
  mediaStorageMode,
  mediaStorageActiveWrite,
  mediaStorageUsage,
  mediaStorageR2Bound,
  mediaStorageKvHighWatermark,
  mediaStorageKvPreferredMaxMb,
  mediaStorageR2HighWatermark,
  mediaStorageR2TargetWatermark,
  mediaStorageB2KeyId,
  mediaStorageB2AppKey,
  mediaStorageB2AppKeySet,
  mediaStorageB2Bucket,
  mediaStorageB2Endpoint,
  mediaStorageB2Region,
  mediaStorageFilebaseKeyId,
  mediaStorageFilebaseAppKey,
  mediaStorageFilebaseAppKeySet,
  mediaStorageFilebaseBucket,
  mediaStorageFilebaseEndpoint,
  mediaStorageFilebaseRegion,
  mediaStorageProbeStatus,
  mediaStorageLoading,
  mediaStorageSaving,
  mediaStorageCalibrating,
  mediaStorageConfirmKind,
  formatStorageBytes,
  usageBarPercent,
  handleMediaStorageSave,
  handleSaveThresholds,
  handleClearB2Config,
  confirmClearB2Config,
  handleClearFilebaseConfig,
  confirmClearFilebaseConfig,
  handleMediaStorageCalibrate,
  handleGcOrphanKv,
  confirmGcOrphanKv,
} from './hooks/useMediaStorageSettings';

export function SettingsMediaStorageSection(): VNode {
  return (
    <>
      <section class={SETTINGS_SECTION_CLASS}>
        <SettingsSectionHeader sectionKey="mediaStorage" title={t('settingsMediaStorageTitle')} />
        <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
          {t('settingsMediaStorageDescription')}
        </p>
        <form class="mt-4 space-y-3" onSubmit={(e) => { void handleMediaStorageSave(e); }}>
          <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
            <input
              type="checkbox"
              checked={mediaStorageMode.value === 'router'}
              onChange={(e) => {
                mediaStorageMode.value = (e.currentTarget as HTMLInputElement).checked ? 'router' : 'manual';
              }}
              disabled={mediaStorageLoading.value || mediaStorageSaving.value}
              class="mt-0.5"
            />
            <span class="text-slate-700 dark:text-zinc-200">{t('settingsMediaStorageRouterToggle')}</span>
          </label>

          {mediaStorageMode.value === 'manual' ? (
          <>
          <p class="text-xs text-slate-600 dark:text-zinc-400">{t('settingsMediaStorageManualHint')}</p>
          <fieldset class="space-y-2" disabled={mediaStorageLoading.value || mediaStorageSaving.value}>
            <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
              <input
                type="radio"
                name="media-storage-backend"
                checked={mediaStorageBackend.value === 'kv'}
                onChange={() => { mediaStorageBackend.value = 'kv'; }}
                class="mt-0.5"
              />
              <span class="text-slate-700 dark:text-zinc-200">{t('settingsMediaStorageKv')}</span>
            </label>
            <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
              <input
                type="radio"
                name="media-storage-backend"
                checked={mediaStorageBackend.value === 'filebase'}
                onChange={() => { mediaStorageBackend.value = 'filebase'; }}
                class="mt-0.5"
              />
              <span class="text-slate-700 dark:text-zinc-200">{t('settingsMediaStorageFilebase')}</span>
            </label>
            <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
              <input
                type="radio"
                name="media-storage-backend"
                checked={mediaStorageBackend.value === 'b2'}
                onChange={() => { mediaStorageBackend.value = 'b2'; }}
                class="mt-0.5"
              />
              <span class="text-slate-700 dark:text-zinc-200">{t('settingsMediaStorageB2')}</span>
            </label>
          </fieldset>
          </>
          ) : (
            <p class="text-xs text-slate-600 dark:text-zinc-400">{t('settingsMediaStorageRouterHint')}</p>
          )}

          {(mediaStorageMode.value === 'router' || mediaStorageBackend.value === 'filebase') ? (
            <div class="space-y-3 rounded-xl border border-zinc-300 p-3 dark:border-zinc-700">
              <p class="text-xs text-slate-600 dark:text-zinc-400">
                {t('settingsMediaStorageFilebaseSignup')}
                {' '}
                <a
                  href="https://console.filebase.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-sky-600 hover:underline dark:text-sky-400"
                >
                  https://console.filebase.com/
                </a>
              </p>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageFilebaseKeyId')}</span>
                <input
                  type="text"
                  value={mediaStorageFilebaseKeyId.value}
                  onInput={(e) => { mediaStorageFilebaseKeyId.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageFilebaseAppKey')}</span>
                <input
                  type="password"
                  value={mediaStorageFilebaseAppKey.value}
                  placeholder={mediaStorageFilebaseAppKeySet.value ? t('settingsMediaStorageFilebaseAppKeyPlaceholder') : undefined}
                  onInput={(e) => { mediaStorageFilebaseAppKey.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="new-password"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageFilebaseBucket')}</span>
                <input
                  type="text"
                  value={mediaStorageFilebaseBucket.value}
                  onInput={(e) => { mediaStorageFilebaseBucket.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageFilebaseEndpoint')}</span>
                <input
                  type="url"
                  value={mediaStorageFilebaseEndpoint.value}
                  onInput={(e) => { mediaStorageFilebaseEndpoint.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageFilebaseRegion')}</span>
                <input
                  type="text"
                  value={mediaStorageFilebaseRegion.value}
                  onInput={(e) => { mediaStorageFilebaseRegion.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
            </div>
          ) : null}

          {(mediaStorageMode.value === 'router' || mediaStorageBackend.value === 'b2') ? (
            <div class="space-y-3 rounded-xl border border-zinc-300 p-3 dark:border-zinc-700">
              <p class="text-xs text-slate-600 dark:text-zinc-400">
                {t('settingsMediaStorageB2Signup')}
                {' '}
                <a
                  href="https://www.backblaze.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-sky-600 hover:underline dark:text-sky-400"
                >
                  https://www.backblaze.com/
                </a>
              </p>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageB2KeyId')}</span>
                <input
                  type="text"
                  value={mediaStorageB2KeyId.value}
                  onInput={(e) => { mediaStorageB2KeyId.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageB2AppKey')}</span>
                <input
                  type="password"
                  value={mediaStorageB2AppKey.value}
                  placeholder={mediaStorageB2AppKeySet.value ? t('settingsMediaStorageB2AppKeyPlaceholder') : undefined}
                  onInput={(e) => { mediaStorageB2AppKey.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="new-password"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageB2Bucket')}</span>
                <input
                  type="text"
                  value={mediaStorageB2Bucket.value}
                  onInput={(e) => { mediaStorageB2Bucket.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageB2Endpoint')}</span>
                <input
                  type="url"
                  value={mediaStorageB2Endpoint.value}
                  onInput={(e) => { mediaStorageB2Endpoint.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
              <label class="block text-sm">
                <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageB2Region')}</span>
                <input
                  type="text"
                  value={mediaStorageB2Region.value}
                  onInput={(e) => { mediaStorageB2Region.value = (e.currentTarget as HTMLInputElement).value; }}
                  class={"mt-1 " + SETTINGS_INPUT_CLASS}
                  autocomplete="off"
                />
              </label>
            </div>
          ) : null}

          <p class="text-xs text-slate-500 dark:text-zinc-400">
            {mediaStorageProbeStatus.value === 'ok'
              ? (mediaStorageBackend.value === 'filebase'
                ? t('settingsMediaStorageProbeOkFilebase')
                : mediaStorageBackend.value === 'b2'
                  ? t('settingsMediaStorageProbeOk')
                  : t('settingsMediaStorageProbeOkKv'))
              : (mediaStorageBackend.value === 'filebase'
                ? t('settingsMediaStorageProbeFailFilebase')
                : mediaStorageBackend.value === 'b2'
                  ? t('settingsMediaStorageProbeFail')
                  : t('settingsMediaStorageProbeFailKv'))}
          </p>

          <div class="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={mediaStorageLoading.value || mediaStorageSaving.value}
              class={SETTINGS_PRIMARY_BTN_CLASS}
            >
              {mediaStorageSaving.value ? t('settingsMediaStorageSaving') : t('settingsMediaStorageSave')}
            </button>
            <button
              type="button"
              disabled={mediaStorageLoading.value || mediaStorageSaving.value}
              onClick={() => { void handleClearFilebaseConfig(); }}
              class={SETTINGS_SECONDARY_BTN_CLASS}
            >
              {t('settingsMediaStorageClearFilebase')}
            </button>
            <button
              type="button"
              disabled={mediaStorageLoading.value || mediaStorageSaving.value}
              onClick={() => { void handleClearB2Config(); }}
              class={SETTINGS_SECONDARY_BTN_CLASS}
            >
              {t('settingsMediaStorageClearB2')}
            </button>
          </div>
        </form>

        {/* M8-14-10：KV 状态卡 — IMAGE_KV 自记账用量（软上限约 1 GiB） */}
        <div class="mt-5 space-y-3 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
          <h3 class="text-sm font-semibold text-slate-900 dark:text-zinc-50">{t('settingsMediaStorageKvStatusTitle')}</h3>
          <div class="flex items-start gap-2">
            <span
              aria-hidden="true"
              class={
                mediaStorageUsage.value?.kv?.configured
                  ? 'mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500'
                  : 'mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500'
              }
            />
            <p class="text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {mediaStorageUsage.value?.kv?.configured
                ? t('settingsMediaStorageKvStatusBound')
                : t('settingsMediaStorageKvStatusUnbound')}
            </p>
          </div>
          {mediaStorageUsage.value?.kv ? (
            <div class="space-y-1">
              <div class="flex justify-between text-xs text-slate-600 dark:text-zinc-400">
                <span>{t('settingsMediaStorageKvUsageLabel')}</span>
                <span>
                  {formatStorageBytes(mediaStorageUsage.value.kv.bytes_used)}
                  {mediaStorageUsage.value.kv.bytes_limit != null
                    ? ` / ${formatStorageBytes(mediaStorageUsage.value.kv.bytes_limit)}`
                    : ''}
                  {mediaStorageUsage.value.kv.object_count > 0
                    ? ` · ${mediaStorageUsage.value.kv.object_count} ${t('settingsMediaStorageKvObjectCountLabel')}`
                    : ''}
                </span>
              </div>
              {mediaStorageUsage.value.kv.bytes_threshold != null ? (
                <div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-700">
                  <div
                    class="h-full rounded-full bg-sky-500"
                    style={{ width: `${usageBarPercent(mediaStorageUsage.value.kv)}%` }}
                  />
                </div>
              ) : null}
              <p class="text-xs text-slate-500 dark:text-zinc-500">{t('settingsMediaStorageKvUsageHint')}</p>
            </div>
          ) : (
            <p class="text-xs text-slate-500 dark:text-zinc-500">{t('settingsMediaStorageKvNotConfigured')}</p>
          )}
        </div>

        {/* M8-14-9：R2 状态卡 — 显示是否已绑定、当前用量 */}
        <div class="mt-5 space-y-3 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
          <h3 class="text-sm font-semibold text-slate-900 dark:text-zinc-50">{t('settingsMediaStorageR2StatusTitle')}</h3>
          <div class="flex items-start gap-2">
            <span
              aria-hidden="true"
              class={
                mediaStorageR2Bound.value
                  ? 'mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500'
                  : 'mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500'
              }
            />
            <p class="text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {mediaStorageR2Bound.value
                ? t('settingsMediaStorageR2StatusBound')
                : t('settingsMediaStorageR2StatusUnbound')}
            </p>
          </div>
          {mediaStorageUsage.value?.r2 ? (
            <div class="space-y-1">
              <div class="flex justify-between text-xs text-slate-600 dark:text-zinc-400">
                <span>{t('settingsMediaStorageR2UsageLabel')}</span>
                <span>
                  {formatStorageBytes(mediaStorageUsage.value.r2.bytes_used)}
                  {mediaStorageUsage.value.r2.bytes_limit != null
                    ? ` / ${formatStorageBytes(mediaStorageUsage.value.r2.bytes_limit)}`
                    : ''}
                  {mediaStorageUsage.value.r2.object_count > 0
                    ? ` · ${mediaStorageUsage.value.r2.object_count} ${t('settingsMediaStorageR2ObjectCountLabel')}`
                    : ''}
                </span>
              </div>
              {mediaStorageUsage.value.r2.bytes_threshold != null ? (
                <div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-700">
                  <div
                    class="h-full rounded-full bg-violet-500"
                    style={{ width: `${usageBarPercent(mediaStorageUsage.value.r2)}%` }}
                  />
                </div>
              ) : null}
              <p class="text-xs text-slate-500 dark:text-zinc-500">
                {t('settingsMediaStorageR2UsageHint')}
                {mediaStorageUsage.value.r2.last_calibrated_at
                  ? ` · ${t('settingsMediaStorageR2LastCalibratedLabel')}: ${mediaStorageUsage.value.r2.last_calibrated_at}`
                  : ''}
              </p>
            </div>
          ) : (
            <p class="text-xs text-slate-500 dark:text-zinc-500">{t('settingsMediaStorageR2NotConfigured')}</p>
          )}
        </div>

        {/* M8-14-9：KV/R2 阈值表单 — 写入 D1 立即生效 */}
        <div class="mt-5 space-y-3 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
          <div>
            <h3 class="text-sm font-semibold text-slate-900 dark:text-zinc-50">{t('settingsMediaStorageR2ThresholdFormTitle')}</h3>
            <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">{t('settingsMediaStorageR2ThresholdFormHint')}</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block text-sm">
              <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageR2KvHighWatermarkLabel')}</span>
              <div class="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  value={Math.round(mediaStorageKvHighWatermark.value * 100)}
                  onInput={(e) => {
                    const raw = Number((e.currentTarget as HTMLInputElement).value);
                    if (!Number.isFinite(raw)) return;
                    const pct = Math.min(99, Math.max(1, Math.round(raw)));
                    mediaStorageKvHighWatermark.value = pct / 100;
                  }}
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value}
                  class={SETTINGS_INPUT_CLASS + ' flex-1'}
                />
                <span class="text-xs text-slate-500 dark:text-zinc-400">{t('settingsMediaStorageR2PercentUnit')}</span>
              </div>
            </label>
            <label class="block text-sm">
              <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageR2KvPreferredMaxLabel')}</span>
              <div class="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={Math.round(mediaStorageKvPreferredMaxMb.value)}
                  onInput={(e) => {
                    const raw = Number((e.currentTarget as HTMLInputElement).value);
                    if (!Number.isFinite(raw)) return;
                    mediaStorageKvPreferredMaxMb.value = Math.max(1, Math.round(raw));
                  }}
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value}
                  class={SETTINGS_INPUT_CLASS + ' flex-1'}
                />
                <span class="text-xs text-slate-500 dark:text-zinc-400">{t('settingsMediaStorageR2MbUnit')}</span>
              </div>
            </label>
            <label class="block text-sm">
              <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageR2R2HighWatermarkLabel')}</span>
              <div class="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  value={Math.round(mediaStorageR2HighWatermark.value * 100)}
                  onInput={(e) => {
                    const raw = Number((e.currentTarget as HTMLInputElement).value);
                    if (!Number.isFinite(raw)) return;
                    const pct = Math.min(99, Math.max(1, Math.round(raw)));
                    mediaStorageR2HighWatermark.value = pct / 100;
                  }}
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value || !mediaStorageR2Bound.value}
                  class={SETTINGS_INPUT_CLASS + ' flex-1'}
                />
                <span class="text-xs text-slate-500 dark:text-zinc-400">{t('settingsMediaStorageR2PercentUnit')}</span>
              </div>
            </label>
            <label class="block text-sm">
              <span class="text-slate-700 dark:text-zinc-300">{t('settingsMediaStorageR2R2TargetWatermarkLabel')}</span>
              <div class="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  value={Math.round(mediaStorageR2TargetWatermark.value * 100)}
                  onInput={(e) => {
                    const raw = Number((e.currentTarget as HTMLInputElement).value);
                    if (!Number.isFinite(raw)) return;
                    const pct = Math.min(99, Math.max(1, Math.round(raw)));
                    mediaStorageR2TargetWatermark.value = pct / 100;
                  }}
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value || !mediaStorageR2Bound.value}
                  class={SETTINGS_INPUT_CLASS + ' flex-1'}
                />
                <span class="text-xs text-slate-500 dark:text-zinc-400">{t('settingsMediaStorageR2PercentUnit')}</span>
              </div>
            </label>
          </div>
          <div class="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={mediaStorageLoading.value || mediaStorageSaving.value}
              onClick={() => { void handleSaveThresholds(); }}
              class={SETTINGS_PRIMARY_BTN_CLASS}
            >
              {mediaStorageSaving.value ? t('settingsMediaStorageSaving') : t('settingsMediaStorageSave')}
            </button>
          </div>
        </div>

        {(mediaStorageUsage.value?.filebase || mediaStorageUsage.value?.b2 || mediaStorageUsage.value?.r2) ? (
          <div class="mt-5 space-y-3 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
            <h3 class="text-sm font-semibold text-slate-900 dark:text-zinc-50">{t('settingsMediaStorageUsageTitle')}</h3>
            {mediaStorageActiveWrite.value ? (
              <p class="text-xs text-slate-600 dark:text-zinc-400">
                {t('settingsMediaStorageActiveWrite')}: {mediaStorageActiveWrite.value}
              </p>
            ) : null}
            {mediaStorageUsage.value?.filebase ? (
              <div class="space-y-1">
                <div class="flex justify-between text-xs text-slate-600 dark:text-zinc-400">
                  <span>Filebase</span>
                  <span>
                    {formatStorageBytes(mediaStorageUsage.value.filebase.bytes_used)}
                    {mediaStorageUsage.value.filebase.bytes_limit != null
                      ? ` / ${formatStorageBytes(mediaStorageUsage.value.filebase.bytes_limit)}`
                      : ''}
                  </span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-700">
                  <div
                    class="h-full rounded-full bg-sky-500"
                    style={{ width: `${usageBarPercent(mediaStorageUsage.value.filebase)}%` }}
                  />
                </div>
                <p class="text-xs text-slate-500 dark:text-zinc-500">
                  {t('settingsMediaStorageUsageThreshold')}: {mediaStorageUsage.value.filebase.bytes_threshold != null ? formatStorageBytes(mediaStorageUsage.value.filebase.bytes_threshold) : '—'}
                  {' · '}
                  {mediaStorageUsage.value.filebase.status}
                </p>
              </div>
            ) : null}
            {mediaStorageUsage.value?.b2 ? (
              <div class="space-y-1">
                <div class="flex justify-between text-xs text-slate-600 dark:text-zinc-400">
                  <span>B2</span>
                  <span>
                    {formatStorageBytes(mediaStorageUsage.value.b2.bytes_used)}
                    {mediaStorageUsage.value.b2.bytes_limit != null
                      ? ` / ${formatStorageBytes(mediaStorageUsage.value.b2.bytes_limit)}`
                      : ''}
                  </span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-700">
                  <div
                    class="h-full rounded-full bg-emerald-500"
                    style={{ width: `${usageBarPercent(mediaStorageUsage.value.b2)}%` }}
                  />
                </div>
                <p class="text-xs text-slate-500 dark:text-zinc-500">
                  {t('settingsMediaStorageUsageThreshold')}: {mediaStorageUsage.value.b2.bytes_threshold != null ? formatStorageBytes(mediaStorageUsage.value.b2.bytes_threshold) : '—'}
                  {' · '}
                  {mediaStorageUsage.value.b2.status}
                </p>
              </div>
            ) : null}
            {mediaStorageUsage.value?.r2 ? (
              <div class="space-y-1">
                <div class="flex justify-between text-xs text-slate-600 dark:text-zinc-400">
                  <span>R2</span>
                  <span>
                    {formatStorageBytes(mediaStorageUsage.value.r2.bytes_used)}
                    {mediaStorageUsage.value.r2.object_count > 0
                      ? ` · ${mediaStorageUsage.value.r2.object_count} ${t('settingsMediaStorageObjectCount')}`
                      : ''}
                  </span>
                </div>
                {mediaStorageUsage.value.r2.bytes_threshold != null ? (
                  <div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-700">
                    <div
                      class="h-full rounded-full bg-violet-500"
                      style={{ width: `${usageBarPercent(mediaStorageUsage.value.r2)}%` }}
                    />
                  </div>
                ) : null}
                <p class="text-xs text-slate-500 dark:text-zinc-500">
                  {t('settingsMediaStorageR2UsageHint')}
                  {mediaStorageUsage.value.r2.last_calibrated_at
                    ? ` · ${t('settingsMediaStorageLastCalibrated')}: ${mediaStorageUsage.value.r2.last_calibrated_at}`
                    : ''}
                </p>
              </div>
            ) : null}
            <div class="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={mediaStorageLoading.value || mediaStorageSaving.value || mediaStorageCalibrating.value}
                onClick={() => { void handleMediaStorageCalibrate({ backfill_usage: true }); }}
                class="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {t('settingsMediaStorageBackfillUsage')}
              </button>
              {mediaStorageUsage.value?.kv ? (
                <button
                  type="button"
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value || mediaStorageCalibrating.value}
                  onClick={() => { void handleMediaStorageCalibrate({ recalibrate_kv: true }); }}
                  class="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {t('settingsMediaStorageRecalibrateKv')}
                </button>
              ) : null}
              {mediaStorageUsage.value?.kv ? (
                <button
                  type="button"
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value || mediaStorageCalibrating.value}
                  onClick={() => { handleGcOrphanKv(); }}
                  class="rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-800 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
                >
                  {t('settingsMediaStorageGcOrphanKv')}
                </button>
              ) : null}
              {mediaStorageUsage.value?.filebase ? (
                <button
                  type="button"
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value || mediaStorageCalibrating.value}
                  onClick={() => { void handleMediaStorageCalibrate({ recalibrate_filebase: true }); }}
                  class="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {t('settingsMediaStorageRecalibrateFilebase')}
                </button>
              ) : null}
              {mediaStorageUsage.value?.b2 ? (
                <button
                  type="button"
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value || mediaStorageCalibrating.value}
                  onClick={() => { void handleMediaStorageCalibrate({ recalibrate_b2: true }); }}
                  class="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {t('settingsMediaStorageRecalibrateB2')}
                </button>
              ) : null}
              {mediaStorageUsage.value?.r2 ? (
                <button
                  type="button"
                  disabled={mediaStorageLoading.value || mediaStorageSaving.value || mediaStorageCalibrating.value}
                  onClick={() => { void handleMediaStorageCalibrate({ recalibrate_r2: true }); }}
                  class="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {t('settingsMediaStorageRecalibrateR2')}
                </button>
              ) : null}
            </div>
            <p class="text-xs text-slate-500 dark:text-zinc-500">{t('settingsMediaStorageCalibrateHint')}</p>
          </div>
        ) : null}
      </section>
      <ConfirmDialog
        open={mediaStorageConfirmKind.value === 'clear-b2'}
        pending={mediaStorageSaving.value}
        title={t('settingsMediaStorageClearB2DialogTitle')}
        body={<p>{t('settingsMediaStorageClearB2Confirm')}</p>}
        cancelLabel={t('settingsMediaStorageClearB2DialogCancel')}
        confirmLabel={t('settingsMediaStorageClearB2DialogConfirm')}
        confirmPendingLabel={t('settingsMediaStorageClearB2DialogPending')}
        icon={<Trash2 size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!mediaStorageSaving.value) mediaStorageConfirmKind.value = null;
        }}
        onConfirm={() => void confirmClearB2Config()}
      />
      <ConfirmDialog
        open={mediaStorageConfirmKind.value === 'clear-filebase'}
        pending={mediaStorageSaving.value}
        title={t('settingsMediaStorageClearFilebaseDialogTitle')}
        body={<p>{t('settingsMediaStorageClearFilebaseConfirm')}</p>}
        cancelLabel={t('settingsMediaStorageClearFilebaseDialogCancel')}
        confirmLabel={t('settingsMediaStorageClearFilebaseDialogConfirm')}
        confirmPendingLabel={t('settingsMediaStorageClearFilebaseDialogPending')}
        icon={<Trash2 size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!mediaStorageSaving.value) mediaStorageConfirmKind.value = null;
        }}
        onConfirm={() => void confirmClearFilebaseConfig()}
      />
      <ConfirmDialog
        open={mediaStorageConfirmKind.value === 'gc-orphan-kv'}
        pending={mediaStorageCalibrating.value}
        title={t('settingsMediaStorageGcOrphanKvDialogTitle')}
        body={<p>{t('settingsMediaStorageGcOrphanKvConfirm')}</p>}
        cancelLabel={t('settingsMediaStorageGcOrphanKvDialogCancel')}
        confirmLabel={t('settingsMediaStorageGcOrphanKvDialogConfirm')}
        confirmPendingLabel={t('settingsMediaStorageGcOrphanKvDialogPending')}
        icon={<Trash2 size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!mediaStorageCalibrating.value) mediaStorageConfirmKind.value = null;
        }}
        onConfirm={() => void confirmGcOrphanKv()}
      />
    </>
  );
}
