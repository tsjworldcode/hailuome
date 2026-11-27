/**
 * NCF-WEB-2：PostCard 共用小工具（无 CF / 无 Worker A 红线字面量）。
 */
import { resolvePublicWorkerBBaseUrlSync } from '../../lib/deployEnv';

/** 粉丝 Token 申请用的本节点公开基址（Pages 同源优先）。 */
export function getFollowerNodeUrl(): string {
  const publicWorkerB = resolvePublicWorkerBBaseUrlSync();
  if (publicWorkerB) return publicWorkerB;
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/** 印象信号触发延迟：进入视口持续多少毫秒视为「读过」 */
export const IMPRESSION_DELAY_MS = 1500;

export const REPLY_MAX_LENGTH = 300;
