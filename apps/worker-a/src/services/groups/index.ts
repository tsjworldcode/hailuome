/**
 * NCF-2D2 Groups 群主 inbound 深模块公开出口。
 */
export type {
  AcceptGroupMessageCommand,
  AcceptGroupMessageDeps,
  AcceptGroupMessageResult,
  AcceptGroupMessageStatus,
} from './types';
export { runAcceptGroupMessage } from './runAcceptGroupMessage';
export { createProductionAcceptGroupMessageDeps } from './adapters/production';

import type { Env } from '../../env';
import type { GroupRelaySchedule } from '../../lib/groupRelay';
import { createProductionAcceptGroupMessageDeps } from './adapters/production';
import { runAcceptGroupMessage } from './runAcceptGroupMessage';
import type { AcceptGroupMessageCommand, AcceptGroupMessageResult } from './types';

/** 生产入口：command + Env → result（路由负责 parse / waitUntil / HTTP 映射） */
export async function executeAcceptGroupMessage(
  env: Env,
  command: AcceptGroupMessageCommand,
  opts?: { schedule?: GroupRelaySchedule },
): Promise<AcceptGroupMessageResult> {
  return runAcceptGroupMessage(
    command,
    createProductionAcceptGroupMessageDeps(env, { schedule: opts?.schedule }),
  );
}
