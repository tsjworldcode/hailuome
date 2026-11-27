/**
 * REG-AUDIT-Y-17：管理 API 通用响应信封（gateway ↔ admin-web 共享）。
 *
 * SSOT 订正：审计原写 `workers/registry-gateway/src/types/api.ts`——该路径历史上不存在；
 * 真源曾是 `lib/response.ts` 的 SuccessBody / FailureBody + 前端 `apiClient.js` 的解包约定。
 * 本文件把信封字段钉进 `@hailuo/registry-protocol`，防两端漂移。
 *
 * 对齐 docs/admin-api.md「通用响应结构」：
 *   成功：{ ok: true, data: <T> }
 *   失败：{ ok: false, error_code, message, …可选 fallback_* }
 *
 * 防身份关联：信封不含邮箱原文 / IP / token 明文。
 */

/** 管理 / 节点 API 成功体。 */
export interface AdminApiSuccessBody<T> {
  ok: true;
  data: T;
}

/**
 * 管理 / 节点 API 失败体。
 * `fallback_*` 为 REG-BO-5 可选引导字段；不替换原 error_code。
 */
export interface AdminApiFailureBody {
  ok: false;
  error_code: string;
  message: string;
  fallback_available?: boolean;
  fallback_required_reason?: string;
  fallback_email_to?: string;
  fallback_paths?: string[];
}

/** 前端 AdminApiError 抛出形状（与 apiClient.js 字段对齐）。 */
export interface AdminApiClientErrorShape {
  error_code: string;
  message: string;
  status: number;
}

/** 分页 data 常见形态（items + 游标）；具体业务 DTO 可再扩展。 */
export interface AdminApiPaginatedData<T> {
  items: T[];
  total?: number;
  cursor?: string | null;
  has_more?: boolean;
}
