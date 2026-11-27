/** @jsxImportSource preact */
/** M7-36：登记后未认证徽标（链到 /certify） */
import type { VNode } from 'preact';
import { ownerProfile } from '../lib/ownerProfile';
import { t } from '../lib/i18n';

type Props = {
  readonly className?: string;
  readonly compact?: boolean;
};

export function PendingCertifyBadge({ className = '', compact = false }: Props): VNode | null {
  const profile = ownerProfile.value;
  if (!profile?.registered || profile.email_verified === true) return null;

  const base =
    'inline-flex items-center rounded-full border border-sky-300 bg-sky-50 font-semibold text-sky-800 transition hover:bg-sky-100 dark:border-sky-400 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25';
  const size = compact
    ? 'px-2 py-0.5 text-[10px] leading-4'
    : 'px-2.5 py-0.5 text-xs';

  return (
    <a
      href="/certify"
      class={`${base} ${size} ${className}`.trim()}
      title={t('navProfilePendingCertifyHint')}
      data-i18n="navProfilePendingCertify"
    >
      {t('navProfilePendingCertify')}
    </a>
  );
}
