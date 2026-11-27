/** @jsxImportSource preact */
/**
 * M12-1：设置页二次验证（TOTP）管理。
 */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { getOwnerJwt, resolveWorkerAUrl } from '../lib/auth';
import { ApiError, getErrorMessage } from '../lib/errors';
import { buildCurrentPasswordHash } from '../lib/ownerPassword';
import { createWorkerAClient, type OwnerTotpStatus } from '../lib/workerA';
import { SETTINGS_SECTION_CLASS, SETTINGS_INPUT_CLASS } from '../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './settings/SettingsSectionHeader';
import { QRCodeBadge } from './QRCodeBadge';
import { t } from '../lib/i18n';

interface Props {
  readonly mustChangeCredentials: boolean;
}

const status = signal<OwnerTotpStatus | null>(null);
const loading = signal(true);
const busy = signal(false);
const errorMsg = signal<string | null>(null);
const infoMsg = signal<string | null>(null);
const setupSecret = signal<string | null>(null);
const setupOtpauth = signal<string | null>(null);
const pendingRecoveryCodes = signal<readonly string[] | null>(null);
const passwordInput = signal('');
const totpInput = signal('');
const recoveryInput = signal('');
const showDisable = signal(false);
const showRotate = signal(false);

async function loadStatus(): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  try {
    const baseUrl = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (!baseUrl || !jwt) {
      status.value = null;
      return;
    }
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    status.value = await client.getTotpStatus();
  } catch (err) {
    status.value = null;
    errorMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('totpLoadFailed'));
  } finally {
    loading.value = false;
  }
}

async function withPasswordHash<T>(fn: (hash: string) => Promise<T>): Promise<T | null> {
  const baseUrl = await resolveWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) {
    errorMsg.value = t('totpPleaseLogin');
    return null;
  }
  const password = passwordInput.value;
  if (!password) {
    errorMsg.value = t('totpPasswordRequired');
    return null;
  }
  const hash = await buildCurrentPasswordHash(baseUrl, jwt, password);
  return fn(hash);
}

export function TotpSettings({ mustChangeCredentials }: Props): VNode {
  useEffect(() => {
    void loadStatus();
  }, []);

  if (mustChangeCredentials) {
    return (
      <section class={SETTINGS_SECTION_CLASS}>
        <SettingsSectionHeader sectionKey="totp" title={t('totpTitle')} />
        <p class="mt-2 text-sm text-slate-600 dark:text-zinc-400">
          {t('totpMustChangeFirst')}
        </p>
      </section>
    );
  }

  if (loading.value) {
    return (
      <section class={SETTINGS_SECTION_CLASS}>
        <p class="text-sm text-slate-600 dark:text-zinc-400" role="status">{t('totpLoading')}</p>
      </section>
    );
  }

  const enabled = status.value?.enabled === true;

  return (
    <section class={SETTINGS_SECTION_CLASS}>
      <SettingsSectionHeader sectionKey="totp" title={t('totpTitle')} />
      <p class="mt-1 text-sm text-slate-600 dark:text-zinc-400">
        {t('totpDescription')}
      </p>

      {errorMsg.value && (
        <p class="mt-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100" role="alert">
          {errorMsg.value}
        </p>
      )}
      {infoMsg.value && (
        <p class="mt-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100" role="status">
          {infoMsg.value}
        </p>
      )}

      <p class="mt-3 text-sm text-slate-700 dark:text-zinc-300">
        {t('totpStatusLabel')}
        {enabled
          ? t('totpStatusEnabled', undefined, { remaining: status.value?.recovery_codes_remaining ?? 0 })
          : t('totpStatusDisabled')}
      </p>

      {pendingRecoveryCodes.value && pendingRecoveryCodes.value.length > 0 && (
        <div class="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
          <p class="text-sm font-medium text-amber-900 dark:text-amber-100">{t('totpRecoveryCodesWarning')}</p>
          <ul class="mt-2 space-y-1 font-mono text-sm text-amber-950 dark:text-amber-50">
            {pendingRecoveryCodes.value.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      )}

      {!enabled && !setupSecret.value && (
        <>
          <div class="mt-4">
            <label class="block text-sm font-medium text-slate-700 dark:text-zinc-300" for="totp-settings-password">
              {t('totpPasswordLabel')}
            </label>
            <input
              id="totp-settings-password"
              type="password"
              autoComplete="current-password"
              value={passwordInput.value}
              onInput={(e) => { passwordInput.value = (e.currentTarget as HTMLInputElement).value; }}
              class={"mt-1 " + SETTINGS_INPUT_CLASS}
            />
          </div>
          <button
          type="button"
          disabled={busy.value}
          class="mt-4 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
          onClick={() => {
            void (async () => {
              busy.value = true;
              errorMsg.value = null;
              infoMsg.value = null;
              try {
                const result = await withPasswordHash(async (hash) => {
                  const baseUrl = await resolveWorkerAUrl();
                  const jwt = getOwnerJwt();
                  const client = createWorkerAClient({ baseUrl: baseUrl!, getJwt: () => jwt! });
                  return client.setupTotp(hash);
                });
                if (!result) return;
                setupSecret.value = result.secret_base32;
                setupOtpauth.value = result.otpauth_url;
                infoMsg.value = t('totpSetupHint');
              } catch (err) {
                errorMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('totpSetupFailed'));
              } finally {
                busy.value = false;
              }
            })();
          }}
        >
          {t('totpStartEnable')}
        </button>
        </>
      )}

      {!enabled && setupSecret.value && (
        <div class="mt-4 space-y-3">
          {/* 将 otpauth URL 渲染为二维码，供 Authenticator 扫码绑定 */}
          {setupOtpauth.value && (
            <div class="flex flex-col items-start gap-2">
              <p class="text-sm text-slate-700 dark:text-zinc-300">{t('totpQrHint')}</p>
              <QRCodeBadge
                value={setupOtpauth.value}
                label={t('totpQrAlt')}
                size={180}
              />
            </div>
          )}
          <p class="text-sm text-slate-700 dark:text-zinc-300">
            {t('totpManualSecretPrefix')}
            <code class="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-zinc-800">{setupSecret.value}</code>
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('totpCodePlaceholder')}
            value={totpInput.value}
            onInput={(e) => { totpInput.value = (e.currentTarget as HTMLInputElement).value; }}
            class={SETTINGS_INPUT_CLASS}
          />
          <button
            type="button"
            disabled={busy.value}
            class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
            onClick={() => {
              void (async () => {
                busy.value = true;
                errorMsg.value = null;
                try {
                  const enableResult = await withPasswordHash(async (hash) => {
                    const baseUrl = await resolveWorkerAUrl();
                    const jwt = getOwnerJwt();
                    const client = createWorkerAClient({ baseUrl: baseUrl!, getJwt: () => jwt! });
                    return client.enableTotp({ passwordHash: hash, totpCode: totpInput.value.trim() });
                  });
                  if (!enableResult) return;
                  pendingRecoveryCodes.value = enableResult.recovery_codes;
                  setupSecret.value = null;
                  setupOtpauth.value = null;
                  totpInput.value = '';
                  passwordInput.value = '';
                  infoMsg.value = t('totpEnableSuccess');
                  await loadStatus();
                } catch (err) {
                  errorMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('totpEnableFailed'));
                } finally {
                  busy.value = false;
                }
              })();
            }}
          >
            {t('totpConfirmEnable')}
          </button>
        </div>
      )}

      {(setupSecret.value || enabled) && (
        <div class="mt-4">
          <label class="block text-sm font-medium text-slate-700 dark:text-zinc-300" for="totp-settings-password">
            {t('totpPasswordLabel')}
          </label>
          <input
            id="totp-settings-password"
            type="password"
            autoComplete="current-password"
            value={passwordInput.value}
            onInput={(e) => { passwordInput.value = (e.currentTarget as HTMLInputElement).value; }}
            class={"mt-1 " + SETTINGS_INPUT_CLASS}
          />
        </div>
      )}

      {enabled && (
        <div class="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-zinc-600"
            onClick={() => { showRotate.value = !showRotate.value; showDisable.value = false; }}
          >
            {t('totpRefreshRecovery')}
          </button>
          <button
            type="button"
            class="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 dark:border-rose-700 dark:text-rose-300"
            onClick={() => { showDisable.value = !showDisable.value; showRotate.value = false; }}
          >
            {t('totpDisable')}
          </button>
        </div>
      )}

      {enabled && (showDisable.value || showRotate.value) && (
        <div class="mt-4 space-y-2">
          <input
            type="text"
            inputMode="numeric"
            placeholder={t('totpCodeOptionalPlaceholder')}
            value={totpInput.value}
            onInput={(e) => { totpInput.value = (e.currentTarget as HTMLInputElement).value; }}
            class={SETTINGS_INPUT_CLASS}
          />
          <input
            type="text"
            placeholder={t('totpRecoveryPlaceholder')}
            value={recoveryInput.value}
            onInput={(e) => { recoveryInput.value = (e.currentTarget as HTMLInputElement).value; }}
            class={SETTINGS_INPUT_CLASS}
          />
          <button
            type="button"
            disabled={busy.value}
            class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
            onClick={() => {
              void (async () => {
                busy.value = true;
                errorMsg.value = null;
                try {
                  if (showDisable.value) {
                    await withPasswordHash(async (hash) => {
                      const baseUrl = await resolveWorkerAUrl();
                      const jwt = getOwnerJwt();
                      const client = createWorkerAClient({ baseUrl: baseUrl!, getJwt: () => jwt! });
                      await client.disableTotp({
                        passwordHash: hash,
                        totpCode: totpInput.value.trim() || undefined,
                        recoveryCode: recoveryInput.value.trim() || undefined,
                      });
                      return true;
                    });
                    infoMsg.value = t('totpDisableSuccess');
                    showDisable.value = false;
                  } else {
                    const rotated = await withPasswordHash(async (hash) => {
                      const baseUrl = await resolveWorkerAUrl();
                      const jwt = getOwnerJwt();
                      const client = createWorkerAClient({ baseUrl: baseUrl!, getJwt: () => jwt! });
                      return client.rotateTotpRecoveryCodes({
                        passwordHash: hash,
                        totpCode: totpInput.value.trim() || undefined,
                        recoveryCode: recoveryInput.value.trim() || undefined,
                      });
                    });
                    if (rotated) {
                      pendingRecoveryCodes.value = rotated.recovery_codes;
                      infoMsg.value = t('totpRotateSuccess');
                    }
                    showRotate.value = false;
                  }
                  totpInput.value = '';
                  recoveryInput.value = '';
                  passwordInput.value = '';
                  await loadStatus();
                } catch (err) {
                  errorMsg.value = err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('totpActionFailed'));
                } finally {
                  busy.value = false;
                }
              })();
            }}
          >
            {t('totpConfirm')}
          </button>
        </div>
      )}
    </section>
  );
}
