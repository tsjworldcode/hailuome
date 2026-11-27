/** @jsxImportSource preact */
/**
 * 整站登录门禁（类 X.com）：未登录站主时只展示登录页，不渲染 Feed / 导航 / 侧栏。
 *
 * - 视觉：Cloudflare 风格橙主色（#f6821f）+ 渐变背景 + 圆角卡片（M7-26g）
 * - 节点 API 入口由部署时 PUBLIC_WORKER_B_URL 注入，登录页不再展示或填写
 * - 再次访问：若 sessionStorage 仍有有效 JWT → 直接进入；否则仅用户名 + 密码
 */
import type { VNode } from 'preact';
import type { ComponentChildren } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { getOwnerJwt, resolveWorkerAUrl } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import {
  loginOwner,
  tryRestoreOwnerSession,
  type OwnerSession,
} from '../lib/ownerSession';
import { initLanguage, t } from '../lib/i18n';
import { LoginScreen } from './LoginScreen';
import { LoginDeployStatus } from './LoginDeployStatus';
import { startOwnerUnreadPolling } from '../lib/ownerUnreadStore';

interface Props {
  readonly children: ComponentChildren;
}

type GatePhase = 'checking' | 'login' | 'authed' | 'misconfigured';
type LoginStep = 'credentials' | 'totp';

function initialGatePhase(): GatePhase {
  if (typeof window === 'undefined') return 'authed';
  // 客户端首帧必须和 SSR 的 slot 内容对齐，避免 hydration mismatch；随后由 bootstrapSession 复验登录态。
  return 'authed';
}

const phase = signal<GatePhase>(initialGatePhase());
const loginPending = signal<boolean>(false);
const passwordVisible = signal<boolean>(false);
export const errorMsg = signal<string | null>(null);
const usernameInput = signal<string>('');
const passwordInput = signal<string>('');
export const loginStep = signal<LoginStep>('credentials');
export const totpInput = signal<string>('');
export const recoveryInput = signal<string>('');
export const useRecoveryCode = signal<boolean>(false);
const sessionInfo = signal<OwnerSession | null>(null);
export { loginPending, passwordInput, passwordVisible, usernameInput };
let bootstrapRunId = 0;

function setStaticShellVisible(visible: boolean): void {
  if (typeof document === 'undefined') return;
  const islands = document.querySelectorAll('astro-island[component-export="SiteAuthGate"]');
  for (const island of islands) {
    const slots = island.querySelectorAll(':scope > astro-slot, :scope > astro-static-slot');
    for (const slot of slots) {
      // Astro View Transitions 可能短暂保留新旧两个 island；两个都同步处理，避免旧静态壳残留。
      (slot as HTMLElement).hidden = !visible;
    }
  }
}

async function bootstrapSession(options: { readonly silent?: boolean } = {}): Promise<void> {
  const runId = ++bootstrapRunId;
  const hasJwt = Boolean(getOwnerJwt());
  const silent = options.silent === true || (hasJwt && phase.value === 'authed');
  if (!silent && !hasJwt) {
    phase.value = 'checking';
  }
  errorMsg.value = null;

  const url = await resolveWorkerAUrl();
  if (!url) {
    if (runId === bootstrapRunId) phase.value = 'misconfigured';
    return;
  }

  const restored = await tryRestoreOwnerSession();
  if (runId !== bootstrapRunId) return;
  if (restored) {
    sessionInfo.value = restored;
    phase.value = 'authed';
    startOwnerUnreadPolling();
    return;
  }
  sessionInfo.value = null;
  phase.value = 'login';
}

async function handleSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = null;

  if (!await resolveWorkerAUrl()) {
    errorMsg.value = t('loginEndpointMissingSubmit');
    return;
  }

  loginPending.value = true;
  try {
    const session = await loginOwner({
      username: usernameInput.value,
      password: passwordInput.value,
      ...(loginStep.value === 'totp' && !useRecoveryCode.value
        ? { totpCode: totpInput.value.trim() }
        : {}),
      ...(loginStep.value === 'totp' && useRecoveryCode.value
        ? { recoveryCode: recoveryInput.value.trim() }
        : {}),
    });
    passwordInput.value = '';
    totpInput.value = '';
    recoveryInput.value = '';
    loginStep.value = 'credentials';
    useRecoveryCode.value = false;
    sessionInfo.value = session;
    phase.value = 'authed';
    startOwnerUnreadPolling();
    if (session.mustChangeCredentials && typeof window !== 'undefined') {
      window.location.href = '/settings';
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') {
      loginStep.value = 'totp';
      errorMsg.value = null;
    } else if (err instanceof ApiError && err.code === 'AUTH_INVALID') {
      errorMsg.value = t('loginInvalid');
    } else if (err instanceof ApiError && err.status === 0) {
      // 仅网络层失败才提示「重新部署 / PUBLIC_WORKER_B_URL」
      errorMsg.value = t('loginEndpointUnavailable');
    } else if (
      err instanceof ApiError &&
      err.code === 'INTERNAL_ERROR' &&
      typeof err.body?.message === 'string' &&
      err.body.message.trim().length > 0
    ) {
      // 缺 JWT_SECRET 等运维类 500：展示服务端原文，勿被 catalog「服务暂时不可用」盖住
      errorMsg.value = err.body.message.trim();
    } else {
      errorMsg.value =
        err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('loginFailed'));
    }
  } finally {
    loginPending.value = false;
  }
}

function MisconfiguredScreen(): VNode {
  return (
    <div class="relative flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-zinc-100 via-zinc-50 to-orange-50/40 px-4 py-10 font-apple antialiased dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-900">
      <div class="w-full max-w-md rounded-2xl border border-rose-200/90 bg-white/95 p-8 text-center shadow-[0_8px_30px_rgba(15,23,42,0.08)] dark:border-rose-900/50 dark:bg-zinc-900/95">
        <h1 class="text-lg font-semibold text-rose-900 dark:text-rose-200">{t('loginMisconfiguredTitle')}</h1>
        <p class="mt-3 text-sm leading-relaxed text-slate-600 dark:text-zinc-300">
          {t('loginMisconfiguredBody')}
        </p>
        <p class="mt-2 text-xs text-slate-500 dark:text-zinc-400">
          {t('loginMisconfiguredHint')}
        </p>
        <LoginDeployStatus />
      </div>
    </div>
  );
}

function CheckingScreen(): VNode {
  return (
    <div
      data-i18n="loginChecking"
      class="flex min-h-[100dvh] items-center justify-center bg-zinc-100 text-sm text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400"
    >
      {t('loginChecking')}
    </div>
  );
}

export function SiteAuthGate({ children }: Props): VNode {
  const hasJwt = Boolean(getOwnerJwt());
  const shellVisible = phase.value === 'authed' || hasJwt;
  // 在渲染阶段也同步一次静态 slot 可见性，避免 hydration/切页事件间隙露出旧的 SSR 内容。
  setStaticShellVisible(shellVisible);

  useEffect(() => {
    setStaticShellVisible(shellVisible);
  }, [phase.value]);

  useEffect(() => {
    initLanguage();
    void bootstrapSession({ silent: shellVisible });

    const handlePageLoad = (): void => {
      void bootstrapSession({ silent: true });
    };
    document.addEventListener('astro:page-load', handlePageLoad);
    document.addEventListener('astro:after-swap', handlePageLoad);
    return () => {
      document.removeEventListener('astro:page-load', handlePageLoad);
      document.removeEventListener('astro:after-swap', handlePageLoad);
    };
  }, []);

  // 登出后 replace('/') 已是全新页：客户端无 ?_logout 标记，直接走 bootstrapSession。
  if (phase.value === 'checking' && hasJwt) {
    return <>{children}</>;
  }

  if (phase.value === 'checking') return <CheckingScreen />;
  if (phase.value === 'misconfigured') return <MisconfiguredScreen />;
  if (phase.value === 'login') return <LoginScreen onSubmit={handleSubmit} />;
  return <>{children}</>;
}
