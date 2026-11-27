/**
 * NCF-2C Registration 深模块公开出口。
 */
export type {
  CertInboundPresentation,
  RegisterCompliance,
  RegisterCompleteCommand,
  RegisterCompleteDeps,
  RegisterCompleteResult,
  RegisterCompleteStatus,
  RegisterCompleteSuccessData,
  RegistryClientResponse,
  RegistryIdentityPayload,
} from './types';
export { runRegisterComplete } from './runRegisterComplete';
export { createProductionRegisterCompleteDeps } from './adapters/production';
export {
  parseRegistrationChallengePendingPayload,
  parseRegistrationSyncPayload,
  assertChallengePendingIdentityMatchesPayload,
  isChallengePendingPayloadAlive,
  REGISTRATION_SYNC_PHASE_REGISTRY_CHALLENGE_PENDING,
  REGISTRATION_SYNC_PHASE_REGISTRY_VERIFIED,
  REGISTRATION_SYNC_SCOPE_HOME,
} from './registrationSyncState';

import type { Env } from '../../env';
import { createProductionRegisterCompleteDeps } from './adapters/production';
import { runRegisterComplete } from './runRegisterComplete';
import type { RegisterCompleteCommand, RegisterCompleteResult } from './types';

/** 生产入口：command + Env → result（路由层负责解析 body / waitUntil） */
export async function executeRegisterComplete(
  env: Env,
  command: RegisterCompleteCommand,
  clientIp: string | null = null,
): Promise<RegisterCompleteResult> {
  return runRegisterComplete(command, createProductionRegisterCompleteDeps(env, clientIp));
}
