/** @jsxImportSource preact */
/**
 * LoginScreen —— 站主登录表单（独立组件，UX-LOGIN-SPLIT-1）
 *
 * 从 SiteAuthGate 拆出。承担登录页所有 UI（标题、口号、表单、按钮、错误提示、页脚、部署状态），
 * 不承担门禁状态机本身；只通过 props.onSubmit 回调 + 共享 signals 与父组件通信。
 *
 * 共享 signals（从 SiteAuthGate 导入）：
 * - loginPending：登录请求进行中（按钮 disabled）
 * - passwordVisible / usernameInput / passwordInput / loginStep / totpInput /
 *   recoveryInput / useRecoveryCode / errorMsg：表单状态
 *
 * 父组件（SiteAuthGate）保留：
 * - bootstrapSession / handleSubmit：门禁与提交流程
 * - bootstrapRunId / phase / sessionInfo：门禁状态机
 * - MisconfiguredScreen / CheckingScreen：其它态 UI
 *
 * 拆分动机（与 b209c9fb / 3b91726a / 47481a04 / 7b4230f8 五次迭代关联）：
 * - 登录页 UI 在 5 天内被反复微调（标题/口号/字体），每次都整文件 diff 150+ 行；
 * - 抽出后，未来"只动口号/字体"的 PR 只动 LoginScreen.tsx，不再把门禁逻辑拉进 diff；
 * - 抽出后，SiteAuthGate 缩到门禁本职，回归"状态机 + 路由"职责。
 */
import type { VNode } from 'preact';
import { t } from '../lib/i18n';
import { CompactLanguageToggle } from './LanguageToggle';
import { LoginDeployStatus } from './LoginDeployStatus';
import { PasswordField } from './PasswordField';
import {
  errorMsg,
  loginPending,
  loginStep,
  passwordInput,
  passwordVisible,
  recoveryInput,
  totpInput,
  useRecoveryCode,
  usernameInput,
} from './SiteAuthGate';

/** 登录页密码框皮肤（视觉基线）：抽 PasswordField 前后必须逐字一致，禁止"顺手优化" */
const LOGIN_PASSWORD_INPUT_CLASS =
  'w-full rounded-xl border border-zinc-300 bg-white py-3 pl-4 pr-12 text-[15px] font-normal text-zinc-900 placeholder:text-zinc-400 focus:border-[#f6821f] focus:outline-none focus:ring-[3px] focus:ring-[#f6821f]/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-500';
const LOGIN_PASSWORD_TOGGLE_CLASS =
  'absolute right-2 top-1/2 flex h-[34px] w-[34px] -translate-y-1/2 items-center justify-center rounded-lg text-[#f6821f] hover:bg-[#f6821f]/10 dark:hover:bg-[#f6821f]/15';

export function LoginScreen({ onSubmit }: { readonly onSubmit: (e: Event) => Promise<void> }): VNode {
  return (
    <div class="relative flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-zinc-100 via-zinc-50 to-orange-50/40 px-4 py-10 font-apple antialiased dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-900">
      <div
        class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(246,130,31,0.08),_transparent_55%)] dark:bg-[radial-gradient(ellipse_at_top,_rgba(246,130,31,0.12),_transparent_50%)]"
        aria-hidden="true"
      />
      <div class="absolute right-4 top-4 z-10 sm:right-6 sm:top-6">
        <CompactLanguageToggle />
      </div>
      <div class="relative z-[1] w-full max-w-[420px] rounded-2xl border border-zinc-200/90 bg-white/95 px-5 py-10 shadow-[0_8px_30px_rgba(15,23,42,0.08)] backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 dark:shadow-[0_8px_30px_rgba(0,0,0,0.35)] sm:px-10">
        <div class="mb-5 flex flex-col items-center gap-3">
          <img src="/favicon.svg" alt={t('loginBrandAlt')} width={56} height={56} class="h-14 w-14" />
          <span class="text-[22px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('loginBrand')}</span>
        </div>

        {/* 口号轻于站名：常规字重 + 略小；nowrap 保证英文整句一行 */}
        <h1 class="mb-6 whitespace-nowrap text-center text-[clamp(12.5px,3.7vw,15px)] font-normal tracking-normal text-zinc-600 dark:text-zinc-400">
          {t('loginDescription')}
        </h1>
        {loginStep.value === 'totp' && (
          <p class="mb-6 text-center text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            {t('loginTotpDescription')}
          </p>
        )}

        <form class="space-y-5" onSubmit={(e) => void onSubmit(e)} noValidate>
          {loginStep.value === 'credentials' && (
          <div>
            <label class="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100" for="gate-username">
              {t('loginUsername')}
            </label>
            <input
              id="gate-username"
              type="text"
              autoComplete="username"
              spellcheck={false}
              placeholder={t('loginUsernamePlaceholder')}
              value={usernameInput.value}
              onInput={(ev) => {
                usernameInput.value = (ev.currentTarget as HTMLInputElement).value;
              }}
              class="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-[15px] font-normal text-zinc-900 placeholder:text-zinc-400 focus:border-[#f6821f] focus:outline-none focus:ring-[3px] focus:ring-[#f6821f]/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-500"
            />
          </div>
          )}

          {loginStep.value === 'credentials' && (
          <div>
            <label class="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100" for="gate-password">
              {t('loginPassword')}
            </label>
            <PasswordField
              id="gate-password"
              autoComplete="current-password"
              placeholder={t('loginPasswordPlaceholder')}
              value={passwordInput.value}
              visible={passwordVisible.value}
              inputClass={LOGIN_PASSWORD_INPUT_CLASS}
              toggleClass={LOGIN_PASSWORD_TOGGLE_CLASS}
              onInput={(v) => { passwordInput.value = v; }}
              onToggle={() => { passwordVisible.value = !passwordVisible.value; }}
            />
          </div>
          )}

          {loginStep.value === 'totp' && !useRecoveryCode.value && (
            <div>
              <label class="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100" for="gate-totp">
                {t('loginTotpLabel')}
              </label>
              <input
                id="gate-totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t('loginTotpCodePlaceholder')}
                value={totpInput.value}
                onInput={(ev) => {
                  totpInput.value = (ev.currentTarget as HTMLInputElement).value;
                }}
                class="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-[15px] font-normal text-zinc-900 placeholder:text-zinc-400 focus:border-[#f6821f] focus:outline-none focus:ring-[3px] focus:ring-[#f6821f]/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-500"
              />
              <button
                type="button"
                class="mt-2 text-sm text-[#f6821f] hover:underline"
                onClick={() => { useRecoveryCode.value = true; errorMsg.value = null; }}
              >
                {t('loginUseRecoveryCode')}
              </button>
            </div>
          )}

          {loginStep.value === 'totp' && useRecoveryCode.value && (
            <div>
              <label class="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100" for="gate-recovery">
                {t('loginRecoveryLabel')}
              </label>
              <input
                id="gate-recovery"
                type="text"
                placeholder={t('loginRecoveryPlaceholder')}
                value={recoveryInput.value}
                onInput={(ev) => {
                  recoveryInput.value = (ev.currentTarget as HTMLInputElement).value;
                }}
                class="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-[15px] font-normal text-zinc-900 placeholder:text-zinc-400 focus:border-[#f6821f] focus:outline-none focus:ring-[3px] focus:ring-[#f6821f]/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-500"
              />
              <button
                type="button"
                class="mt-2 text-sm text-[#f6821f] hover:underline"
                onClick={() => { useRecoveryCode.value = false; errorMsg.value = null; }}
              >
                {t('loginUseTotpCode')}
              </button>
            </div>
          )}

          {loginStep.value === 'totp' && (
            <button
              type="button"
              class="text-sm text-zinc-600 hover:underline dark:text-zinc-400"
              onClick={() => {
                loginStep.value = 'credentials';
                totpInput.value = '';
                recoveryInput.value = '';
                useRecoveryCode.value = false;
                errorMsg.value = null;
              }}
            >
              {t('loginBackToCredentials')}
            </button>
          )}

          {errorMsg.value && (
            <p
              class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
              role="alert"
            >
              {errorMsg.value}
            </p>
          )}

          <button
            type="submit"
            disabled={loginPending.value}
            class="w-full rounded-xl bg-[#f6821f] py-3.5 text-base font-semibold text-white shadow-[0_4px_14px_rgba(246,130,31,0.35)] transition hover:-translate-y-px hover:bg-[#e57517] hover:shadow-[0_6px_18px_rgba(246,130,31,0.4)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loginPending.value
              ? t('loginSubmitting')
              : loginStep.value === 'totp'
                ? t('loginTotpSubmit')
                : t('loginSubmit')}
          </button>
        </form>

        <p class="mt-6 whitespace-pre-line text-center text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t('loginFooter')}
        </p>
        <LoginDeployStatus />
      </div>
    </div>
  );
}
