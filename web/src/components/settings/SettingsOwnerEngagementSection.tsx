/** @jsxImportSource preact */
/** M34-2：站主未活跃时关注流自动同步暂停 + 手动同步 */
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { formatLogTime } from './settingsUtils';
import {
  onlineStatus,
  onlineStatusLoading,
  feedAggregateRunning,
  refreshOnlineStatus,
  handleRunFeedAggregateNow,
} from './hooks/useOwnerEngagementSettings';
import { loggedInHandle } from './hooks/useSettingsSession';

export function SettingsOwnerEngagementSection(): VNode | null {
  useEffect(() => {
    if (!loggedInHandle.value) return;
    void refreshOnlineStatus();
  }, [loggedInHandle.value]);

  if (!loggedInHandle.value) return null;

  const snap = onlineStatus.value;
  const sync = snap?.feed_auto_sync ?? null;
  const paused = sync === 'paused';
  const slow = sync === 'slow';
  const floor = sync === 'floor';

  const bannerCls = paused
    ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100'
    : floor
      ? 'border-violet-300 bg-violet-50 text-violet-950 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-100'
      : slow
      ? 'border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100'
      : 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100';

  const bannerText = (() => {
    if (!snap) return t('settingsFeedSyncLoading');
    const last = formatLogTime(snap.feed_pull_last_ok_at);
    if (paused) {
      return t('settingsFeedSyncPausedBanner', undefined, { time: last });
    }
    if (floor) {
      return t('settingsFeedSyncFloorBanner', undefined, { time: last });
    }
    if (slow) {
      return t('settingsFeedSyncSlowBanner', undefined, { time: last });
    }
    return t('settingsFeedSyncRunningBanner', undefined, { time: last });
  })();

  return (
    <section class={SETTINGS_SECTION_CLASS}>
      <SettingsSectionHeader
        sectionKey="ownerEngagement"
        title={t('settingsFeedSyncTitle')}
        trailing={
          <button
            type="button"
            disabled={feedAggregateRunning.value || onlineStatusLoading.value}
            onClick={() => {
              void handleRunFeedAggregateNow();
            }}
            class={SETTINGS_PRIMARY_BTN_CLASS}
          >
            {feedAggregateRunning.value ? t('settingsFeedSyncRunning') : t('settingsFeedSyncRunNow')}
          </button>
        }
      />
      <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
        {t('settingsFeedSyncDescription')}
      </p>

      <p class={`mt-3 rounded-md border px-3 py-2 text-sm ${bannerCls}`} role="status">
        {onlineStatusLoading.value && !snap ? t('settingsFeedSyncLoading') : bannerText}
      </p>

      {snap ? (
        <dl class="mt-3 grid gap-1 text-xs text-slate-600 dark:text-zinc-400 sm:grid-cols-2">
          <div class="flex justify-between gap-3">
            <dt>{t('settingsFeedSyncEngagement')}</dt>
            <dd class="font-mono">{snap.owner_engagement}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>{t('settingsFeedSyncLastSeen')}</dt>
            <dd>{formatLogTime(snap.owner_last_seen_at)}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>{t('settingsFeedSyncPolicy')}</dt>
            <dd class="font-mono">{snap.owner_dormant_feed_policy}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>{t('settingsFeedSyncLastPull')}</dt>
            <dd>{formatLogTime(snap.feed_pull_last_ok_at)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
