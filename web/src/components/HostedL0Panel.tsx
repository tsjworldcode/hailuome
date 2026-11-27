/** @jsxImportSource preact */
/**
 * M9-8：托管 L0 隐私声明、知情同意与账号删除（Settings 懒加载模块）。
 */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { AlertTriangle } from 'lucide-preact';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import { HOSTED_L0_ACCOUNT_DELETE_CONFIRM_PHRASE } from '@hailuo/shared-utils';
import {
  createWorkerAClient,
  type HostedL0PrivacyDocument,
  type HostedL0Status,
} from '../lib/workerA';
import { logoutOwnerAndReload } from '../lib/ownerSession';
import { t } from '../lib/i18n';
import { SETTINGS_SECTION_CLASS } from '../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './settings/SettingsSectionHeader';

const status = signal<HostedL0Status | null>(null);
const privacyDoc = signal<HostedL0PrivacyDocument | null>(null);
const loading = signal(true);
const accepting = signal(false);
const deleting = signal(false);
const confirmDeleteOpen = signal(false);
const deletePhrase = signal('');
const exportAck = signal(false);
const panelStatus = signal<{ readonly type: 'idle' | 'success' | 'error'; readonly msg: string }>({
  type: 'idle',
  msg: '',
});

const mounted = signal(false);

function setPanelStatus(type: 'idle' | 'success' | 'error', msg: string): void {
  panelStatus.value = { type, msg };
}

function createClient() {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) throw new Error(t('composerMissingEndpoint'));
  return createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
}

async function refreshHostedL0(): Promise<void> {
  loading.value = true;
  try {
    const client = createClient();
    const [st, doc] = await Promise.all([
      client.getHostedL0Status(),
      client.getHostedL0Privacy(),
    ]);
    status.value = st;
    privacyDoc.value = doc;
  } catch (err) {
    setPanelStatus(
      'error',
      err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, t('hostedL0LoadFailed')),
    );
  } finally {
    loading.value = false;
  }
}

async function handleAcceptPrivacy(): Promise<void> {
  if (accepting.value || !status.value) return;
  accepting.value = true;
  setPanelStatus('idle', '');
  try {
    const client = createClient();
    await client.acceptHostedL0Privacy(status.value.privacy_version);
    await refreshHostedL0();
    setPanelStatus('success', t('hostedL0PrivacyAccepted'));
  } catch (err) {
    setPanelStatus(
      'error',
      err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, t('hostedL0PrivacyAcceptFailed')),
    );
  } finally {
    accepting.value = false;
  }
}

async function handleDeleteAccount(): Promise<void> {
  if (deleting.value) return;
  if (deletePhrase.value.trim() !== HOSTED_L0_ACCOUNT_DELETE_CONFIRM_PHRASE) {
    setPanelStatus('error', t('hostedL0DeletePhraseInvalid'));
    return;
  }
  if (!exportAck.value) {
    setPanelStatus('error', t('hostedL0DeleteExportAckRequired'));
    return;
  }

  deleting.value = true;
  setPanelStatus('idle', '');
  try {
    const client = createClient();
    await client.deleteOwnerAccount({
      confirmPhrase: deletePhrase.value.trim(),
      exportAcknowledged: true,
    });
    setPanelStatus('success', t('hostedL0DeleteSuccess'));
    confirmDeleteOpen.value = false;
    deletePhrase.value = '';
    exportAck.value = false;
    logoutOwnerAndReload();
  } catch (err) {
    setPanelStatus(
      'error',
      err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, t('hostedL0DeleteFailed')),
    );
  } finally {
    deleting.value = false;
  }
}

export function HostedL0Panel(): VNode {
  useEffect(() => {
    if (mounted.value) return;
    mounted.value = true;
    void refreshHostedL0();
  }, []);

  const st = status.value;
  const doc = privacyDoc.value;

  return (
    <section class={SETTINGS_SECTION_CLASS}>
      <SettingsSectionHeader sectionKey="hostedL0" title={t('hostedL0Title')} />
      <p class="mt-1 text-sm text-slate-600 dark:text-zinc-400">
        {loading.value ? t('hostedL0Loading') : st?.hosted_l0_enabled
          ? t('hostedL0DescHosted', undefined, { operator: st.operator_label })
          : t('hostedL0DescSelfHosted')}
      </p>

      {st?.hosted_l0_enabled && (
        <div
          class="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          role="status"
        >
          <div class="flex items-start gap-2">
            <AlertTriangle size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{t('hostedL0Banner')}</span>
          </div>
        </div>
      )}

      {panelStatus.value.type !== 'idle' && (
        <div
          class={
            'mt-3 rounded-md border px-3 py-2 text-sm ' +
            (panelStatus.value.type === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100'
              : 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100')
          }
          role="status"
        >
          {panelStatus.value.msg}
        </div>
      )}

      {st?.hosted_l0_enabled && doc && (
        <div class="mt-4 space-y-3">
          <h3 class="text-sm font-medium text-slate-800 dark:text-zinc-200">{t('hostedL0PrivacyTitle')}</h3>
          <ul class="space-y-2 text-sm text-slate-600 dark:text-zinc-400">
            {doc.sections.map((section) => (
              <li key={section.id}>
                <p class="font-medium text-slate-800 dark:text-zinc-200">{section.title}</p>
                <p class="mt-0.5">{section.body}</p>
              </li>
            ))}
          </ul>
          {st.requires_privacy_acceptance ? (
            <button
              type="button"
              onClick={() => void handleAcceptPrivacy()}
              disabled={accepting.value}
              class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {accepting.value ? t('hostedL0Accepting') : t('hostedL0AcceptPrivacy')}
            </button>
          ) : (
            <p class="text-xs text-emerald-700 dark:text-emerald-300">
              {t('hostedL0PrivacyAlreadyAccepted', undefined, {
                time: st.privacy_accepted_at ?? '',
              })}
            </p>
          )}
        </div>
      )}

      <div class="mt-5 border-t border-slate-200 pt-4 dark:border-zinc-800">
        <h3 class="text-sm font-medium text-rose-800 dark:text-rose-300">{t('hostedL0DeleteTitle')}</h3>
        <p class="mt-1 text-xs text-slate-600 dark:text-zinc-400">{t('hostedL0DeleteDesc')}</p>

        {confirmDeleteOpen.value ? (
          <div class="mt-3 space-y-2 rounded-md border border-rose-300 bg-rose-50 p-3 dark:border-rose-800 dark:bg-rose-950">
            <label class="flex items-start gap-2 text-xs text-rose-900 dark:text-rose-100">
              <input
                type="checkbox"
                checked={exportAck.value}
                onChange={(e) => {
                  exportAck.value = (e.currentTarget as HTMLInputElement).checked;
                }}
              />
              <span>{t('hostedL0DeleteExportAck')}</span>
            </label>
            <input
              type="text"
              value={deletePhrase.value}
              onInput={(e) => {
                deletePhrase.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder={t('hostedL0DeletePhrasePlaceholder')}
              class="w-full rounded-md border border-rose-300 bg-white px-2 py-1.5 text-sm dark:border-rose-700 dark:bg-zinc-900"
            />
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleDeleteAccount()}
                disabled={deleting.value}
                class="rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting.value ? t('hostedL0Deleting') : t('hostedL0DeleteConfirm')}
              </button>
              <button
                type="button"
                onClick={() => {
                  confirmDeleteOpen.value = false;
                  deletePhrase.value = '';
                  exportAck.value = false;
                }}
                disabled={deleting.value}
                class="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-800 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-200"
              >
                {t('hostedL0Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              confirmDeleteOpen.value = true;
            }}
            class="mt-3 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-300"
          >
            {t('hostedL0DeleteStart')}
          </button>
        )}
      </div>
    </section>
  );
}
