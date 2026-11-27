/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { createWorkerAClient } from '../lib/workerA';
import type { CertInboundAddressResult, CertificationContext } from '../lib/workerA';
import { getOwnerJwt, resolveWorkerAUrl } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import { initLanguage, t } from '../lib/i18n';
import { loadOwnerProfile, ownerProfile, patchOwnerProfile } from '../lib/ownerProfile';
import { showToast } from '../lib/toast';
import { CertPurgeReminderBanner } from './CertPurgeReminderBanner';
import type { CertPurgeStatus } from '../lib/workerA';

type CertChannel = 'inbound' | 'esp';

const registrationEmail = signal<string | null>(null);
const certContext = signal<CertificationContext | null>(null);
const certPurgeStatus = signal<CertPurgeStatus | null>(null);
const activeChannel = signal<CertChannel>('inbound');
const profileLoading = signal(false);
const inboundAddress = signal<CertInboundAddressResult | null>(null);
const inboundIssuing = signal(false);
const codeInput = signal('');
const codeConfirmed = signal(false);
const emailVerifyToken = signal('');
const sendCooldown = signal(0);
const errorMsg = signal<string | null>(null);
const submitting = signal(false);
const certified = signal(false);

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('registryCertifyCopied'), 'info');
  } catch {
    showToast(t('registryCertifyCopyFailed'), 'error');
  }
}

/** 节点邮箱认证：通道 A 主动发信 + 通道 B ESP 验码 */
export function RegistryCertify(): VNode {
  useEffect(() => {
    initLanguage();
    void loadOwnerProfile(true);
  }, []);

  useEffect(() => {
    if (sendCooldown.value <= 0) return;
    const timer = setInterval(() => {
      sendCooldown.value = Math.max(0, sendCooldown.value - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [sendCooldown.value]);

  useEffect(() => {
    const profile = ownerProfile.value;
    if (!profile?.registered) return;
    certified.value = profile.email_verified === true;
    void loadCertifyPageData();
  }, [ownerProfile.value?.registered, ownerProfile.value?.email_verified]);

  useEffect(() => {
    if (certified.value || !inboundAddress.value) return;
    const timer = setInterval(() => {
      void refreshVerificationStatus();
    }, 20_000);
    return () => clearInterval(timer);
  }, [certified.value, inboundAddress.value?.cert_inbound_address]);

  async function loadCertifyPageData(): Promise<void> {
    const url = await resolveWorkerAUrl();
    if (!url || !getOwnerJwt()) return;
    profileLoading.value = true;
    errorMsg.value = null;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const [profile, context, purge] = await Promise.all([
        client.getRegistrationProfile(),
        client.getCertificationContext(),
        client.getCertPurgeStatus().catch(() => null),
      ]);
      registrationEmail.value = profile.email?.trim() || null;
      certContext.value = context;
      certPurgeStatus.value = purge;
      // 注册中心已认证时同步本地蓝标态，避免仍显示「未认证」+「币不足」误导
      if (context.email_verified === true || context.email_status === 'verified') {
        patchOwnerProfile({ email_verified: true });
        certified.value = true;
        inboundAddress.value = null;
      } else if (context.channel_a_enabled) {
        activeChannel.value = 'inbound';
      } else if (context.channel_b_enabled) {
        activeChannel.value = 'esp';
      }
    } catch (err) {
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('registryCertifyLoadEmailFailed'));
    } finally {
      profileLoading.value = false;
    }
  }

  async function refreshVerificationStatus(): Promise<void> {
    const url = await resolveWorkerAUrl();
    if (!url || !getOwnerJwt()) return;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const ctx = await client.getCertificationContext();
      if (ctx.email_verified === true || ctx.email_status === 'verified') {
        patchOwnerProfile({ email_verified: true });
        certified.value = true;
        inboundAddress.value = null;
        showToast(t('registryCertifySuccess'), 'info');
        return;
      }
    } catch {
      // 回落 getMe
    }
    await loadOwnerProfile(true);
    if (ownerProfile.value?.email_verified === true) {
      certified.value = true;
      inboundAddress.value = null;
      showToast(t('registryCertifySuccess'), 'info');
    }
  }

  const profile = ownerProfile.value;
  const email = registrationEmail.value;
  const hasEmail = Boolean(email);
  const ctx = certContext.value;
  const showInbound = ctx?.channel_a_enabled !== false;
  const showEsp = ctx?.channel_b_enabled !== false;
  const espAffordable =
    ctx === null || ctx.hailuo_coins >= ctx.esp_verify_coin_cost;

  async function handleIssueInboundAddress(): Promise<void> {
    errorMsg.value = null;
    const url = await resolveWorkerAUrl();
    if (!url || !getOwnerJwt()) {
      errorMsg.value = t('registryCertifyLoginRequired');
      return;
    }
    inboundIssuing.value = true;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      inboundAddress.value = await client.issueCertInboundAddress();
      showToast(t('registryCertifyInboundIssued'), 'info');
    } catch (err) {
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('registryCertifyInboundIssueFailed'));
    } finally {
      inboundIssuing.value = false;
    }
  }

  async function handleSendCode(): Promise<void> {
    errorMsg.value = null;
    codeConfirmed.value = false;
    emailVerifyToken.value = '';
    if (!email) {
      errorMsg.value = t('registryCertifySaveEmailFirst');
      return;
    }
    const url = await resolveWorkerAUrl();
    if (!url || !getOwnerJwt()) {
      errorMsg.value = t('registryCertifyLoginRequired');
      return;
    }
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const result = await client.requestEspVerify({ request_id: crypto.randomUUID() });
      if (certContext.value) {
        certContext.value = { ...certContext.value, hailuo_coins: result.hailuo_coins };
      }
      const cooldownSec = Math.min(60, Math.max(1, Math.floor(result.expires_in || 60)));
      sendCooldown.value = result.already_sent ? Math.min(cooldownSec, 60) : 60;
      showToast(
        result.already_sent ? t('registryCertifyCodeAlreadySent') : t('registryCertifyCodeSent'),
        'info',
      );
    } catch (err) {
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('registryCertifySendFailed'));
    }
  }

  async function handleConfirmCode(): Promise<void> {
    errorMsg.value = null;
    if (!email) return;
    const code = codeInput.value.trim();
    if (!code) {
      errorMsg.value = t('registryCertifyCodeRequired');
      return;
    }
    const url = await resolveWorkerAUrl();
    if (!url) return;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const result = await client.confirmEmailVerify(email, code);
      emailVerifyToken.value = result.emailVerifyToken;
      codeConfirmed.value = true;
      showToast(t('registryCertifyCodeConfirmed'), 'info');
    } catch (err) {
      codeConfirmed.value = false;
      emailVerifyToken.value = '';
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('registryCertifyConfirmFailed'));
    }
  }

  async function handleCertify(e: Event): Promise<void> {
    e.preventDefault();
    errorMsg.value = null;
    if (!email) {
      errorMsg.value = t('registryCertifySaveEmailFirst');
      return;
    }
    if (!codeConfirmed.value || !emailVerifyToken.value) {
      errorMsg.value = t('registryCertifyCompleteCodeFirst');
      return;
    }
    const url = await resolveWorkerAUrl();
    if (!url) return;
    submitting.value = true;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      await client.certifyEmail({ email, emailVerifyToken: emailVerifyToken.value });
      certified.value = true;
      patchOwnerProfile({ email_verified: true });
      showToast(t('registryCertifySuccess'), 'info');
      codeInput.value = '';
      codeConfirmed.value = false;
      emailVerifyToken.value = '';
    } catch (err) {
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('registryCertifyFailed'));
    } finally {
      submitting.value = false;
    }
  }

  // UX-CHAT-ALIGN-1：与侧栏左贴齐（main 已是 max-w-none），与首页 PostCard 同款 px-4 sm:px-6。
  // （注释须在 return 外：return ( 后直接 {/* */} 会触发 TS 解析假错，见 09）
  if (!profile?.registered) {
    return (
      <section class="w-full max-w-lg px-4 py-8 sm:px-6">
        <div class="rounded-2xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-500/30 dark:bg-amber-500/10">
          <h1 class="text-xl font-bold text-amber-900 dark:text-amber-100">{t('registryCertifyNeedRegisterTitle')}</h1>
          <p class="mt-2 text-sm text-amber-800 dark:text-amber-200">{t('registryCertifyNeedRegisterBody')}</p>
          <a
            href="/register"
            class="mt-4 inline-block rounded-full bg-amber-600 px-6 py-2 text-sm font-bold text-white hover:bg-amber-700"
          >
            {t('registryCertifyGoRegister')}
          </a>
        </div>
      </section>
    );
  }

  return (
    <section class="w-full max-w-lg px-4 py-8 sm:px-6">
      <header class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{t('registryCertifyTitle')}</h1>
        <p class="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          {t('registryCertifyDescription')}
          <a href="/settings" class="font-semibold text-sky-600 hover:underline dark:text-sky-400">
            {t('registryCertifySettingsLink')}
          </a>
          {t('registryCertifyDescriptionSuffix')}
        </p>
      </header>

      {!certified.value && certPurgeStatus.value && (
        <CertPurgeReminderBanner status={certPurgeStatus.value} showCertifyLink={false} />
      )}

      {certified.value && (
        <div class="mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          {t('registryCertifyAlreadyDone')}
        </div>
      )}

      {!certified.value && showInbound && showEsp && (
        <div class="mb-4 flex gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            type="button"
            class={`flex-1 rounded-xl px-3 py-2 text-sm font-semibold transition ${
              activeChannel.value === 'inbound'
                ? 'bg-white text-zinc-900 shadow dark:bg-zinc-800 dark:text-zinc-50'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400'
            }`}
            onClick={() => { activeChannel.value = 'inbound'; }}
          >
            {t('registryCertifyChannelA')}
          </button>
          <button
            type="button"
            class={`flex-1 rounded-xl px-3 py-2 text-sm font-semibold transition ${
              activeChannel.value === 'esp'
                ? 'bg-white text-zinc-900 shadow dark:bg-zinc-800 dark:text-zinc-50'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400'
            }`}
            onClick={() => { activeChannel.value = 'esp'; }}
          >
            {t('registryCertifyChannelB')}
          </button>
        </div>
      )}

      <div class="mb-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label class="mb-1 block text-sm font-medium">{t('registryCertifyEmailReadonly')}</label>
        {profileLoading.value ? (
          <p class="text-sm text-zinc-500">{t('registryCertifyLoading')}</p>
        ) : hasEmail ? (
          <p class="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950">
            {email}
          </p>
        ) : (
          <p class="text-sm text-amber-700 dark:text-amber-300">
            {t('registryCertifyNoEmail')}
            <a href="/settings" class="mx-1 font-semibold underline">
              {t('registryCertifyNoEmailLink')}
            </a>
            {t('registryCertifyNoEmailSuffix')}
          </p>
        )}
      </div>

      {!certified.value && activeChannel.value === 'inbound' && showInbound && (
        <section class="space-y-4 rounded-2xl border border-sky-200 bg-sky-50/80 p-6 dark:border-sky-500/30 dark:bg-sky-500/10">
          <div>
            <h2 class="text-base font-semibold text-sky-950 dark:text-sky-100">{t('registryCertifyChannelATitle')}</h2>
            <p class="mt-1 text-sm text-sky-900 dark:text-sky-200">{t('registryCertifyChannelAHint')}</p>
          </div>

          {!inboundAddress.value ? (
            <button
              type="button"
              disabled={!hasEmail || inboundIssuing.value}
              class="w-full rounded-full bg-sky-600 py-3 text-sm font-bold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleIssueInboundAddress()}
            >
              {inboundIssuing.value ? t('registryCertifyInboundIssuing') : t('registryCertifyInboundIssue')}
            </button>
          ) : (
            <div class="space-y-3">
              <div>
                <p class="text-xs font-medium text-sky-800 dark:text-sky-300">{t('registryCertifyInboundAddress')}</p>
                <div class="mt-1 flex gap-2">
                  <p class="min-w-0 flex-1 break-all rounded-lg border border-sky-200 bg-white px-3 py-2 font-mono text-sm dark:border-sky-500/30 dark:bg-zinc-950">
                    {inboundAddress.value.cert_inbound_address}
                  </p>
                  <button
                    type="button"
                    class="shrink-0 rounded-lg border border-sky-300 px-3 py-2 text-xs font-semibold text-sky-800 dark:border-sky-500/40 dark:text-sky-200"
                    onClick={() => void copyText(inboundAddress.value!.cert_inbound_address)}
                  >
                    {t('registryCertifyCopy')}
                  </button>
                </div>
              </div>
              <p class="text-xs text-sky-800 dark:text-sky-200">
                {t('registryCertifyInboundExpires', undefined, {
                  time: formatExpiry(inboundAddress.value.expires_at),
                })}
              </p>
              <p class="text-sm leading-relaxed text-sky-900 dark:text-sky-100">{t('registryCertifyInboundSteps')}</p>
              <button
                type="button"
                class="rounded-full border border-sky-400 px-4 py-2 text-sm font-semibold text-sky-800 dark:text-sky-200"
                onClick={() => void refreshVerificationStatus()}
              >
                {t('registryCertifyInboundRefresh')}
              </button>
            </div>
          )}
        </section>
      )}

      {!certified.value && activeChannel.value === 'esp' && showEsp && (
        <form
          class="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
          onSubmit={(e) => void handleCertify(e)}
          noValidate
        >
          <div>
            <h2 class="text-base font-semibold text-zinc-900 dark:text-zinc-50">{t('registryCertifyChannelBTitle')}</h2>
            <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{t('registryCertifyChannelBHint')}</p>
            {ctx && (
              <p class="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
                {t('registryCertifyCoinBalance', undefined, {
                  balance: String(ctx.hailuo_coins),
                  cost: String(ctx.esp_verify_coin_cost),
                })}
              </p>
            )}
            {ctx && !espAffordable && sendCooldown.value <= 0 && (
              <p class="mt-2 text-sm text-amber-700 dark:text-amber-300">{t('registryCertifyCoinInsufficient')}</p>
            )}
            {ctx && !espAffordable && sendCooldown.value > 0 && (
              <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                {t('registryCertifyCodeSent')}
              </p>
            )}
          </div>

          <div>
            <label class="mb-1 block text-sm font-medium" htmlFor="cert-code">
              {t('registryCertifyCodeLabel')}
            </label>
            <div class="flex gap-2">
              <input
                id="cert-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={codeInput.value}
                disabled={!hasEmail || certified.value}
                onInput={(ev) => {
                  codeInput.value = (ev.currentTarget as HTMLInputElement).value;
                  codeConfirmed.value = false;
                  emailVerifyToken.value = '';
                }}
                class="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-3 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                type="button"
                disabled={!hasEmail || certified.value || sendCooldown.value > 0 || !espAffordable}
                class="shrink-0 rounded-full border border-sky-500 px-4 py-2 text-sm font-semibold text-sky-600 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-sky-400 dark:hover:bg-sky-500/10"
                onClick={() => void handleSendCode()}
              >
                {sendCooldown.value > 0 ? `${sendCooldown.value}s` : t('registryCertifySendCode')}
              </button>
            </div>
            {codeConfirmed.value && (
              <p class="mt-1 text-xs text-emerald-600 dark:text-emerald-400">{t('registryCertifyCodeConfirmed')}</p>
            )}
          </div>

          {!certified.value && codeInput.value.trim().length >= 6 && !codeConfirmed.value && (
            <button
              type="button"
              class="rounded-full bg-zinc-200 px-5 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-100"
              onClick={() => void handleConfirmCode()}
            >
              {t('registryCertifyConfirmCode')}
            </button>
          )}

          {errorMsg.value && (
            <p class="text-sm text-rose-600" role="alert">
              {errorMsg.value}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting.value || !hasEmail || certified.value || !codeConfirmed.value}
            class="w-full rounded-full bg-zinc-900 py-3 text-sm font-bold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {submitting.value ? t('registryCertifySubmitting') : t('registryCertifySubmit')}
          </button>
        </form>
      )}

      {!certified.value && activeChannel.value === 'inbound' && errorMsg.value && (
        <p class="mt-4 text-sm text-rose-600" role="alert">
          {errorMsg.value}
        </p>
      )}
    </section>
  );
}
