/**
 * M7-1 + M-i18n-L5：错误码文案走 catalogs/{lang}/errors；
 * ERROR_MESSAGES 保留为 zh 别名，供契约脚本扫描对账。
 */
import { language as languageSignal, type Language } from './i18n';
import { DEFAULT_LANGUAGE } from './i18n/locales';
import {
  ERROR_MESSAGES_ZH,
  loadErrorCatalog,
  lookupErrorMessage,
} from './i18n/errorCatalog';

export interface ApiErrorBody {
  readonly error_code: string;
  readonly message?: string;
  /** REG-BO-5 / M9-PH-BO-2：主链错误可选路径 D 引导（不替换 error_code） */
  readonly fallback_available?: boolean;
  readonly fallback_required_reason?: string;
  readonly fallback_email_to?: string;
  readonly fallback_paths?: readonly string[];
  /**
   * M16-DAILY-SYNC-COOLDOWN-1 等：错误附带结构化 data（如 retry_after_hours）。
   * 不参与展示文案选择，由调用方按 error_code 读取。
   * 用 unknown：避免与成功响应体里同名 `data` 字段在联合/误传时撞类型。
   */
  readonly data?: unknown;
}

/**
 * 错误码 → 中文文案（zh catalog 快照别名）。
 * 维护约定：改 catalogs/zh/errors.ts；可用 scripts/extract-error-catalogs.mjs 从历史块重建。
 */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = ERROR_MESSAGES_ZH as Readonly<
  Record<string, string>
>;

export const FALLBACK_ERROR_MESSAGE = '操作失败，请稍后再试';

/**
 * 根据后端返回的 `{ error_code, message }` 解析出展示文案。
 *
 * 优先级：
 *   1. 当前语言 catalogs 中的 error_code
 *   2. 服务端 message
 *   3. 兜底文案
 */
export function getErrorMessage(
  body: Partial<ApiErrorBody> | null | undefined,
  fallback?: string,
  lang: Language = languageSignal.value ?? DEFAULT_LANGUAGE,
): string {
  const code = body?.error_code;
  if (code) {
    const mapped = lookupErrorMessage(code, lang);
    if (mapped) return mapped;
  }
  if (body?.message && typeof body.message === 'string' && body.message.trim().length > 0) {
    return body.message;
  }
  return fallback ?? FALLBACK_ERROR_MESSAGE;
}

export function ensureErrorCatalog(lang: Language): Promise<unknown> {
  return loadErrorCatalog(lang);
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly displayMessage: string;
  readonly body: Partial<ApiErrorBody> | null;

  constructor(status: number, body: Partial<ApiErrorBody> | null, fallback?: string) {
    const displayMessage = getErrorMessage(body, fallback);
    super(displayMessage);
    this.name = 'ApiError';
    this.code = body?.error_code ?? '';
    this.status = status;
    this.displayMessage = displayMessage;
    this.body = body;
  }
}
