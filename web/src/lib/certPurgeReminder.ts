/**
 * M7-35-h / M33-h6b：清号提醒横幅 — 可配置 purge_reminder_days 与注册中心契约对齐。
 */
import type { CertPurgeStatus } from './workerA/types';

export type ReminderUrgencyTier = 'none' | 'low' | 'medium' | 'high' | 'overdue';

/** 解析当前命中的提醒阈值（天）；优先 reminder_threshold_days，回退解析 reminder_level。 */
export function resolveReminderThresholdDays(status: CertPurgeStatus): number | null {
  if (status.reminder_threshold_days != null) {
    return status.reminder_threshold_days;
  }
  const level = status.reminder_level;
  if (level === 'none' || level === 'overdue') return null;
  const n = Number.parseInt(level, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 根据命中阈值在 policy.purge_reminder_days 中的位置计算视觉紧迫度。
 * 阈值越小（越临近清号）紧迫度越高。
 */
export function reminderUrgencyTier(status: CertPurgeStatus): ReminderUrgencyTier {
  if (status.reminder_level === 'overdue') return 'overdue';
  if (status.reminder_level === 'none') return 'none';

  const threshold = resolveReminderThresholdDays(status);
  if (threshold == null) return 'low';

  const sortedDesc = [...status.policy.purge_reminder_days].sort((a, b) => b - a);
  const idx = sortedDesc.indexOf(threshold);
  if (idx < 0) return 'low';
  if (sortedDesc.length === 1) return 'high';
  if (idx === sortedDesc.length - 1) return 'high';
  if (idx === 0) return 'low';
  return 'medium';
}
