/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { createWorkerAClient, type UrlChangePrecheckResult } from '../lib/workerA';
import { getOwnerJwt, resolveWorkerAUrl } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import { buildCurrentPasswordHash } from '../lib/ownerPassword';
import { loadPublicRegistryEndpoints, publicRegistryEndpoints } from '../lib/registryEndpoints';
import { loadOwnerProfile } from '../lib/ownerProfile';
import { showToast } from '../lib/toast';
import { initLanguage, t } from '../lib/i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { Megaphone } from 'lucide-preact';

type WizardStep = 'input' | 'confirm' | 'success';

const step = signal<WizardStep>('input');
const newUrlInput = signal('');
const pendingPrecheck = signal<UrlChangePrecheckResult | null>(null);
const successResult = signal<{
  node_url: string;
  changed_at: string;
  old_node_url: string;
} | null>(null);
const errorMsg = signal<string | null>(null);
const busy = signal(false);
const expiresInSec = signal(0);
/** M7-30f-1：confirm 页 step-up */
const stepUpPassword = signal('');
const stepUpTotp = signal('');
const totpEnabled = signal(false);
/** M7-30b-ux2：成功页一键发公告帖 */
const announceDraft = signal('');
const announceBusy = signal(false);
const announcePosted = signal(false);
const announceSkipped = signal(false);
const announceError = signal<string | null>(null);
const announceConfirmOpen = signal(false);

function normalizeHttpsUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface UrlChangeWizardProps {
  /** 当前登记/公开节点地址（只读对照） */
  currentNodeUrl: string;
  /** 换域成功后刷新 Settings 表单 */
  onUrlChanged?: () => void | Promise<void>;
}

/** M7-30b：Settings 换域向导（precheck → proof 说明 → confirm + 服务端签名） */
export function UrlChangeWizard({ currentNodeUrl, onUrlChanged }: UrlChangeWizardProps): VNode {
  useEffect(() => {
    initLanguage();
  }, []);

  useEffect(() => {
    if (expiresInSec.value <= 0) return;
    const timer = setInterval(() => {
      expiresInSec.value = Math.max(0, expiresInSec.value - 1);
      if (expiresInSec.value === 0 && step.value === 'confirm') {
        errorMsg.value = t('urlChangePrecheckExpired');
        step.value = 'input';
        pendingPrecheck.value = null;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresInSec.value, step.value]);

  const staleBackupEndpoints =
    publicRegistryEndpoints.value?.filter((e) => e.url_sync_state === 'stale') ?? [];

  function resetWizard(): void {
    step.value = 'input';
    newUrlInput.value = '';
    pendingPrecheck.value = null;
    successResult.value = null;
    errorMsg.value = null;
    expiresInSec.value = 0;
    stepUpPassword.value = '';
    stepUpTotp.value = '';
    totpEnabled.value = false;
    announceDraft.value = '';
    announceBusy.value = false;
    announcePosted.value = false;
    announceSkipped.value = false;
    announceError.value = null;
    announceConfirmOpen.value = false;
  }

  function buildDefaultAnnounce(oldUrl: string, newUrl: string, graceLabel: string): string {
    return t('urlMoveAnnounceTemplate', undefined, {
      old: oldUrl || '—',
      new: newUrl || '—',
      grace: graceLabel || '—',
    });
  }

  async function handlePrecheck(e: Event): Promise<void> {
    e.preventDefault();
    errorMsg.value = null;
    const normalized = normalizeHttpsUrl(newUrlInput.value);
    if (!normalized) {
      errorMsg.value = t('urlChangeInvalidHttps');
      return;
    }
    const currentNorm = normalizeHttpsUrl(currentNodeUrl);
    if (currentNorm && normalized === currentNorm) {
      errorMsg.value = t('urlChangeSameUrl');
      return;
    }

    const url = await resolveWorkerAUrl();
    if (!url || !getOwnerJwt()) {
      errorMsg.value = t('urlChangeLoginRequired');
      return;
    }

    busy.value = true;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const [data, totpStatus] = await Promise.all([
        client.precheckUrlChange({
          newNodeUrl: normalized,
          newWorkerBUrl: normalized,
        }),
        client.getTotpStatus().catch(() => null),
      ]);
      pendingPrecheck.value = data;
      totpEnabled.value = totpStatus?.enabled === true;
      stepUpPassword.value = '';
      stepUpTotp.value = '';
      step.value = 'confirm';
      const expiresMs = Date.parse(data.expires_at) - Date.now();
      expiresInSec.value = Math.max(0, Math.floor(expiresMs / 1000));
      showToast(t('urlChangePrecheckPassToast'), 'info');
    } catch (err) {
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('urlChangePrecheckFailed'));
    } finally {
      busy.value = false;
    }
  }

  async function handleConfirm(): Promise<void> {
    const pending = pendingPrecheck.value;
    if (!pending) return;
    errorMsg.value = null;

    const plainPassword = stepUpPassword.value;
    if (!plainPassword.trim()) {
      errorMsg.value = t('urlChangeStepUpPasswordRequired');
      return;
    }
    if (totpEnabled.value && !stepUpTotp.value.trim()) {
      errorMsg.value = t('urlChangeStepUpTotpRequired');
      return;
    }

    const url = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (!url || !jwt) {
      errorMsg.value = t('urlChangeLoginRequired');
      return;
    }

    busy.value = true;
    try {
      const passwordHash = await buildCurrentPasswordHash(url, jwt, plainPassword);
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const data = await client.confirmUrlChange({
        urlChangeId: pending.url_change_id,
        nonce: pending.nonce,
        passwordHash,
        totpCode: totpEnabled.value ? stepUpTotp.value.trim() : undefined,
      });
      const oldUrl = normalizeHttpsUrl(currentNodeUrl) ?? currentNodeUrl.trim();
      // 宽限默认约 14 天；成功后也可用状态面板取精确截止时间
      const graceApprox = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleString();
      successResult.value = {
        node_url: data.node_url,
        changed_at: data.changed_at,
        old_node_url: oldUrl,
      };
      announceDraft.value = buildDefaultAnnounce(oldUrl, data.node_url, graceApprox);
      announcePosted.value = false;
      announceSkipped.value = false;
      announceError.value = null;
      announceConfirmOpen.value = true;
      step.value = 'success';
      stepUpPassword.value = '';
      stepUpTotp.value = '';
      showToast(t('urlChangeSuccessToast'), 'info');
      // 尽量用服务端宽限期覆盖预填文案
      void client.getUrlChangeStatus({ probeOld: false }).then((st) => {
        if (!st.active || !successResult.value) return;
        const grace = st.grace_until
          ? new Date(st.grace_until).toLocaleString()
          : graceApprox;
        const old = st.old_node_url || successResult.value.old_node_url;
        const neu = st.new_node_url || successResult.value.node_url;
        if (!announcePosted.value && !announceSkipped.value) {
          announceDraft.value = buildDefaultAnnounce(old, neu, grace);
        }
      }).catch(() => { /* 预填失败不影响成功页 */ });
      await Promise.all([
        loadPublicRegistryEndpoints(),
        loadOwnerProfile(true),
        onUrlChanged?.(),
      ]);
    } catch (err) {
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('urlChangeConfirmFailed'));
    } finally {
      busy.value = false;
    }
  }

  async function handleAnnouncePost(): Promise<void> {
    const content = announceDraft.value.trim();
    if (!content) {
      announceError.value = t('urlChangeAnnounceEmpty');
      return;
    }
    const url = await resolveWorkerAUrl();
    if (!url || !getOwnerJwt()) {
      announceError.value = t('urlChangeLoginRequired');
      return;
    }
    announceBusy.value = true;
    announceError.value = null;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      await client.createPost({ content, images: [] });
      announcePosted.value = true;
      announceConfirmOpen.value = false;
      showToast(t('urlChangeAnnouncePostedToast'), 'info');
    } catch (err) {
      announceError.value =
        err instanceof ApiError
          ? err.displayMessage
          : getErrorMessage({}, t('urlChangeAnnouncePostFailed'));
    } finally {
      announceBusy.value = false;
    }
  }

  if (step.value === 'success' && successResult.value) {
    const stale =
      publicRegistryEndpoints.value?.filter((e) => e.url_sync_state === 'stale') ?? staleBackupEndpoints;
    return (
      <div class="mt-4 space-y-4">
        <div class="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
          <p class="font-medium">{t('urlChangeSuccessTitle')}</p>
          <p class="mt-1 break-all">
            {t('urlChangeSuccessNewUrl', undefined, { url: successResult.value.node_url })}
          </p>
          <p class="mt-1 text-xs opacity-80">
            {t('urlChangeSuccessTime', undefined, {
              time: new Date(successResult.value.changed_at).toLocaleString(),
            })}
          </p>
        </div>

        {/* 一键发换域公告帖：预填文案，需站主确认，不静默发帖 */}
        {!announceSkipped.value && (
          <div class="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100">
            <p class="font-medium">{t('urlChangeAnnounceTitle')}</p>
            <p class="mt-1 text-xs leading-5 opacity-90">{t('urlChangeAnnounceHint')}</p>
            {announcePosted.value ? (
              <p class="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {t('urlChangeAnnouncePosted')}
              </p>
            ) : (
              <>
                <label class="mt-3 mb-1 block text-xs font-medium" for="url-change-announce-draft">
                  {t('urlChangeAnnounceDraftLabel')}
                </label>
                <textarea
                  id="url-change-announce-draft"
                  rows={4}
                  value={announceDraft.value}
                  onInput={(e) => {
                    announceDraft.value = (e.currentTarget as HTMLTextAreaElement).value;
                  }}
                  class="w-full rounded-md border border-sky-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-sky-500/40 dark:bg-zinc-950 dark:text-zinc-50"
                />
                {announceError.value && (
                  <p class="mt-2 text-sm text-rose-600 dark:text-rose-400" role="alert">
                    {announceError.value}
                  </p>
                )}
                <div class="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={announceBusy.value}
                    class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-sky-400"
                    onClick={() => {
                      announceError.value = null;
                      announceConfirmOpen.value = true;
                    }}
                  >
                    {t('urlChangeAnnounceOpenConfirm')}
                  </button>
                  <button
                    type="button"
                    disabled={announceBusy.value}
                    class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    onClick={() => {
                      announceSkipped.value = true;
                      announceConfirmOpen.value = false;
                    }}
                  >
                    {t('urlChangeAnnounceSkip')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <ConfirmDialog
          open={announceConfirmOpen.value && !announcePosted.value}
          pending={announceBusy.value}
          title={t('urlChangeAnnounceConfirmTitle')}
          icon={<Megaphone size={22} aria-hidden="true" />}
          body={
            <div class="space-y-2 text-sm leading-5 text-fg2">
              <p>{t('urlChangeAnnounceConfirmBody')}</p>
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                {announceDraft.value.trim() || t('urlChangeAnnounceEmpty')}
              </pre>
            </div>
          }
          confirmLabel={t('urlChangeAnnounceConfirm')}
          confirmPendingLabel={t('urlChangeAnnouncePosting')}
          cancelLabel={t('urlChangeAnnounceCancel')}
          onCancel={() => {
            if (!announceBusy.value) announceConfirmOpen.value = false;
          }}
          onConfirm={() => {
            void handleAnnouncePost();
          }}
        />

        {stale.length > 0 && (
          <div class="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <p class="font-medium">{t('urlChangeStaleRegistryTitle')}</p>
            <p class="mt-1 text-xs leading-5">{t('urlChangeStaleRegistryBody')}</p>
            <ul class="mt-2 list-inside list-disc text-xs">
              {stale.map((e) => (
                <li key={e.registry_id}>
                  <span class="font-mono">{e.registry_id}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div class="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <p class="font-medium">{t('urlChangeGraceKeepOldTitle')}</p>
          <p class="mt-1 text-xs leading-5">{t('urlChangeGraceKeepOldBody')}</p>
        </div>
        <div class="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
          <p class="font-medium text-slate-800 dark:text-zinc-200">{t('urlChangeNotMigratedTitle')}</p>
          <ul class="mt-1 list-inside list-disc space-y-0.5">
            <li>{t('urlChangeNotMigratedFollowCache')}</li>
            <li>{t('urlChangeNotMigratedTokenDm')}</li>
            <li>{t('urlChangeNotMigratedWorkerB')}</li>
          </ul>
        </div>
        <button
          type="button"
          class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          onClick={resetWizard}
        >
          {t('urlChangeClose')}
        </button>
      </div>
    );
  }

  if (step.value === 'confirm' && pendingPrecheck.value) {
    const pending = pendingPrecheck.value;
    const proofUrl = `${pending.new_node_url.replace(/\/+$/, '')}/.well-known/hailuo-registry-proof`;
    const expectedProof = `${pending.url_change_id}.${pending.nonce}`;
    return (
      <div class="mt-4 space-y-4">
        <div class="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100">
          <p class="font-medium">{t('urlChangePrecheckPassedTitle')}</p>
          <p class="mt-1 break-all">{t('urlChangeTargetUrl', undefined, { url: pending.new_node_url })}</p>
          <p class="mt-1 text-xs">
            {t('urlChangeRemainingTime', undefined, {
              time: expiresInSec.value > 0 ? formatCountdown(expiresInSec.value) : t('urlChangeExpired'),
            })}
          </p>
        </div>

        <ol class="list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-700 dark:text-zinc-300">
          <li>{t('urlChangeStep1')}</li>
          <li>
            {t('urlChangeStep2Prefix')}
            <code class="mx-1 rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-zinc-800">{expectedProof}</code>
            {t('urlChangeStep2Separator')}
            <a
              href={proofUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="ml-1 break-all text-sky-600 hover:underline dark:text-sky-400"
            >
              {proofUrl}
            </a>
          </li>
          <li>{t('urlChangeStep3')}</li>
          <li>{t('urlChangeStep4StepUp')}</li>
        </ol>

        <div class="space-y-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-950">
          <p class="text-sm font-medium text-slate-800 dark:text-zinc-200">{t('urlChangeStepUpTitle')}</p>
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-zinc-400" for="url-change-step-up-password">
              {t('urlChangeStepUpPasswordLabel')}
            </label>
            <input
              id="url-change-step-up-password"
              type="password"
              autoComplete="current-password"
              value={stepUpPassword.value}
              onInput={(e) => { stepUpPassword.value = (e.currentTarget as HTMLInputElement).value; }}
              class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>
          {totpEnabled.value && (
            <div>
              <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-zinc-400" for="url-change-step-up-totp">
                {t('urlChangeStepUpTotpLabel')}
              </label>
              <input
                id="url-change-step-up-totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t('totpCodePlaceholder')}
                value={stepUpTotp.value}
                onInput={(e) => { stepUpTotp.value = (e.currentTarget as HTMLInputElement).value; }}
                class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              />
            </div>
          )}
        </div>

        {errorMsg.value && (
          <p class="text-sm text-rose-600 dark:text-rose-400" role="alert">
            {errorMsg.value}
          </p>
        )}

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy.value || expiresInSec.value <= 0}
            class="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-sky-400"
            onClick={() => void handleConfirm()}
          >
            {busy.value ? t('urlChangeConfirming') : t('urlChangeConfirm')}
          </button>
          <button
            type="button"
            disabled={busy.value}
            class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={() => {
              step.value = 'input';
              pendingPrecheck.value = null;
              errorMsg.value = null;
              stepUpPassword.value = '';
              stepUpTotp.value = '';
            }}
          >
            {t('urlChangeBackEdit')}
          </button>
        </div>
      </div>
    );
  }

  const currentDisplay = currentNodeUrl.trim();

  return (
    <form class="mt-4 space-y-4" onSubmit={(e) => void handlePrecheck(e)}>
      {/* 首屏风险提示：换域低频且影响粉丝发现，须在预检前读完 */}
      <div
        class="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
        role="note"
        aria-labelledby="url-change-risk-heading"
      >
        <p id="url-change-risk-heading" class="font-medium">
          {t('urlChangeRiskTitle')}
        </p>
        <ul class="mt-2 list-inside list-disc space-y-1.5 text-xs leading-5">
          <li class="font-medium">{t('urlChangeRiskGraceRequired')}</li>
          <li>{t('urlChangeRiskScope')}</li>
          <li>{t('urlChangeRiskNetwork')}</li>
          <li>{t('urlChangeRiskNotifyTargets')}</li>
          <li>{t('urlChangeRiskFollows')}</li>
          <li>{t('urlChangeRiskGroups')}</li>
          <li>{t('urlChangeRiskTokens')}</li>
          <li>{t('urlChangeRiskBackup')}</li>
        </ul>
      </div>

      <div class="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-950">
        <p class="text-xs font-medium text-slate-600 dark:text-zinc-400">{t('urlChangeCurrentUrlLabel')}</p>
        {currentDisplay ? (
          <p class="mt-1 break-all font-mono text-sm text-slate-900 dark:text-zinc-100">{currentDisplay}</p>
        ) : (
          <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-zinc-500">{t('urlChangeCurrentUrlEmpty')}</p>
        )}
      </div>

      <div>
        <label class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300" for="url-change-new">
          {t('urlChangeNewUrlLabel')}
        </label>
        <input
          id="url-change-new"
          type="url"
          inputMode="url"
          placeholder="https://your-new-domain.example.com"
          value={newUrlInput.value}
          onInput={(e) => { newUrlInput.value = (e.currentTarget as HTMLInputElement).value; }}
          class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
        <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">{t('urlChangePhase1Hint')}</p>
      </div>

      {errorMsg.value && (
        <p class="text-sm text-rose-600 dark:text-rose-400" role="alert">
          {errorMsg.value}
        </p>
      )}

      <button
        type="submit"
        disabled={busy.value}
        class="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-sky-400"
      >
        {busy.value ? t('urlChangePrechecking') : t('urlChangeStartPrecheck')}
      </button>
    </form>
  );
}
