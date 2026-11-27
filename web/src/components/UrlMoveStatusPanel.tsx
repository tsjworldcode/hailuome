/**
 * M7-30f-5：Settings 换域宽限期状态 / 联系人推送进度 / 旧址关闭 checklist
 */
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl, resolveWorkerAUrl } from '../lib/auth';
import {
  createWorkerAClient,
  type UrlChangeStatusResult,
} from '../lib/workerA';
import { ApiError, getErrorMessage } from '../lib/errors';
import { initLanguage, t } from '../lib/i18n';
import { showToast } from '../lib/toast';

const status = signal<UrlChangeStatusResult | null>(null);
const loading = signal(false);
const errorMsg = signal<string | null>(null);
const copied = signal(false);

export interface UrlMoveStatusPanelProps {
  /** 外部触发刷新（如换域成功后） */
  refreshToken?: number;
}

function buildAnnouncement(data: UrlChangeStatusResult): string {
  const oldUrl = data.old_node_url ?? '';
  const newUrl = data.new_node_url ?? '';
  const grace = data.grace_until
    ? new Date(data.grace_until).toLocaleString()
    : '';
  return t('urlMoveAnnounceTemplate', undefined, {
    old: oldUrl,
    new: newUrl,
    grace,
  });
}

async function loadStatus(probeOld: boolean): Promise<void> {
  errorMsg.value = null;
  const url = (await resolveWorkerAUrl()) || getWorkerAUrl();
  if (!url || !getOwnerJwt()) {
    status.value = null;
    return;
  }
  loading.value = true;
  try {
    const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
    status.value = await client.getUrlChangeStatus({ probeOld });
  } catch (err) {
    errorMsg.value =
      err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, t('urlMoveStatusLoadFailed'));
    status.value = null;
  } finally {
    loading.value = false;
  }
}

export function UrlMoveStatusPanel({ refreshToken = 0 }: UrlMoveStatusPanelProps): VNode | null {
  useEffect(() => {
    initLanguage();
  }, []);

  useEffect(() => {
    void loadStatus(true);
  }, [refreshToken]);

  if (loading.value && !status.value) {
    return (
      <p class="mt-4 text-xs text-slate-500 dark:text-zinc-500">{t('urlMoveStatusLoading')}</p>
    );
  }

  if (errorMsg.value && !status.value) {
    return (
      <p class="mt-4 text-sm text-rose-600 dark:text-rose-400" role="alert">
        {errorMsg.value}
      </p>
    );
  }

  const data = status.value;
  if (!data?.active) {
    return (
      <p class="mt-4 text-xs leading-5 text-slate-500 dark:text-zinc-500">
        {t('urlMoveStatusIdle')}
      </p>
    );
  }

  const announce = buildAnnouncement(data);
  const graceLabel = data.grace_until
    ? new Date(data.grace_until).toLocaleString()
    : '—';
  const changedLabel = data.changed_at
    ? new Date(data.changed_at).toLocaleString()
    : '—';

  return (
    <div class="mt-4 space-y-4" id="url-move-status">
      <div
        class={
          data.grace_active
            ? 'rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
            : 'rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100'
        }
      >
        <p class="font-medium">
          {data.grace_active
            ? t('urlMoveGraceActiveTitle')
            : t('urlMoveGraceEndedTitle')}
        </p>
        <dl class="mt-2 space-y-1 text-xs leading-5">
          <div class="break-all">
            <dt class="inline font-medium">{t('urlMoveOldUrlLabel')} </dt>
            <dd class="inline font-mono">{data.old_node_url}</dd>
          </div>
          <div class="break-all">
            <dt class="inline font-medium">{t('urlMoveNewUrlLabel')} </dt>
            <dd class="inline font-mono">{data.new_node_url}</dd>
          </div>
          <div>
            <dt class="inline font-medium">{t('urlMoveChangedAtLabel')} </dt>
            <dd class="inline">{changedLabel}</dd>
          </div>
          <div>
            <dt class="inline font-medium">{t('urlMoveGraceUntilLabel')} </dt>
            <dd class="inline">
              {graceLabel}
              {data.days_remaining !== null && data.grace_active
                ? ` （${t('urlMoveDaysRemaining', undefined, { days: String(data.days_remaining) })}）`
                : ''}
            </dd>
          </div>
          <div>
            <dt class="inline font-medium">{t('urlMoveOldReachableLabel')} </dt>
            <dd class="inline">
              {data.old_route_reachable === null
                ? t('urlMoveOldReachableUnknown')
                : data.old_route_reachable
                  ? t('urlMoveOldReachableYes')
                  : t('urlMoveOldReachableNo')}
            </dd>
          </div>
        </dl>
        <button
          type="button"
          class="mt-2 text-xs font-medium underline opacity-90 hover:opacity-100"
          disabled={loading.value}
          onClick={() => void loadStatus(true)}
        >
          {loading.value ? t('urlMoveStatusRefreshing') : t('urlMoveStatusRefresh')}
        </button>
      </div>

      <div class="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-950">
        <p class="font-medium text-slate-800 dark:text-zinc-200">{t('urlMoveNotifyTitle')}</p>
        <p class="mt-1 text-xs text-slate-600 dark:text-zinc-400">{t('urlMoveNotifyHint')}</p>
        <ul class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-700 dark:text-zinc-300 sm:grid-cols-3">
          <li>{t('urlMoveNotifyTotal', undefined, { n: String(data.notify.total) })}</li>
          <li>{t('urlMoveNotifySent', undefined, { n: String(data.notify.sent) })}</li>
          <li>{t('urlMoveNotifyPending', undefined, { n: String(data.notify.pending) })}</li>
          <li>{t('urlMoveNotifyFailed', undefined, { n: String(data.notify.failed) })}</li>
          <li>{t('urlMoveNotifyDead', undefined, { n: String(data.notify.dead) })}</li>
          <li>{t('urlMoveNotifySkipped', undefined, { n: String(data.notify.skipped) })}</li>
        </ul>
      </div>

      {(data.notify.dead > 0 || data.notify.failed > 0 || data.notify.total === 0) && (
        <div class="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <p class="font-medium text-slate-800 dark:text-zinc-200">{t('urlMoveAnnounceTitle')}</p>
          <p class="mt-1 text-xs text-slate-600 dark:text-zinc-400">{t('urlMoveAnnounceHint')}</p>
          <textarea
            readOnly
            rows={3}
            class="mt-2 w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs leading-5 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
            value={announce}
          />
          <button
            type="button"
            class="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(announce);
                copied.value = true;
                showToast(t('urlMoveAnnounceCopied'), 'info');
                setTimeout(() => {
                  copied.value = false;
                }, 2000);
              } catch {
                showToast(t('urlMoveAnnounceCopyFailed'), 'error');
              }
            }}
          >
            {copied.value ? t('urlMoveAnnounceCopied') : t('urlMoveAnnounceCopy')}
          </button>
        </div>
      )}

      <div
        class={
          data.checklist.keep_old_route_required
            ? 'rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-950 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100'
            : 'rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100'
        }
      >
        <p class="font-medium">{t('urlMoveChecklistTitle')}</p>
        <ul class="mt-2 list-inside list-disc space-y-1 text-xs leading-5">
          <li>
            {data.checklist.keep_old_route_required
              ? t('urlMoveChecklistKeepOldUrgent')
              : t('urlMoveChecklistKeepOldDone')}
          </li>
          <li>
            {data.checklist.may_close_old_route
              ? t('urlMoveChecklistMayClose')
              : t('urlMoveChecklistDoNotCloseYet')}
          </li>
          <li>{t('urlMoveChecklistFansAuto')}</li>
          <li>{t('urlMoveChecklistTokenDm')}</li>
        </ul>
      </div>
    </div>
  );
}
