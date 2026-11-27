/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { PublicRegistryEndpoint } from '@hailuo/shared-types';
import { resolveWorkerAUrl, getOwnerJwt } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import { loadOwnerProfile, ownerProfile, patchOwnerProfile } from '../lib/ownerProfile';
import { createWorkerAClient } from '../lib/workerA';
import {
  formatRegistryStatusLabel,
  formatRegistryStatusTone,
  loadPublicRegistryEndpoints,
  primaryRegistryUrlFromList,
  publicRegistryEndpoints,
} from '../lib/registryEndpoints';
import { showToast } from '../lib/toast';
import { initLanguage, language, t } from '../lib/i18n';
import { RegistryTurnstileBridge } from './RegistryTurnstileBridge';
import { TermsHandbookBody } from './TermsHandbookBody';
import {
  PROJECT_TERMS_VERSION,
  validateRegisterPrecheckEmail,
  isValidRegisterHandleLocal,
  isReservedHandlePrefix,
} from '@hailuo/shared-utils';
import {
  EMPTY_OUTBOUND_UNLOCK_STATE,
  isOutboundUiUnlocked,
  recordOutboundPrecheck,
  recordOutboundRegisterClick,
  type OutboundUnlockState,
} from '@hailuo/shared-crypto';
import type { BootstrapOutboundTemplateResponse } from '../lib/workerA/types';
import { verifyBootstrapManifestText } from '../lib/bootstrapManifest';

type Step = 'form' | 'submitting' | 'done' | 'append' | 'append-submitting';

const step = signal<Step>('form');
const handleInput = signal<string>('');
const displayNameInput = signal<string>('');
const emailInput = signal<string>('');
/** 2026-09-27：移除 ageOver18Accepted，登记不再要求年龄自证 */
const termsAccepted = signal<boolean>(false);
/** 本会话是否已在弹窗中确认手册（提交前强制弹一次） */
const termsModalConfirmed = signal(false);
const showTermsModal = signal(false);
const turnstileToken = signal<string | null>(null);
/** 注册失败后递增以重载 Turnstile iframe，否则 token 已清空但控件仍显示「成功」导致按钮一直禁用 */
const turnstileBridgeKey = signal(0);
const errorMsg = signal<string | null>(null);
const appendTargetId = signal<string | null>(null);
const endpointsLoading = signal(true);
/** M33-4：登记成功返回的认证收件域 */
const certInboundHost = signal<string | null>(null);
const certInboundExample = signal<string | null>(null);
const certInboundPurpose = signal<string | null>(null);

/** M9-PH-BO-1：路径 D UI 解锁（F1：刷新重置） */
const outboundUnlock = signal<OutboundUnlockState>({ ...EMPTY_OUTBOUND_UNLOCK_STATE });
const outboundTemplate = signal<BootstrapOutboundTemplateResponse | null>(null);
const outboundTemplateLoading = signal(false);
const outboundTemplateError = signal<string | null>(null);
/** M9-PH-BO-2：主链错误附带 fallback_* 时加强引导（不单独解锁） */
const outboundFallbackHint = signal<{
  reason?: string;
  email_to?: string;
} | null>(null);
const outboundClaimLoading = signal(false);

/** 与注册中心 precheck 对齐：小写，下划线转连字符 */
function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/_/g, '-');
}

/** 点登记时由浏览器自己向入口要说明，验签后再交给节点。不上送浏览器地址。 */
async function claimIntakeFromBrowser(
  client: ReturnType<typeof createWorkerAClient>,
  avoidRegistryId?: string,
): Promise<{ registry_id: string }> {
  const urls = await client.fetchBootstrapTargets();
  const base = urls[0];
  if (!base) {
    throw new ApiError(0, { message: t('registryBootstrapMissing') }, t('registryBootstrapMissing'));
  }
  const target = avoidRegistryId
    ? `${base}${base.includes('?') ? '&' : '?'}avoid_registry_id=${encodeURIComponent(avoidRegistryId)}`
    : base;
  let raw = '';
  try {
    const res = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new ApiError(res.status, { message: t('registryBootstrapFetchFailed') }, t('registryBootstrapFetchFailed'));
    }
    raw = await res.text();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, { message: t('registryBootstrapFetchFailed') }, t('registryBootstrapFetchFailed'));
  }
  const checked = await verifyBootstrapManifestText(raw);
  if (!checked.ok) {
    throw new ApiError(0, { message: checked.message }, checked.message);
  }
  return client.submitBootstrapIntake({
    manifest: raw,
    avoidRegistryId,
  });
}

async function postRegistryFromBrowser(
  registryUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${registryUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data: unknown = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, { message: t('registryDirectSubmitFailed') }, t('registryDirectSubmitFailed'));
  }
}

/** 节点签好正文，浏览器送到注册中心，再把回复交回节点。 */
async function completeRegistrationFromBrowser(
  client: ReturnType<typeof createWorkerAClient>,
  input: {
    handle: string;
    display_name: string;
    email: string;
    turnstileToken: string;
    terms_accepted: true;
    terms_version: string;
  },
) {
  const prepared = await client.completeRegistryRegister({
    ...input,
    browserRelay: { phase: 'prepare' },
  });
  if (!prepared.relay) return prepared;
  if (prepared.relay.step !== 'precheck') {
    throw new ApiError(0, { message: t('registryDirectSubmitFailed') }, t('registryDirectSubmitFailed'));
  }
  const pre = await postRegistryFromBrowser(
    prepared.relay.registry_url,
    prepared.relay.path,
    prepared.relay.body,
  );
  if (pre.status === 0 || pre.status >= 500) {
    throw new ApiError(pre.status, { message: t('registryDirectSubmitFailed') }, t('registryDirectSubmitFailed'));
  }
  const signed = await client.completeRegistryRegister({
    ...input,
    browserRelay: {
      phase: 'precheck_result',
      upstreamStatus: pre.status,
      upstreamBody: pre.body,
    },
  });
  if (!signed.relay) return signed;
  if (signed.relay.step !== 'verify') {
    throw new ApiError(0, { message: t('registryDirectSubmitFailed') }, t('registryDirectSubmitFailed'));
  }
  const verified = await postRegistryFromBrowser(
    signed.relay.registry_url,
    signed.relay.path,
    signed.relay.body,
  );
  if (verified.status === 0 || verified.status >= 500) {
    throw new ApiError(verified.status, { message: t('registryDirectSubmitFailed') }, t('registryDirectSubmitFailed'));
  }
  return client.completeRegistryRegister({
    ...input,
    browserRelay: {
      phase: 'verify_result',
      upstreamStatus: verified.status,
      upstreamBody: verified.body,
    },
  });
}

/** 登记合规字段（不含手册同意；手册由提交前弹窗强制确认）。
 * 2026-09-27：移除 ageOver18 校验，登记不再要求年龄自证。 */
function validateRegisterComplianceFields(): string | null {
  return null;
}

function validateHandle(handle: string): string | null {
  const h = normalizeHandle(handle);
  if (!h) return t('registryHandleRequired');
  // 中文注释：保留前缀与登记格式分两步，便于区分错误文案
  if (isReservedHandlePrefix(h)) {
    return t('registryHandleReserved');
  }
  if (!isValidRegisterHandleLocal(h)) {
    return t('registryHandleInvalid');
  }
  return null;
}

function pendingEndpoints(items: readonly PublicRegistryEndpoint[]): PublicRegistryEndpoint[] {
  return items.filter((item) => item.status === 'pending');
}

function findEndpoint(registryId: string): PublicRegistryEndpoint | undefined {
  return publicRegistryEndpoints.value?.find((item) => item.registry_id === registryId);
}

function statusBadgeClass(tone: 'ok' | 'warn' | 'bad'): string {
  if (tone === 'ok') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200';
  }
  if (tone === 'bad') {
    return 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200';
  }
  return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200';
}

function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function RegistryEndpointRow({ endpoint }: { endpoint: PublicRegistryEndpoint }): VNode {
  const tone = formatRegistryStatusTone(endpoint.status);
  return (
    <li class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {endpoint.registry_id}
          </p>
          <p class="mt-1 break-all text-xs text-zinc-500 dark:text-zinc-400">{endpoint.registry_url}</p>
        </div>
        <span class={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(tone)}`}>
          {formatRegistryStatusLabel(endpoint.status)}
        </span>
      </div>
      <dl class="mt-2 grid gap-1 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-2">
        <div>
          <dt class="inline">{t('registryLastOk')}</dt>
          <dd class="inline">{formatTime(endpoint.last_ok_at)}</dd>
        </div>
        <div>
          <dt class="inline">{t('registryFailStreak')}</dt>
          <dd class="inline">{endpoint.fail_streak}</dd>
        </div>
      </dl>
    </li>
  );
}

export function RegistryRegister(): VNode {
  useEffect(() => {
    initLanguage();
    endpointsLoading.value = true;
    void loadPublicRegistryEndpoints().finally(() => {
      endpointsLoading.value = false;
    });
    void loadOwnerProfile(true).then((p) => {
      if (p) {
        handleInput.value = p.handle;
        displayNameInput.value = p.display_name;
        if (p.registered) step.value = 'done';
      }
    });
  }, []);

  const profile = ownerProfile.value;
  const endpoints = publicRegistryEndpoints.value ?? [];
  const pending = pendingEndpoints(endpoints);
  const primaryUrl = primaryRegistryUrlFromList(endpoints);
  const appendTarget = appendTargetId.value ? findEndpoint(appendTargetId.value) : undefined;

  /** 弹窗前校验：不要求已勾选手册（将由弹窗确认）。 */
  function validatePrimaryFormBeforeTermsModal(): string | null {
    const handleErr = validateHandle(handleInput.value);
    if (handleErr) return handleErr;
    const complianceErr = validateRegisterComplianceFields();
    if (complianceErr) return complianceErr;
    const emailParsed = validateRegisterPrecheckEmail(emailInput.value);
    if (!emailParsed.ok) return emailParsed.error.message;
    if (!turnstileToken.value) return t('registryTurnstileRequired');
    return null;
  }

  async function doPrimaryRegister(): Promise<void> {
    const handle = normalizeHandle(handleInput.value);
    const emailParsed = validateRegisterPrecheckEmail(emailInput.value);
    if (!emailParsed.ok) {
      errorMsg.value = emailParsed.error.message;
      return;
    }
    const email = emailParsed.value;
    const tsToken = turnstileToken.value;
    if (!tsToken) {
      errorMsg.value = t('registryTurnstileRequired');
      return;
    }

    const url = await resolveWorkerAUrl();
    if (!url) return;

    const clickMs = Date.now();
    outboundUnlock.value = recordOutboundRegisterClick(outboundUnlock.value, clickMs);
    outboundTemplate.value = null;
    outboundTemplateError.value = null;

    step.value = 'submitting';
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      let intake = await claimIntakeFromBrowser(client);
      const runComplete = () => completeRegistrationFromBrowser(client, {
        handle,
        display_name: displayNameInput.value.trim(),
        email,
        turnstileToken: tsToken,
        terms_accepted: true,
        terms_version: PROJECT_TERMS_VERSION,
      });
      let result;
      try {
        result = await runComplete();
      } catch (err) {
        const unreachable = err instanceof ApiError && (err.status === 0 || err.status >= 500);
        if (!unreachable) throw err;
        intake = await claimIntakeFromBrowser(client, intake.registry_id);
        result = await runComplete();
      }
      // 成功类回复：计 precheck，不计失败
      outboundUnlock.value = recordOutboundPrecheck(outboundUnlock.value, {
        isTransportOr5xxFailure: false,
      });
      outboundFallbackHint.value = null;
      certInboundHost.value = result.cert_inbound_host ?? null;
      certInboundExample.value = result.cert_inbound_address_example ?? null;
      certInboundPurpose.value = result.cert_inbound_purpose ?? null;
      patchOwnerProfile({
        handle: result.handle,
        display_name: result.display_name,
        registered: true,
      });
      // HANDLE-QUAL-V1：正式名（是否带 :regN）由服务端决定，成功后刷新一次再展示
      await loadOwnerProfile(true);
      await loadPublicRegistryEndpoints();
      step.value = 'done';
      showToast(t('registryRegisterSuccess'), 'info');
    } catch (err) {
      step.value = 'form';
      turnstileToken.value = null;
      turnstileBridgeKey.value += 1;
      const isTransportOr5xx =
        !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
      outboundUnlock.value = recordOutboundPrecheck(outboundUnlock.value, {
        isTransportOr5xxFailure: isTransportOr5xx,
      });
      if (err instanceof ApiError && err.body?.fallback_available === true) {
        outboundFallbackHint.value = {
          reason: err.body.fallback_required_reason,
          email_to: err.body.fallback_email_to,
        };
      }
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('registryRegisterFailed'));
      showToast(errorMsg.value, 'error');
    }
  }

  async function handleGenerateOutboundTemplate(): Promise<void> {
    outboundTemplateError.value = null;
    const handleErr = validateHandle(handleInput.value);
    if (handleErr) {
      outboundTemplateError.value = handleErr;
      return;
    }
    const emailParsed = validateRegisterPrecheckEmail(emailInput.value);
    if (!emailParsed.ok) {
      outboundTemplateError.value = emailParsed.error.message;
      return;
    }
    if (!termsAccepted.value && !termsModalConfirmed.value) {
      outboundTemplateError.value = t('registryOutboundTermsRequired');
      return;
    }
    const url = await resolveWorkerAUrl();
    if (!url) return;

    outboundTemplateLoading.value = true;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const tpl = await client.buildBootstrapOutboundTemplate({
        handle: normalizeHandle(handleInput.value),
        email: emailParsed.value,
        display_name: displayNameInput.value.trim(),
        terms_accepted: true,
        terms_version: PROJECT_TERMS_VERSION,
      });
      outboundTemplate.value = tpl;
      showToast(t('registryOutboundTemplateReady'), 'info');
    } catch (err) {
      outboundTemplate.value = null;
      outboundTemplateError.value =
        err instanceof ApiError
          ? err.displayMessage
          : getErrorMessage({}, t('registryOutboundTemplateFailed'));
      showToast(outboundTemplateError.value, 'error');
    } finally {
      outboundTemplateLoading.value = false;
    }
  }

  /** M9-PH-BO-2：发信后走 register/complete 的 accepted 续跑 → status/ack */
  async function handleOutboundClaim(): Promise<void> {
    outboundTemplateError.value = null;
    const handle = normalizeHandle(handleInput.value);
    const emailParsed = validateRegisterPrecheckEmail(emailInput.value);
    if (!emailParsed.ok) {
      outboundTemplateError.value = emailParsed.error.message;
      return;
    }
    if (!outboundTemplate.value) {
      outboundTemplateError.value = t('registryOutboundClaimNeedTemplate');
      return;
    }
    const url = await resolveWorkerAUrl();
    if (!url) return;

    outboundClaimLoading.value = true;
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      const tsToken = turnstileToken.value ?? 'outbound-claim-resume';
      let intake = await claimIntakeFromBrowser(client);
      const runComplete = () => completeRegistrationFromBrowser(client, {
        handle,
        display_name: displayNameInput.value.trim(),
        email: emailParsed.value,
        turnstileToken: tsToken,
        terms_accepted: true,
        terms_version: PROJECT_TERMS_VERSION,
      });
      let result;
      try {
        result = await runComplete();
      } catch (err) {
        const unreachable = err instanceof ApiError && (err.status === 0 || err.status >= 500);
        if (!unreachable) throw err;
        intake = await claimIntakeFromBrowser(client, intake.registry_id);
        result = await runComplete();
      }
      outboundFallbackHint.value = null;
      certInboundHost.value = result.cert_inbound_host ?? null;
      certInboundExample.value = result.cert_inbound_address_example ?? null;
      certInboundPurpose.value = result.cert_inbound_purpose ?? null;
      patchOwnerProfile({
        handle: result.handle,
        display_name: result.display_name,
        registered: true,
      });
      // HANDLE-QUAL-V1：正式名（是否带 :regN）由服务端决定，成功后刷新一次再展示
      await loadOwnerProfile(true);
      await loadPublicRegistryEndpoints();
      step.value = 'done';
      showToast(t('registryRegisterSuccess'), 'info');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'REGISTRATION_PROCESSING') {
        outboundTemplateError.value = t('registryOutboundClaimTimeout');
      } else {
        outboundTemplateError.value =
          err instanceof ApiError
            ? err.displayMessage
            : getErrorMessage({}, t('registryOutboundClaimFailed'));
      }
      showToast(outboundTemplateError.value, 'error');
    } finally {
      outboundClaimLoading.value = false;
    }
  }

  async function copyOutboundField(label: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      showToast(t('registryOutboundCopied', undefined, { field: label }), 'info');
    } catch {
      showToast(t('registryOutboundCopyFailed'), 'error');
    }
  }

  async function handlePrimarySubmit(e: Event): Promise<void> {
    e.preventDefault();
    errorMsg.value = null;

    // 中文注释：先校验表单字段与人机验证；未在弹窗确认手册则强制弹出
    const beforeModalErr = validatePrimaryFormBeforeTermsModal();
    if (beforeModalErr) {
      errorMsg.value = beforeModalErr;
      return;
    }
    if (!termsModalConfirmed.value) {
      showTermsModal.value = true;
      return;
    }

    await doPrimaryRegister();
  }

  function closeTermsModal(): void {
    showTermsModal.value = false;
  }

  async function agreeTermsModal(): Promise<void> {
    termsModalConfirmed.value = true;
    termsAccepted.value = true;
    showTermsModal.value = false;
    errorMsg.value = null;
    const formErr = validatePrimaryFormBeforeTermsModal();
    if (formErr) {
      errorMsg.value = formErr;
      return;
    }
    await doPrimaryRegister();
  }

  async function handleAppendSubmit(e: Event): Promise<void> {
    e.preventDefault();
    errorMsg.value = null;

    const targetId = appendTargetId.value;
    const tsToken = turnstileToken.value;
    if (!targetId) {
      errorMsg.value = t('registryAppendSelectRequired');
      return;
    }
    if (!tsToken) {
      errorMsg.value = t('registryTurnstileRequired');
      return;
    }

    const url = await resolveWorkerAUrl();
    if (!url) return;

    step.value = 'append-submitting';
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      await client.completeRegistryAppendRegister({
        registryId: targetId,
        turnstileToken: tsToken,
      });
      await loadPublicRegistryEndpoints();
      appendTargetId.value = null;
      turnstileToken.value = null;
      turnstileBridgeKey.value += 1;
      step.value = 'done';
      showToast(t('registryAppendSuccess'), 'info');
    } catch (err) {
      step.value = 'append';
      turnstileToken.value = null;
      turnstileBridgeKey.value += 1;
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('registryAppendFailed'));
      showToast(errorMsg.value, 'error');
    }
  }

  function startAppend(registryId: string): void {
    appendTargetId.value = registryId;
    turnstileToken.value = null;
    turnstileBridgeKey.value += 1;
    errorMsg.value = null;
    step.value = 'append';
  }

  // UX-CHAT-ALIGN-1：与侧栏左贴齐（main 已是 max-w-none），与首页 PostCard 同款 px-4 sm:px-6
  if (step.value === 'append' || step.value === 'append-submitting') {
    return (
      <section class="w-full max-w-lg px-4 py-8 sm:px-6">
        <header class="mb-6">
          <h1 class="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{t('registryAppendTitle')}</h1>
          <p class="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            {t('registryAppendDescription')}
          </p>
        </header>

        {appendTarget ? (
          <form
            class="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
            onSubmit={(e) => void handleAppendSubmit(e)}
            noValidate
          >
            <div class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <p class="font-medium text-zinc-900 dark:text-zinc-100">{appendTarget.registry_id}</p>
              <p class="mt-1 break-all text-xs text-zinc-500">{appendTarget.registry_url}</p>
            </div>

            <div>
              <p class="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('registryTurnstileRequiredLabel')}</p>
              <RegistryTurnstileBridge
                key={turnstileBridgeKey.value}
                registryUrl={appendTarget.registry_url}
                onToken={(token) => {
                  turnstileToken.value = token;
                  errorMsg.value = null;
                }}
                onExpire={() => {
                  turnstileToken.value = null;
                }}
                onError={() => {
                  turnstileToken.value = null;
                  errorMsg.value = t('registryAppendTurnstileLoadFailed');
                }}
              />
            </div>

            {errorMsg.value && (
              <p
                class="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
                role="alert"
              >
                {errorMsg.value}
              </p>
            )}

            <div class="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={step.value === 'append-submitting'}
                onClick={() => {
                  appendTargetId.value = null;
                  step.value = 'done';
                  errorMsg.value = null;
                }}
                class="rounded-full border border-zinc-300 px-6 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {t('registryBack')}
              </button>
              <button
                type="submit"
                disabled={step.value === 'append-submitting' || !turnstileToken.value}
                class="flex-1 rounded-full bg-zinc-900 py-3 text-sm font-bold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {step.value === 'append-submitting' ? t('registryAppendSubmitting') : t('registryAppendSubmit')}
              </button>
            </div>
          </form>
        ) : (
          <p class="text-sm text-zinc-600 dark:text-zinc-400">{t('registryAppendNotFound')}</p>
        )}
      </section>
    );
  }

  if (step.value === 'done' || profile?.registered) {
    // 邮箱已认证后不要继续显示「去认证」和「如需蓝标认证」的旧文案。
    const emailVerified = profile?.email_verified === true;
    return (
      <section class="w-full max-w-lg px-4 py-8 sm:px-6">
        <div class="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <h1 class="text-xl font-bold text-emerald-900 dark:text-emerald-100">{t('registryDoneTitle')}</h1>
          <p class="mt-2 text-sm text-emerald-800 dark:text-emerald-200">
            {emailVerified
              ? t('registryCertifySuccess')
              : t('registryDoneBody', undefined, {
                handle: profile?.handle_qualified?.trim() || profile?.handle || handleInput.value,
              })}
          </p>
          {!emailVerified && certInboundHost.value && (
            <div class="mt-4 rounded-xl border border-emerald-300/60 bg-white/60 p-4 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-100">
              <p class="font-semibold">{t('registryCertInboundTitle')}</p>
              <dl class="mt-2 space-y-1">
                <div>
                  <dt class="text-xs opacity-80">{t('registryCertInboundHost')}</dt>
                  <dd class="mono text-[13px]">{certInboundHost.value}</dd>
                </div>
                {certInboundExample.value && (
                  <div>
                    <dt class="text-xs opacity-80">{t('registryCertInboundExample')}</dt>
                    <dd class="mono text-[13px]">{certInboundExample.value}</dd>
                  </div>
                )}
                {certInboundPurpose.value && (
                  <div>
                    <dt class="text-xs opacity-80">{t('registryCertInboundPurpose')}</dt>
                    <dd class="text-[13px]">{certInboundPurpose.value}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
          <div class="mt-4 flex flex-wrap justify-center gap-3">
            {!emailVerified && (
              <a
                href="/certify"
                class="inline-block rounded-full bg-sky-600 px-6 py-2 text-sm font-bold text-white hover:bg-sky-700"
              >
                {t('registryGoCertify')}
              </a>
            )}
            <a
              href="/"
              class="inline-block rounded-full border border-emerald-600 px-6 py-2 text-sm font-bold text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            >
              {t('registryBackHome')}
            </a>
          </div>
        </div>

        {endpoints.length > 0 && (
          <section class="mt-6 space-y-3">
            <h2 class="text-base font-semibold text-zinc-900 dark:text-zinc-50">{t('registryListTitle')}</h2>
            <ul class="space-y-2">
              {endpoints.map((endpoint) => (
                <RegistryEndpointRow key={endpoint.registry_id} endpoint={endpoint} />
              ))}
            </ul>
          </section>
        )}

        {pending.length > 0 && (
          <section class="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-500/30 dark:bg-amber-500/10">
            <h2 class="text-base font-semibold text-amber-900 dark:text-amber-100">{t('registryPendingTitle')}</h2>
            <p class="mt-1 text-sm text-amber-800 dark:text-amber-200">
              {t('registryPendingDescription')}
            </p>
            <ul class="mt-4 space-y-2">
              {pending.map((endpoint) => (
                <li
                  key={endpoint.registry_id}
                  class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200/80 bg-white/80 px-3 py-2 dark:border-amber-500/20 dark:bg-zinc-900/40"
                >
                  <div class="min-w-0">
                    <p class="font-mono text-sm font-medium">{endpoint.registry_id}</p>
                    <p class="break-all text-xs text-zinc-500">{endpoint.registry_url}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => startAppend(endpoint.registry_id)}
                    class="shrink-0 rounded-full bg-amber-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-amber-700"
                  >
                    {t('registryGoRegister')}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {endpointsLoading.value && endpoints.length === 0 && (
          <p class="mt-4 text-sm text-zinc-500">{t('registryLoadingList')}</p>
        )}
      </section>
    );
  }

  return (
    <section class="w-full max-w-lg px-4 py-8 sm:px-6">
      <header class="mb-6">
        <h1 class="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{t('registryFormTitle')}</h1>
        <p class="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          {t('registryFormDescription')}
          <a href="/terms" class="text-sky-600 hover:underline dark:text-sky-400" target="_blank" rel="noopener noreferrer">
            {t('registryTermsLink')}
          </a>
          {t('registryFormDescriptionSuffix')}
        </p>
        {primaryUrl && (
          <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            {t('registryPrimaryUrl')}<span class="break-all font-mono">{primaryUrl}</span>
          </p>
        )}
      </header>

      <form
        class="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        onSubmit={(e) => void handlePrimarySubmit(e)}
        noValidate
      >
        <div>
          <label class="mb-1 block text-sm font-medium" htmlFor="reg-handle">
            {t('registryHandleLabel')}
          </label>
          <input
            id="reg-handle"
            type="text"
            spellcheck={false}
            value={handleInput.value}
            onInput={(ev) => {
              handleInput.value = (ev.currentTarget as HTMLInputElement).value;
            }}
            class="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <p class="mt-1 text-xs text-zinc-500">{t('registryHandleHint')}</p>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium" htmlFor="reg-display">
            {t('registryDisplayNameLabel')}
          </label>
          <input
            id="reg-display"
            type="text"
            placeholder={t('registryDisplayNamePlaceholder')}
            value={displayNameInput.value}
            onInput={(ev) => {
              displayNameInput.value = (ev.currentTarget as HTMLInputElement).value;
            }}
            class="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>

        {/* 2026-09-27：移除 age checkbox，登记不再要求年龄自证 */}

        <div>
          <label class="mb-1 block text-sm font-medium" htmlFor="reg-email">
            {t('registryEmailLabel')}
          </label>
          <input
            id="reg-email"
            type="email"
            required
            autoComplete="email"
            placeholder={t('registryEmailPlaceholder')}
            value={emailInput.value}
            onInput={(ev) => {
              emailInput.value = (ev.currentTarget as HTMLInputElement).value;
            }}
            class="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>

        <label class="flex items-start gap-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
          <input
            type="checkbox"
            checked={termsAccepted.value}
            onChange={(ev) => {
              termsAccepted.value = (ev.currentTarget as HTMLInputElement).checked;
            }}
            class="mt-0.5"
          />
          <span>
            {t('registryTermsAcceptPrefix')}
            <a href="/terms" class="text-sky-600 hover:underline dark:text-sky-400" target="_blank" rel="noopener noreferrer">
              {t('registryTermsAcceptLink', undefined, { version: PROJECT_TERMS_VERSION })}
            </a>
          </span>
        </label>

        <div>
          <p class="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('registryTurnstileRequiredLabel')}</p>
          <RegistryTurnstileBridge
            key={turnstileBridgeKey.value}
            registryUrl={primaryUrl ?? undefined}
            onToken={(token) => {
              turnstileToken.value = token;
              errorMsg.value = null;
            }}
            onExpire={() => {
              turnstileToken.value = null;
            }}
            onError={() => {
              turnstileToken.value = null;
              errorMsg.value = t('registryTurnstileLoadFailed');
            }}
          />
        </div>

        {errorMsg.value && (
          <p
            class="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
            role="alert"
          >
            {errorMsg.value}
          </p>
        )}

        <button
          type="submit"
          disabled={step.value === 'submitting' || !turnstileToken.value}
          class="w-full rounded-full bg-zinc-900 py-3 text-sm font-bold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {step.value === 'submitting' ? t('registrySubmitting') : t('registrySubmit')}
        </button>
      </form>

      {/* M9-PH-BO-1/2：路径 D 邮件兜底（§3.0.3 解锁；fallback_* 加强引导；发信后 claim） */}
      {(() => {
        const unlocked = isOutboundUiUnlocked(outboundUnlock.value);
        const tpl = outboundTemplate.value;
        const fb = outboundFallbackHint.value;
        return (
          <section class="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 class="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              {t('registryOutboundTitle')}
            </h2>
            <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{t('registryOutboundHint')}</p>
            {fb && (
              <p
                class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                role="status"
              >
                {t('registryOutboundFallbackBanner', undefined, {
                  reason: fb.reason ?? '—',
                  email_to: fb.email_to ?? 'bootstrap-outbound+…',
                })}
              </p>
            )}
            {!unlocked ? (
              <p class="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
                {t('registryOutboundLocked')}
              </p>
            ) : (
              <div class="mt-4 space-y-3">
                <button
                  type="button"
                  disabled={outboundTemplateLoading.value || outboundClaimLoading.value}
                  onClick={() => {
                    void handleGenerateOutboundTemplate();
                  }}
                  class="rounded-full bg-sky-600 px-5 py-2 text-sm font-bold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {outboundTemplateLoading.value
                    ? t('registryOutboundGenerating')
                    : t('registryOutboundGenerate')}
                </button>
                {outboundTemplateError.value && (
                  <p class="text-sm text-rose-700 dark:text-rose-300" role="alert">
                    {outboundTemplateError.value}
                  </p>
                )}
                {tpl && (
                  <div class="space-y-3 rounded-xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-500/30 dark:bg-sky-950/30">
                    <p class="text-xs text-sky-900 dark:text-sky-100">{t('registryOutboundInstructions')}</p>
                    {(
                      [
                        ['To', tpl.to],
                        ['Subject', tpl.subject],
                        ['Body', tpl.body],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <div class="mb-1 flex items-center justify-between gap-2">
                          <span class="text-xs font-semibold uppercase tracking-wide text-fg2">
                            {label}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              void copyOutboundField(label, value);
                            }}
                            class="rounded-full border border-sky-300 px-3 py-0.5 text-xs font-medium text-sky-800 hover:bg-sky-100 dark:border-sky-500/40 dark:text-sky-200 dark:hover:bg-sky-900/40"
                          >
                            {t('registryOutboundCopy')}
                          </button>
                        </div>
                        <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-200 bg-white p-2 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                          {value}
                        </pre>
                      </div>
                    ))}
                    <p class="text-xs text-zinc-500 dark:text-zinc-400">
                      {t('registryOutboundClaimHint', undefined, {
                        nonce: tpl.claim_token.slice(0, 8),
                      })}
                    </p>
                    <button
                      type="button"
                      disabled={outboundClaimLoading.value || outboundTemplateLoading.value}
                      onClick={() => {
                        void handleOutboundClaim();
                      }}
                      class="w-full rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {outboundClaimLoading.value
                        ? t('registryOutboundClaiming')
                        : t('registryOutboundClaim')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })()}

      {showTermsModal.value && (
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="terms-modal-title"
        >
          <div class="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <div class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <h2 id="terms-modal-title" class="text-base font-bold text-zinc-900 dark:text-zinc-50">
                {t('registryTermsModalTitle', undefined, { version: PROJECT_TERMS_VERSION })}
              </h2>
              <p class="mt-1 text-xs text-zinc-500">{t('registryTermsModalHint')}</p>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <TermsHandbookBody lang={language.value} compact />
            </div>
            <div class="flex gap-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <button
                type="button"
                onClick={closeTermsModal}
                class="flex-1 rounded-full border border-zinc-300 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {t('registryTermsModalCancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void agreeTermsModal();
                }}
                class="flex-1 rounded-full bg-zinc-900 py-2.5 text-sm font-bold text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {t('registryTermsModalAgree')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
