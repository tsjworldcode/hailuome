/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { BadgeCheck } from 'lucide-preact';
import { t } from '../lib/i18n';

/** M7-31c：登记邮箱验码蓝标（非「官方认证」） */
export function VerifiedBadge(): VNode {
  const label = t('verifiedBadgeLabel');
  return (
    <span
      class="inline-flex shrink-0 items-center text-sky-500 dark:text-sky-400"
      title={label}
      aria-label={label}
    >
      <BadgeCheck size={16} strokeWidth={2.25} aria-hidden="true" />
    </span>
  );
}
