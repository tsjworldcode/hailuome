/** @jsxImportSource preact */
/** M-REFACTOR-1dï¼?ç§ä¿¡é?ç§?/ èº«ä»½è½®æ¢ section */
import type { VNode } from 'preact';
import { KeyRound } from 'lucide-preact';
import { ConfirmDialog } from '../ConfirmDialog';
import { t } from '../../lib/i18n';
import { SETTINGS_SECTION_CLASS } from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  settingsConfirmKind,
  rotateDmIdentityPending,
  handleRotateDmIdentity,
  confirmRotateDmIdentity,
} from './hooks/useDmPrivacySettings';

export function SettingsDmPrivacySection(): VNode {
  return (
    <>
      <section class={SETTINGS_SECTION_CLASS}>
        <SettingsSectionHeader sectionKey="dmPrivacy" title={t('settingsDmPrivacyTitle')} />
        <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {t('settingsDmPrivacyRetention')}
        </p>
        <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {t('settingsDmPrivacyRotateHint')}
        </p>
        <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {t('settingsDmPrivacyBackupHint')}
        </p>
        <button
          type="button"
          class="mt-3 rounded-xl border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          disabled={rotateDmIdentityPending.value}
          onClick={() => void handleRotateDmIdentity()}
        >
          {rotateDmIdentityPending.value ? t('settingsDmRotatePending') : t('settingsDmRotateButton')}
        </button>
      </section>
      <ConfirmDialog
        open={settingsConfirmKind.value === 'dm-rotate'}
        pending={rotateDmIdentityPending.value}
        title={t('settingsDmRotateDialogTitle')}
        body={<p>{t('settingsDmRotateConfirm')}</p>}
        cancelLabel={t('settingsDmRotateDialogCancel')}
        confirmLabel={t('settingsDmRotateDialogConfirm')}
        confirmPendingLabel={t('settingsDmRotateDialogPending')}
        icon={<KeyRound size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (!rotateDmIdentityPending.value) settingsConfirmKind.value = null;
        }}
        onConfirm={() => void confirmRotateDmIdentity()}
      />
    </>
  );

}
