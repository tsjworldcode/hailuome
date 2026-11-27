/**
 * NCF-2B Auth 深模块公开出口。
 * 登录 · 改密 · KDF 参数 · me · profile · TOTP 管理。
 */
export type {
  OwnerCredential,
  OwnerLoginCommand,
  OwnerLoginDeps,
  OwnerLoginResult,
  OwnerLoginStatus,
  OwnerLoginSuccessData,
  OwnerChangePasswordCommand,
  OwnerChangePasswordDeps,
  OwnerChangePasswordResult,
  OwnerChangePasswordStatus,
  OwnerChangePasswordSuccessData,
  OwnerLoginParamsCommand,
  OwnerLoginParamsDeps,
  OwnerLoginParamsResult,
  OwnerLoginParamsStatus,
  OwnerPasswordParamsCommand,
  OwnerPasswordParamsDeps,
  OwnerPasswordParamsResult,
  OwnerPasswordParamsStatus,
  OwnerPasswordKdfParamsData,
  OwnerMeCommand,
  OwnerMeDeps,
  OwnerMeResult,
  OwnerMeData,
  OwnerPatchProfileCommand,
  OwnerPatchProfileDeps,
  OwnerPatchProfileResult,
  OwnerPatchProfileSuccessData,
  OwnerTotpManageDeps,
  OwnerTotpStatusCommand,
  OwnerTotpStatusResult,
  OwnerTotpSetupCommand,
  OwnerTotpSetupResult,
  OwnerTotpEnableCommand,
  OwnerTotpEnableResult,
  OwnerTotpDisableCommand,
  OwnerTotpDisableResult,
  OwnerTotpRotateCommand,
  OwnerTotpRotateResult,
  TotpGateOutcome,
} from './types';
export { runOwnerLogin } from './runOwnerLogin';
export { runOwnerChangePassword } from './runOwnerChangePassword';
export { runGetOwnerLoginParams } from './runGetOwnerLoginParams';
export { runGetOwnerPasswordParams } from './runGetOwnerPasswordParams';
export { runGetOwnerMe } from './runGetOwnerMe';
export { runPatchOwnerProfile } from './runPatchOwnerProfile';
export {
  runGetOwnerTotpStatus,
  runOwnerTotpSetup,
  runOwnerTotpEnable,
  runOwnerTotpDisable,
  runOwnerTotpRotateRecovery,
} from './runOwnerTotp';
export { resolveCredentialUsername } from './ownerAuthUtils';
export {
  normalizeProfileText,
  normalizeContactEmail,
  normalizePatchProfileBody,
  PROFILE_DISPLAY_NAME_MAX,
  PROFILE_BIO_MAX,
  PROFILE_CONTACT_EMAIL_MAX,
  PROFILE_AVATAR_KEY_MAX,
} from './profileUtils';
export {
  loadOwnerRegistryIdentity,
  resolveOwnerHandleQualified,
  resolvePubkeyFingerprint,
  resolveOwnerDidV2,
} from './ownerIdentityUtils';
export {
  createProductionOwnerLoginDeps,
  createProductionOwnerChangePasswordDeps,
  createProductionOwnerLoginParamsDeps,
  createProductionOwnerPasswordParamsDeps,
  createProductionOwnerMeDeps,
  createProductionOwnerPatchProfileDeps,
  createProductionOwnerTotpManageDeps,
  JWT_TTL_SEC,
} from './adapters/production';

import type { Env } from '../../env';
import {
  createProductionOwnerLoginDeps,
  createProductionOwnerChangePasswordDeps,
  createProductionOwnerLoginParamsDeps,
  createProductionOwnerPasswordParamsDeps,
  createProductionOwnerMeDeps,
  createProductionOwnerPatchProfileDeps,
  createProductionOwnerTotpManageDeps,
} from './adapters/production';
import { runOwnerLogin } from './runOwnerLogin';
import { runOwnerChangePassword } from './runOwnerChangePassword';
import { runGetOwnerLoginParams } from './runGetOwnerLoginParams';
import { runGetOwnerPasswordParams } from './runGetOwnerPasswordParams';
import { runGetOwnerMe } from './runGetOwnerMe';
import { runPatchOwnerProfile } from './runPatchOwnerProfile';
import {
  runGetOwnerTotpStatus,
  runOwnerTotpDisable,
  runOwnerTotpEnable,
  runOwnerTotpRotateRecovery,
  runOwnerTotpSetup,
} from './runOwnerTotp';
import type {
  OwnerChangePasswordCommand,
  OwnerChangePasswordResult,
  OwnerLoginCommand,
  OwnerLoginParamsCommand,
  OwnerLoginParamsResult,
  OwnerLoginResult,
  OwnerMeCommand,
  OwnerMeResult,
  OwnerPatchProfileCommand,
  OwnerPatchProfileResult,
  OwnerPasswordParamsCommand,
  OwnerPasswordParamsResult,
  OwnerTotpDisableCommand,
  OwnerTotpDisableResult,
  OwnerTotpEnableCommand,
  OwnerTotpEnableResult,
  OwnerTotpRotateCommand,
  OwnerTotpRotateResult,
  OwnerTotpSetupCommand,
  OwnerTotpSetupResult,
  OwnerTotpStatusCommand,
  OwnerTotpStatusResult,
} from './types';

/** 生产入口：command + Env → result（路由层负责解析 body / IP） */
export async function executeOwnerLogin(
  env: Env,
  command: OwnerLoginCommand,
): Promise<OwnerLoginResult> {
  return runOwnerLogin(command, createProductionOwnerLoginDeps(env));
}

/** 生产入口：改密（JWT 后；路由解析 body） */
export async function executeOwnerChangePassword(
  env: Env,
  command: OwnerChangePasswordCommand,
): Promise<OwnerChangePasswordResult> {
  return runOwnerChangePassword(command, createProductionOwnerChangePasswordDeps(env));
}

/** 生产入口：登录 KDF 参数（公开） */
export async function executeGetOwnerLoginParams(
  env: Env,
  command: OwnerLoginParamsCommand,
): Promise<OwnerLoginParamsResult> {
  return runGetOwnerLoginParams(command, createProductionOwnerLoginParamsDeps(env));
}

/** 生产入口：改密 KDF 参数（JWT 后） */
export async function executeGetOwnerPasswordParams(
  env: Env,
  command: OwnerPasswordParamsCommand,
): Promise<OwnerPasswordParamsResult> {
  return runGetOwnerPasswordParams(command, createProductionOwnerPasswordParamsDeps(env));
}

/** 生产入口：站主信息聚合（JWT 后） */
export async function executeGetOwnerMe(env: Env, command: OwnerMeCommand): Promise<OwnerMeResult> {
  return runGetOwnerMe(command, createProductionOwnerMeDeps(env));
}

/** 生产入口：公开资料更新（JWT 后；路由解析 JSON body） */
export async function executePatchOwnerProfile(
  env: Env,
  command: OwnerPatchProfileCommand,
): Promise<OwnerPatchProfileResult> {
  return runPatchOwnerProfile(command, createProductionOwnerPatchProfileDeps(env));
}

function totpDeps(env: Env) {
  return createProductionOwnerTotpManageDeps(env);
}

/** 生产入口：TOTP 状态 */
export async function executeGetOwnerTotpStatus(
  env: Env,
  command: OwnerTotpStatusCommand,
): Promise<OwnerTotpStatusResult> {
  return runGetOwnerTotpStatus(command, totpDeps(env));
}

/** 生产入口：TOTP 发起设置 */
export async function executeOwnerTotpSetup(
  env: Env,
  command: OwnerTotpSetupCommand,
): Promise<OwnerTotpSetupResult> {
  return runOwnerTotpSetup(command, totpDeps(env));
}

/** 生产入口：TOTP 确认启用 */
export async function executeOwnerTotpEnable(
  env: Env,
  command: OwnerTotpEnableCommand,
): Promise<OwnerTotpEnableResult> {
  return runOwnerTotpEnable(command, totpDeps(env));
}

/** 生产入口：TOTP 关闭 */
export async function executeOwnerTotpDisable(
  env: Env,
  command: OwnerTotpDisableCommand,
): Promise<OwnerTotpDisableResult> {
  return runOwnerTotpDisable(command, totpDeps(env));
}

/** 生产入口：TOTP 恢复码轮换 */
export async function executeOwnerTotpRotateRecovery(
  env: Env,
  command: OwnerTotpRotateCommand,
): Promise<OwnerTotpRotateResult> {
  return runOwnerTotpRotateRecovery(command, totpDeps(env));
}
