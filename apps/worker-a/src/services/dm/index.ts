/**
 * NCF-2D1 DM 收件深模块公开出口。
 */
export type {
  ReceiveDmInboxCommand,
  ReceiveDmInboxDeps,
  ReceiveDmInboxResult,
  ReceiveDmInboxStatus,
} from './types';
export { runReceiveDmInbox } from './runReceiveDmInbox';
export { createProductionReceiveDmInboxDeps } from './adapters/production';

import type { Env } from '../../env';
import { createProductionReceiveDmInboxDeps } from './adapters/production';
import { runReceiveDmInbox } from './runReceiveDmInbox';
import type { ReceiveDmInboxCommand, ReceiveDmInboxResult } from './types';

/** 生产入口：command + Env → result（路由负责 parse / waitUntil / HTTP 映射） */
export async function executeReceiveDmInbox(
  env: Env,
  command: ReceiveDmInboxCommand,
): Promise<ReceiveDmInboxResult> {
  return runReceiveDmInbox(command, createProductionReceiveDmInboxDeps(env));
}
