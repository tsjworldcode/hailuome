/** @jsxImportSource preact */
/** M7-35 / M33-h6b：未认证清号提醒横幅（节点内展示，不发 ESP） */
import type { VNode } from 'preact';
import { reminderUrgencyTier, resolveReminderThresholdDays } from '../lib/certPurgeReminder';
import { t } from '../lib/i18n';
import type { CertPurgeStatus } from '../lib/workerA';

function bannerClass(tier: ReturnType<typeof reminderUrgencyTier>): string {
  const base = 'mt-4 rounded-xl border p-4 text-sm';
  switch (tier) {
    case 'overdue':
    case 'high':
      return `${base} border-rose-300 bg-rose-50/90 text-rose-950 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100`;
    case 'medium':
      return `${base} border-orange-300 bg-orange-50/90 text-orange-950 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-100`;
    case 'low':
      return `${base} border-amber-300 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100`;
    default:
      return `${base} border-amber-200 bg-amber-50/80 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100`;
  }
}

function messageForStatus(status: CertPurgeStatus): string {
  const days = status.days_until_purge ?? 0;
  if (status.reminder_level === 'overdue') {
    return t('certPurgeOverdue');
  }
  const threshold = resolveReminderThresholdDays(status);
  if (threshold != null) {
    return t('certPurgeReminderThreshold', undefined, {
      days: String(Math.max(0, days)),
      threshold: String(threshold),
    });
  }
  return t('certPurgeAlways');
}

type Props = {
  readonly status: CertPurgeStatus;
  readonly showCertifyLink?: boolean;
};

export function CertPurgeReminderBanner({ status, showCertifyLink = true }: Props): VNode | null {
  if (!status.applicable || status.email_verified) return null;
  const tier = reminderUrgencyTier(status);
  return (
    <div class={bannerClass(tier)} role="status">
      <p class="font-medium">{t('certPurgeTitle')}</p>
      <p class="mt-1 text-[13px] leading-5">{messageForStatus(status)}</p>
      {showCertifyLink && (
        <a
          href="/certify"
          class="mt-2 inline-flex text-[13px] font-semibold underline underline-offset-2"
        >
          {t('certPurgeGoCertify')}
        </a>
      )}
    </div>
  );
}
