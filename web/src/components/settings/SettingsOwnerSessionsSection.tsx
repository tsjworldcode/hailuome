/** @jsxImportSource preact */
/** M34-4：最近登录设备 + 一键注销；M34-4b：标题 = 系统 · 脱敏 IP；M34-4c：ConfirmDialog 替代 window.confirm */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LogOut } from 'lucide-preact';
import { t } from '../../lib/i18n';
import type { OwnerSessionListItem } from '../../lib/workerA/types';
import { ConfirmDialog } from '../ConfirmDialog';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { formatLogTime } from './settingsUtils';
import {
  ownerSessions,
  ownerSessionsLoading,
  ownerSessionRevokingId,
  refreshOwnerSessions,
  handleRevokeOwnerSession,
} from './hooks/useOwnerSessionsSettings';
import { loggedInHandle } from './hooks/useSettingsSession';

/** 从 user_agent_family（Chrome / Windows）取 OS；字面量 unknown/Other 视为无效 */
function extractOsFamily(uaFamily: string | null | undefined): string | null {
  const raw = (uaFamily ?? '').trim();
  if (!raw || /^unknown$/i.test(raw)) return null;
  const parts = raw.split(/\s*\/\s*/);
  const os = (parts.length >= 2 ? parts[parts.length - 1] : raw).trim();
  if (!os || /^unknown$/i.test(os) || /^other$/i.test(os)) return null;
  return os;
}

/** 设备标题：系统 · 脱敏 IP（M34-4b） */
export function formatOwnerSessionDeviceTitle(
  s: Pick<OwnerSessionListItem, 'user_agent_family' | 'ip_masked'>,
  unknownLabel: string,
): string {
  const os = extractOsFamily(s.user_agent_family);
  const ip = (s.ip_masked ?? '').trim() || null;
  if (os && ip) return `${os} · ${ip}`;
  if (os) return os;
  if (ip) return ip;
  return unknownLabel;
}

type RevokeTarget = {
  readonly session_id: string;
  readonly is_current: boolean;
  readonly device_title: string;
};

export function SettingsOwnerSessionsSection(): VNode | null {
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);

  useEffect(() => {
    if (!loggedInHandle.value) return;
    void refreshOwnerSessions();
  }, [loggedInHandle.value]);

  if (!loggedInHandle.value) return null;

  const items = ownerSessions.value;
  const revoking =
    revokeTarget != null && ownerSessionRevokingId.value === revokeTarget.session_id;

  return (
    <section class={SETTINGS_SECTION_CLASS}>
      <SettingsSectionHeader
        sectionKey="ownerSessions"
        title={t('settingsOwnerSessionsTitle')}
        trailing={
          <button
            type="button"
            disabled={ownerSessionsLoading.value}
            onClick={() => {
              void refreshOwnerSessions();
            }}
            class={SETTINGS_PRIMARY_BTN_CLASS}
          >
            {ownerSessionsLoading.value
              ? t('settingsOwnerSessionsRefreshing')
              : t('settingsOwnerSessionsRefresh')}
          </button>
        }
      />
      <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
        {t('settingsOwnerSessionsDescription')}
      </p>

      {ownerSessionsLoading.value && items.length === 0 ? (
        <p class="mt-3 text-sm text-slate-600 dark:text-zinc-400">{t('settingsOwnerSessionsLoading')}</p>
      ) : null}

      {!ownerSessionsLoading.value && items.length === 0 ? (
        <p class="mt-3 text-sm text-slate-600 dark:text-zinc-400">{t('settingsOwnerSessionsEmpty')}</p>
      ) : null}

      {items.length > 0 ? (
        <ul class="mt-3 divide-y divide-slate-200 dark:divide-zinc-700">
          {items.map((s) => {
            const rowRevoking = ownerSessionRevokingId.value === s.session_id;
            const statusLabel = s.is_current
              ? t('settingsOwnerSessionsThisDevice')
              : s.is_active
                ? t('settingsOwnerSessionsActive')
                : s.ended_at
                  ? t('settingsOwnerSessionsEnded')
                  : t('settingsOwnerSessionsInactive');
            const deviceTitle = formatOwnerSessionDeviceTitle(
              s,
              t('settingsOwnerSessionsUnknownDevice'),
            );
            return (
              <li key={s.session_id} class="flex flex-wrap items-start justify-between gap-3 py-3">
                <div class="min-w-0 flex-1 text-sm">
                  <p class="font-medium text-slate-900 dark:text-zinc-100">
                    {deviceTitle}
                    {s.is_current ? (
                      <span class="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
                        {t('settingsOwnerSessionsThisDevice')}
                      </span>
                    ) : null}
                  </p>
                  <p class="mt-1 text-xs text-slate-600 dark:text-zinc-400">
                    {t('settingsOwnerSessionsMeta', undefined, {
                      country: s.ip_country || '—',
                      status: statusLabel,
                      seen: formatLogTime(s.last_seen_at),
                      created: formatLogTime(s.created_at),
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={rowRevoking}
                  onClick={() => {
                    setRevokeTarget({
                      session_id: s.session_id,
                      is_current: s.is_current,
                      device_title: deviceTitle,
                    });
                  }}
                  class="rounded-md border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:text-rose-200 dark:hover:bg-rose-950/40"
                >
                  {rowRevoking
                    ? t('settingsOwnerSessionsRevoking')
                    : s.is_current
                      ? t('settingsOwnerSessionsLogoutHere')
                      : t('settingsOwnerSessionsRevoke')}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ConfirmDialog
        open={revokeTarget != null}
        pending={revoking}
        title={
          revokeTarget?.is_current
            ? t('settingsOwnerSessionsConfirmSelfTitle')
            : t('settingsOwnerSessionsConfirmTitle')
        }
        body={
          revokeTarget ? (
            <>
              <p>
                {revokeTarget.is_current
                  ? t('settingsOwnerSessionsConfirmSelf')
                  : t('settingsOwnerSessionsConfirm')}
              </p>
              <p class="mt-2 break-all font-medium text-zinc-800 dark:text-zinc-100">
                {revokeTarget.device_title}
              </p>
            </>
          ) : null
        }
        cancelLabel={t('settingsOwnerSessionsDialogCancel')}
        confirmLabel={
          revokeTarget?.is_current
            ? t('settingsOwnerSessionsDialogConfirmSelf')
            : t('settingsOwnerSessionsDialogConfirm')
        }
        confirmPendingLabel={t('settingsOwnerSessionsRevoking')}
        icon={<LogOut size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!revoking) setRevokeTarget(null);
        }}
        onConfirm={() => {
          if (!revokeTarget) return;
          const sid = revokeTarget.session_id;
          void handleRevokeOwnerSession(sid).finally(() => {
            setRevokeTarget(null);
          });
        }}
      />
    </section>
  );
}
