/** @jsxImportSource preact */
/** M-REFACTOR-1c：注册中心状态 + 日同步 + 运行日志 section */
import type { VNode } from 'preact';
import { KeyRound } from 'lucide-preact';
import { ConfirmDialog } from '../ConfirmDialog';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
  SETTINGS_SECONDARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  formatRegistryStatusLabel,
  formatRegistryStatusTone,
  loadPublicRegistryEndpoints,
  publicRegistryEndpoints,
} from '../../lib/registryEndpoints';
import { formatLogTime, logLevelClass } from './settingsUtils';
import {
  logItems,
  logStatus,
  dailySyncStatus,
  dailySyncRunning,
  manualSyncCooldownHours,
  federationProbeHandle,
  federationProbeRunning,
  publicHealthProbe,
  publicHealthProbing,
  logsLoading,
  officialPulling,
  logsMsg,
  registryEndpointsLoading,
  refreshOperationLogs,
  handleCleanupLogs,
  handleProbePublicHealth,
  handleRunDailySyncNow,
  handleFederationProbeLookup,
  handlePullOfficialFeedNow,
} from './hooks/useRegistryDiagnosticsSettings';
import {
  registryTokenConfirmKind,
  rotateRegistryTokenPending,
  handleRotateRegistryToken,
  confirmRotateRegistryToken,
} from './hooks/useRegistryTokenRotateSettings';

export function SettingsRegistryDiagnosticsSection(): VNode {
  return (
    <>
      <section class={SETTINGS_SECTION_CLASS}>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SettingsSectionHeader sectionKey="registryDiagnostics" title={t('settingsRegistryStatusTitle')} />
            <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {t('settingsRegistryStatusDescription')}
            </p>
          </div>
          <a
            href="/register"
            class={SETTINGS_SECONDARY_BTN_CLASS}
          >
            {t('settingsRegistryRegisterLink')}
          </a>
        </div>

        <div class="mt-4 rounded-md border border-zinc-200 px-3 py-3 dark:border-zinc-700">
          <p class="text-sm text-zinc-700 dark:text-zinc-300">
            {t('settingsRegistryTokenRotateHint')}
          </p>
          <button
            type="button"
            class={`${SETTINGS_SECONDARY_BTN_CLASS} mt-3`}
            disabled={rotateRegistryTokenPending.value}
            onClick={() => handleRotateRegistryToken()}
          >
            {rotateRegistryTokenPending.value
              ? t('settingsRegistryTokenRotatePending')
              : t('settingsRegistryTokenRotateButton')}
          </button>
        </div>

        {registryEndpointsLoading.value && (publicRegistryEndpoints.value?.length ?? 0) === 0 ? (
          <p class="mt-3 text-sm text-slate-500 dark:text-zinc-400">{t('settingsRegistryLoadingList')}</p>
        ) : null}

        {(publicRegistryEndpoints.value?.length ?? 0) === 0 && !registryEndpointsLoading.value ? (
          <p class="mt-3 text-sm text-slate-500 dark:text-zinc-400">
            {t('settingsRegistryEmpty')}
          </p>
        ) : null}

        {(publicRegistryEndpoints.value?.length ?? 0) > 0 ? (
          <ul class="mt-4 space-y-2">
            {publicRegistryEndpoints.value!.map((endpoint) => {
              const tone = formatRegistryStatusTone(endpoint.status);
              const badgeCls =
                tone === 'ok'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                  : tone === 'bad'
                    ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
                    : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200';
              return (
                <li
                  key={endpoint.registry_id}
                  class="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700"
                >
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <div class="min-w-0">
                      <p class="font-mono text-sm font-medium text-slate-900 dark:text-zinc-100">
                        {endpoint.registry_id}
                      </p>
                      <p class="mt-0.5 break-all text-xs text-slate-500 dark:text-zinc-400">
                        {endpoint.registry_url}
                      </p>
                    </div>
                    <span class={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${badgeCls}`}>
                      {formatRegistryStatusLabel(endpoint.status)}
                    </span>
                    {endpoint.url_sync_state === 'stale' && (
                      <span class="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                        {t('settingsRegistryUrlStale')}
                      </span>
                    )}
                  </div>
                  <dl class="mt-2 grid gap-1 text-xs text-slate-600 dark:text-zinc-400 sm:grid-cols-3">
                    <div>
                      <dt class="inline">{t('settingsRegistryLastOk')}</dt>
                      <dd class="inline">{formatLogTime(endpoint.last_ok_at ?? null)}</dd>
                    </div>
                    <div>
                      <dt class="inline">{t('settingsRegistryLastFail')}</dt>
                      <dd class="inline">{formatLogTime(endpoint.last_fail_at ?? null)}</dd>
                    </div>
                    <div>
                      <dt class="inline">{t('settingsRegistryFailStreak')}</dt>
                      <dd class="inline">{endpoint.fail_streak}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {/* ── 注册中心状态（M9-3-7）────────────────────────────────────── */}
      <section class={SETTINGS_SECTION_CLASS}>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class={SETTINGS_SECTION_TITLE_CLASS}>{t('settingsRegistryStatusTitle')}</h2>
            <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {(() => {
                const pageLink = t('settingsRegistryRegisterPageLink');
                const desc = t('settingsRegistryStatusDescriptionAlt');
                const at = desc.indexOf(pageLink);
                if (at < 0) return desc;
                return (
                  <>
                    {desc.slice(0, at)}
                    <a href="/register" class="text-sky-600 hover:underline dark:text-sky-400">{pageLink}</a>
                    {desc.slice(at + pageLink.length)}
                  </>
                );
              })()}
            </p>
          </div>
          <button
            type="button"
            disabled={registryEndpointsLoading.value}
            onClick={() => {
              registryEndpointsLoading.value = true;
              void loadPublicRegistryEndpoints().finally(() => {
                registryEndpointsLoading.value = false;
              });
            }}
            class="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {registryEndpointsLoading.value ? t('settingsRegistryRefreshing') : t('settingsRegistryRefresh')}
          </button>
        </div>

        {registryEndpointsLoading.value && (publicRegistryEndpoints.value?.length ?? 0) === 0 ? (
          <p class="mt-4 text-sm text-slate-500 dark:text-zinc-400">{t('settingsRegistryLoadingList')}</p>
        ) : null}

        {(publicRegistryEndpoints.value?.length ?? 0) === 0 && !registryEndpointsLoading.value ? (
          <p class="mt-4 text-sm text-slate-500 dark:text-zinc-400">
            {t('settingsRegistryEmpty')}
          </p>
        ) : null}

        {(publicRegistryEndpoints.value?.length ?? 0) > 0 ? (
          <ul class="mt-4 space-y-2">
            {publicRegistryEndpoints.value!.map((endpoint) => {
              const tone = formatRegistryStatusTone(endpoint.status);
              const badgeCls =
                tone === 'ok'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                  : tone === 'bad'
                    ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
                    : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200';
              return (
                <li
                  key={endpoint.registry_id}
                  class="rounded-xl border border-zinc-300 p-3 dark:border-zinc-700"
                >
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <div class="min-w-0">
                      <p class="font-mono text-sm font-medium text-slate-900 dark:text-zinc-50">
                        {endpoint.registry_id}
                      </p>
                      <p class="mt-1 break-all text-xs text-slate-500 dark:text-zinc-400">
                        {endpoint.registry_url}
                      </p>
                    </div>
                    <span class={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${badgeCls}`}>
                      {formatRegistryStatusLabel(endpoint.status)}
                    </span>
                    {endpoint.url_sync_state === 'stale' && (
                      <span class="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                        {t('settingsRegistryUrlStale')}
                      </span>
                    )}
                  </div>
                  <dl class="mt-2 grid gap-1 text-xs text-slate-600 dark:text-zinc-400 sm:grid-cols-3">
                    <div>
                      <dt class="inline">{t('settingsRegistryLastOk')}</dt>
                      <dd class="inline">{formatLogTime(endpoint.last_ok_at ?? null)}</dd>
                    </div>
                    <div>
                      <dt class="inline">{t('settingsRegistryLastFail')}</dt>
                      <dd class="inline">{formatLogTime(endpoint.last_fail_at ?? null)}</dd>
                    </div>
                    <div>
                      <dt class="inline">{t('settingsRegistryFailStreak')}</dt>
                      <dd class="inline">{endpoint.fail_streak}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {/* ── 2b. 注册中心日同步诊断（M-DS-2a） ─────────────────────────── */}
      <section class={SETTINGS_SECTION_CLASS}>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class={SETTINGS_SECTION_TITLE_CLASS}>{t('settingsDailySyncTitle')}</h2>
            <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {t('settingsDailySyncDescription')}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={publicHealthProbing.value || dailySyncRunning.value}
              onClick={() => { void handleProbePublicHealth(); }}
              class="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {publicHealthProbing.value ? t('settingsPublicHealthProbing') : t('settingsPublicHealthProbe')}
            </button>
            <button
              type="button"
              disabled={dailySyncRunning.value || logsLoading.value || manualSyncCooldownHours.value !== null}
              onClick={() => { void handleRunDailySyncNow(); }}
              class="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-violet-400"
            >
              {dailySyncRunning.value ? t('settingsDailySyncRunning') : t('settingsDailySyncRunNow')}
            </button>
          </div>
        </div>

        {manualSyncCooldownHours.value !== null ? (
          <p
            data-m16-daily-sync-cooldown-1="cooldown-hint"
            class="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            {t('settingsDailySyncCooldownActive', undefined, { hours: String(manualSyncCooldownHours.value) })}
          </p>
        ) : null}

        {publicHealthProbe.value ? (
          <p class={`mt-3 rounded-md border px-3 py-2 text-xs ${
            publicHealthProbe.value.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
              : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200'
          }`}>
            {publicHealthProbe.value.ok
              ? t('settingsPublicHealthOk', undefined, {
                  status: publicHealthProbe.value.http_status ?? 200,
                  ms: publicHealthProbe.value.latency_ms,
                })
              : t('settingsPublicHealthFail', undefined, {
                  error: publicHealthProbe.value.error ?? t('settingsPublicHealthUnknown'),
                })}
          </p>
        ) : null}

        {dailySyncStatus.value ? (
          <div class="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <div class="rounded-md border border-zinc-300 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
              <div class="font-medium text-slate-700 dark:text-zinc-200">{t('settingsDailySyncOverallTitle')}</div>
              <dl class="mt-2 space-y-1 text-slate-600 dark:text-zinc-400">
                <div class="flex justify-between gap-3">
                  <dt>{t('settingsDailySyncInterval')}</dt>
                  <dd>
                    {t('settingsDailySyncIntervalDays', undefined, {
                      days: String(dailySyncStatus.value.sync_interval_days ?? 30),
                    })}
                  </dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt>{t('settingsDailySyncPolicyPoll')}</dt>
                  <dd>
                    {t('settingsDailySyncPolicyPollDays', undefined, {
                      days: String(dailySyncStatus.value.policy_poll?.policy_poll_interval_days ?? 7),
                    })}
                    {dailySyncStatus.value.policy_poll?.last_status
                      ? ` · ${dailySyncStatus.value.policy_poll.last_status}`
                      : ''}
                  </dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt>{t('settingsDailySyncLastSuccess')}</dt>
                  <dd>{formatLogTime(dailySyncStatus.value.last_success_at)}</dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt>{t('settingsDailySyncLastStatus')}</dt>
                  <dd>{dailySyncStatus.value.last_status ?? t('settingsLogsNotRun')}</dd>
                </div>
              </dl>
              {dailySyncStatus.value.last_error ? (
                <p class="mt-2 text-amber-700 dark:text-amber-300">{dailySyncStatus.value.last_error}</p>
              ) : null}
            </div>
            <div class="rounded-md border border-zinc-300 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
              <div class="font-medium text-slate-700 dark:text-zinc-200">{t('settingsDailySyncBlocksTitle')}</div>
              <dl class="mt-2 space-y-1 text-slate-600 dark:text-zinc-400">
                <div class="flex justify-between gap-3">
                  <dt>{t('settingsDailySyncOfficialFeed')}</dt>
                  <dd>{dailySyncStatus.value.official_feed.last_status ?? t('settingsLogsNotRun')}</dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt>{t('settingsDailySyncBlacklist')}</dt>
                  <dd>{formatLogTime(dailySyncStatus.value.blacklist.last_sync_at)}</dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt>{t('settingsDailySyncRecommendations')}</dt>
                  <dd>
                    {dailySyncStatus.value.recommendations.last_fetched_count > 0
                      ? t('settingsDailySyncRecommendationsCount', undefined, {
                          count: dailySyncStatus.value.recommendations.last_fetched_count,
                        })
                      : (dailySyncStatus.value.recommendations.last_status ?? t('settingsLogsNotRun'))}
                  </dd>
                </div>
              </dl>
            </div>
            {dailySyncStatus.value.endpoints.length > 0 ? (
              <div class="rounded-md border border-zinc-300 bg-slate-50 p-3 sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-800">
                <div class="font-medium text-slate-700 dark:text-zinc-200">{t('settingsDailySyncEndpointsTitle')}</div>
                <ul class="mt-2 space-y-2">
                  {dailySyncStatus.value.endpoints.map((ep) => (
                    <li key={ep.registry_id} class="flex flex-wrap justify-between gap-2 text-slate-600 dark:text-zinc-400">
                      <span class="mono font-medium text-slate-800 dark:text-zinc-200">{ep.registry_id}</span>
                      <span>
                        {ep.status}
                        {ep.consecutive_fail_days > 0
                          ? ` · ${t('settingsDailySyncFailDays', undefined, { days: ep.consecutive_fail_days })}`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p class="mt-4 text-sm text-slate-500 dark:text-zinc-400">{t('settingsDailySyncEmpty')}</p>
        )}

        {/* M9-3-CL4：联邦解析诊断（不展示 peer 拓扑） */}
        <div class="mt-4 rounded-md border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/30">
          <div class="font-medium text-slate-800 dark:text-zinc-100">{t('settingsFederationTitle')}</div>
          <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">{t('settingsFederationHint')}</p>
          {dailySyncStatus.value?.federation ? (
            <dl class="mt-3 grid gap-2 text-xs sm:grid-cols-2 text-slate-600 dark:text-zinc-400">
              <div class="flex justify-between gap-3">
                <dt>{t('settingsFederationHome')}</dt>
                <dd class="mono text-slate-800 dark:text-zinc-200">
                  {dailySyncStatus.value.federation.home_registry_id ?? '—'}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt>{t('settingsFederationEndpoints')}</dt>
                <dd class="mono">
                  {dailySyncStatus.value.federation.endpoints_count} /{' '}
                  {dailySyncStatus.value.federation.endpoints_cap}
                </dd>
              </div>
              <div class="flex justify-between gap-3 sm:col-span-2">
                <dt>{t('settingsFederationLastHandle')}</dt>
                <dd class="mono">{dailySyncStatus.value.federation.last_lookup?.handle ?? '—'}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt>{t('settingsFederationVia')}</dt>
                <dd class="mono">
                  {dailySyncStatus.value.federation.last_lookup?.resolved_via_registry_id ?? '—'}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt>{t('settingsFederationStale')}</dt>
                <dd>
                  {dailySyncStatus.value.federation.last_lookup == null
                    ? '—'
                    : dailySyncStatus.value.federation.last_lookup.route_stale
                      ? t('settingsFederationYes')
                      : t('settingsFederationNo')}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt>{t('settingsFederationLastStatus')}</dt>
                <dd class="mono">
                  {dailySyncStatus.value.federation.last_lookup
                    ? `${dailySyncStatus.value.federation.last_lookup.http_status}${
                        dailySyncStatus.value.federation.last_lookup.error_code
                          ? ` · ${dailySyncStatus.value.federation.last_lookup.error_code}`
                          : ''
                      }`
                    : '—'}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt>{t('settingsFederationLastAt')}</dt>
                <dd>{formatLogTime(dailySyncStatus.value.federation.last_lookup?.at ?? null)}</dd>
              </div>
              <div class="flex justify-between gap-3 sm:col-span-2">
                <dt>{t('settingsFederationBlacklist')}</dt>
                <dd>
                  {t('settingsFederationBlacklistSummary', undefined, {
                    count: String(dailySyncStatus.value.federation.federated_blacklist.item_count ?? 0),
                    enforce: dailySyncStatus.value.federation.federated_blacklist.enforce
                      ? t('settingsFederationYes')
                      : t('settingsFederationNo'),
                    time: formatLogTime(
                      dailySyncStatus.value.federation.federated_blacklist.updated_at,
                    ),
                  })}
                </dd>
              </div>
            </dl>
          ) : (
            <p class="mt-2 text-xs text-slate-500 dark:text-zinc-500">{t('settingsFederationEmpty')}</p>
          )}
          <div class="mt-3 flex flex-wrap items-end gap-2">
            <label class="min-w-[12rem] flex-1 text-xs">
              <span class="mb-1 block text-slate-600 dark:text-zinc-400">{t('settingsFederationProbeLabel')}</span>
              <input
                type="text"
                value={federationProbeHandle.value}
                onInput={(e) => {
                  federationProbeHandle.value = (e.currentTarget as HTMLInputElement).value;
                }}
                placeholder={t('settingsFederationProbePlaceholder')}
                class="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              />
            </label>
            <button
              type="button"
              disabled={federationProbeRunning.value || dailySyncRunning.value}
              onClick={() => { void handleFederationProbeLookup(); }}
              class="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-violet-400"
            >
              {federationProbeRunning.value
                ? t('settingsFederationProbeRunning')
                : t('settingsFederationProbe')}
            </button>
          </div>
        </div>
      </section>

      {/* ── 3. 运行日志与官方公告同步诊断 ─────────────────────────────── */}
      <section class={SETTINGS_SECTION_CLASS}>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class={SETTINGS_SECTION_TITLE_CLASS}>{t('settingsLogsTitle')}</h2>
            <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {t('settingsLogsDescription')}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={officialPulling.value || logsLoading.value}
              onClick={() => { void handlePullOfficialFeedNow(); }}
              class="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-400"
            >
              {officialPulling.value ? t('settingsLogsPulling') : t('settingsLogsPullOfficial')}
            </button>
            <button
              type="button"
              disabled={logsLoading.value || officialPulling.value}
              onClick={() => { void refreshOperationLogs(); }}
              class={SETTINGS_PRIMARY_BTN_CLASS}
            >
              {logsLoading.value ? t('settingsLogsRefreshing') : t('settingsLogsRefresh')}
            </button>
            <button
              type="button"
              disabled={logsLoading.value || officialPulling.value}
              onClick={() => { void handleCleanupLogs(); }}
              class="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {t('settingsLogsCleanup')}
            </button>
          </div>
        </div>

        {logsMsg.value && (
          <p class="mt-3 rounded-md border border-zinc-300 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {logsMsg.value}
          </p>
        )}

        {logStatus.value && (
          <div class="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <div class="rounded-md border border-zinc-300 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
              <div class="font-medium text-slate-700 dark:text-zinc-200">{t('settingsLogsOfficialSyncTitle')}</div>
              <dl class="mt-2 space-y-1 text-slate-600 dark:text-zinc-400">
                <div class="flex justify-between gap-3"><dt>{t('settingsLogsOfficialLastStatus')}</dt><dd>{logStatus.value.last_status ?? t('settingsLogsNotRun')}</dd></div>
                <div class="flex justify-between gap-3"><dt>{t('settingsLogsOfficialCached')}</dt><dd>{logStatus.value.cached_official_count}</dd></div>
                <div class="flex justify-between gap-3"><dt>{t('settingsLogsOfficialLastFetch')}</dt><dd>{logStatus.value.last_fetched_count}</dd></div>
                <div class="flex justify-between gap-3"><dt>{t('settingsLogsOfficialLastInsert')}</dt><dd>{logStatus.value.last_insert_count}</dd></div>
              </dl>
            </div>
            <div class="rounded-md border border-zinc-300 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
              <div class="font-medium text-slate-700 dark:text-zinc-200">{t('settingsLogsAuthConfigTitle')}</div>
              <dl class="mt-2 space-y-1 text-slate-600 dark:text-zinc-400">
                <div class="flex justify-between gap-3"><dt>{t('settingsLogsNodeCredentials')}</dt><dd>{logStatus.value.node_credentials_configured ? t('settingsLogsConfigured') : t('settingsLogsMissing')}</dd></div>
                <div class="flex justify-between gap-3"><dt>{t('settingsLogsNodeSignature')}</dt><dd>{logStatus.value.node_signature_configured ? t('settingsLogsConfigured') : t('settingsLogsMissing')}</dd></div>
                <div class="flex justify-between gap-3"><dt>{t('settingsLogsLastChecked')}</dt><dd>{formatLogTime(logStatus.value.last_checked_at)}</dd></div>
              </dl>
            </div>
            {logStatus.value.last_error && (
              <pre class="sm:col-span-2 max-h-28 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
                {logStatus.value.last_error}
              </pre>
            )}
          </div>
        )}

        <div class="mt-4 max-h-96 min-w-0 overflow-y-auto overflow-x-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
          {logItems.value.length === 0 ? (
            <p class="px-3 py-4 text-sm text-slate-500 dark:text-zinc-400">{t('settingsLogsEmpty')}</p>
          ) : (
            <ul class="divide-y divide-slate-200 dark:divide-zinc-800">
              {logItems.value.map((item) => (
                <li key={item.id} class="space-y-1 px-3 py-2 text-xs">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class={logLevelClass(item.level)}>{item.level}</span>
                    <span class="font-mono text-slate-500 dark:text-zinc-400">{formatLogTime(item.created_at)}</span>
                    <span class="font-mono text-slate-500 dark:text-zinc-400">{item.source}</span>
                    <span class="font-medium text-slate-800 dark:text-zinc-100">{item.event}</span>
                  </div>
                  <p class="break-words text-slate-700 dark:text-zinc-300">{item.message}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <ConfirmDialog
        open={registryTokenConfirmKind.value === 'registry-token-rotate'}
        pending={rotateRegistryTokenPending.value}
        title={t('settingsRegistryTokenRotateDialogTitle')}
        body={<p>{t('settingsRegistryTokenRotateConfirm')}</p>}
        cancelLabel={t('settingsRegistryTokenRotateDialogCancel')}
        confirmLabel={t('settingsRegistryTokenRotateDialogConfirm')}
        confirmPendingLabel={t('settingsRegistryTokenRotateDialogPending')}
        icon={<KeyRound size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!rotateRegistryTokenPending.value) registryTokenConfirmKind.value = null;
        }}
        onConfirm={() => void confirmRotateRegistryToken()}
      />
    </>
  );
}
