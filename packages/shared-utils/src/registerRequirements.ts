/**
 * 注册合规字段校验（年龄自证 / 邮箱 / 项目许可同意）。
 * SPILL-1c-node-c：人口学（birth_date/country/phone/gender）校验与常量已物理删除。
 * 2026-09-27：移除 age_over_18 相关校验与常量。
 * 与 hailuo-registry 侧规则保持一致的部分：邮箱白名单、条款版本。
 */

import {
  REGISTER_EMAIL_DOMAIN_USER_MESSAGE,
  checkRegisterEmailDomainV1,
} from './emailAllowlistV1';

/** 当前生效的项目许可/手册版本；与注册页弹窗、/terms 正文一致。 */
export const PROJECT_TERMS_VERSION = '1.26.09.13';

export type RegisterFieldError = {
  code: string;
  message: string;
  status?: number;
};

/**
 * 2026-09-27：移除 age_over_18 年龄自证校验。
 * 注册不再要求年龄自证勾选。
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LEN = 254;

/** 登记 precheck：邮箱必填 + 格式 + 内置白/黑名单 v1。 */
export function validateRegisterPrecheckEmail(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: RegisterFieldError } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
    return {
      ok: false,
      error: {
        code: 'REGISTER_EMAIL_REQUIRED',
        message: '登记邮箱为必填项',
        status: 400,
      },
    };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: {
        code: 'REGISTER_EMAIL_INVALID',
        message: '登记邮箱格式无效',
        status: 400,
      },
    };
  }
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) {
    return {
      ok: false,
      error: {
        code: 'REGISTER_EMAIL_INVALID',
        message: '登记邮箱格式无效',
        status: 400,
      },
    };
  }
  const domainCheck = checkRegisterEmailDomainV1(email);
  if (!domainCheck.ok) {
    return {
      ok: false,
      error: {
        code: domainCheck.code,
        message: REGISTER_EMAIL_DOMAIN_USER_MESSAGE,
        status: 403,
      },
    };
  }
  return { ok: true, value: email };
}

/**
 * 登记邮箱（改档）：空 → null；有值时仅格式校验（白名单在 precheck/登记路径）。
 * Settings registration-profile PATCH 用此校验。
 */
export function validateRegisterEmail(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: RegisterFieldError } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: { code: 'REGISTRATION_EMAIL_INVALID', message: '登记邮箱格式无效', status: 400 },
    };
  }
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) {
    return {
      ok: false,
      error: { code: 'REGISTRATION_EMAIL_INVALID', message: '登记邮箱格式无效', status: 400 },
    };
  }
  return { ok: true, value: email };
}

/** 条款勾选 + 版本对齐。 */
export function validateTermsAcceptance(
  termsAccepted: unknown,
  termsVersion: unknown,
):
  | { ok: true; terms_version: string; terms_accepted_at: string }
  | { ok: false; error: RegisterFieldError } {
  if (termsAccepted !== true) {
    return {
      ok: false,
      error: {
        code: 'REGISTER_TERMS_REQUIRED',
        message: '请阅读并同意项目许可与使用手册',
        status: 400,
      },
    };
  }
  const version =
    typeof termsVersion === 'string' && termsVersion.trim().length > 0
      ? termsVersion.trim()
      : PROJECT_TERMS_VERSION;

  if (version !== PROJECT_TERMS_VERSION) {
    return {
      ok: false,
      error: {
        code: 'REGISTER_TERMS_VERSION_MISMATCH',
        message: `许可版本须为 ${PROJECT_TERMS_VERSION}`,
        status: 403,
      },
    };
  }

  return { ok: true, terms_version: version, terms_accepted_at: new Date().toISOString() };
}
