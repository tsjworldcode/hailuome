/**
 * NCF-2D3 Messaging Media serve 验票深模块公开出口。
 */
export type {
  ServeMessagingMediaCommand,
  ServeMessagingMediaDeps,
  ServeMessagingMediaResult,
  ServeMessagingMediaStatus,
} from './types';
export { runServeMessagingMedia } from './runServeMessagingMedia';
export { createProductionServeMessagingMediaDeps } from './adapters/production';

import type { Env } from '../../env';
import { createProductionServeMessagingMediaDeps } from './adapters/production';
import { runServeMessagingMedia } from './runServeMessagingMedia';
import type { ServeMessagingMediaCommand, ServeMessagingMediaResult } from './types';

/** 生产入口：command + Env → result（路由负责 decode ticket / serveMediaObject / HTTP） */
export async function executeServeMessagingMedia(
  env: Env,
  command: ServeMessagingMediaCommand,
): Promise<ServeMessagingMediaResult> {
  return runServeMessagingMedia(command, createProductionServeMessagingMediaDeps(env));
}
