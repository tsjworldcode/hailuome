/**
 * NCF-HS-5：注册中心发号形态识别（节点侧）。
 *
 * 与 hailuo-registry `workers/registry-gateway/src/lib/ids.ts` D8 字面同源：
 *   usr_R{NN}_s{NN}_<ts10><rand20hex>
 *   crd_R{NN}_s{NN}_<ts10><rand20hex>
 *
 * 硬约束：
 * - 节点**不**做 IDENTITY 找片；禁止把本文件当业务路由依据。
 * - 落库 / Header 传出的 `owner_user_id` 仍以中心下发原文为准（不透明字符串）。
 * - 本模块只供「像不像合法 id」展示/夹具/门禁；不解析片号驱动逻辑。
 */

/** HS-1 / D8 权威形态（总长 42–49）。 */
export const REGISTRY_USER_ID_REGEX_D8 =
  /^usr_R(\d{2,9})_s(0[0-5])_([0-9A-Z]{10})([0-9A-F]{20})$/;

/** UID-REG-8 过渡形态（无片号，总长 38–45）；存量夹具/旧节点可能仍见。 */
export const REGISTRY_USER_ID_REGEX_PRE_HS =
  /^usr_R(\d{2,9})_([0-9A-Z]{10})([0-9A-F]{20})$/;

/** Access 凭证权威形态（与 usr_ 对称）。 */
export const REGISTRY_CREDENTIAL_ID_REGEX_D8 =
  /^crd_R(\d{2,9})_s(0[0-5])_([0-9A-Z]{10})([0-9A-F]{20})$/;

/** D8 文档示例（假数据；与中心计划示例同形）。 */
export const REGISTRY_USER_ID_D8_EXAMPLE = 'usr_R01_s03_00MVJNXEKFC15B7BDF891B23A1B2C3';

/**
 * 是否像注册中心 home `user_id`（认 D8 + PRE_HS 过渡态）。
 * 不认超宽松 legacy；业务落库勿用本函数拒收中心原文。
 */
export function looksLikeRegistryUserId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  if (!s.startsWith('usr_')) return false;
  return REGISTRY_USER_ID_REGEX_D8.test(s) || REGISTRY_USER_ID_REGEX_PRE_HS.test(s);
}

/** 是否像 D8 权威 `usr_` / `crd_` 主体 id（不含 PRE_HS）。 */
export function looksLikeRegistryPrincipalIdD8(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  return REGISTRY_USER_ID_REGEX_D8.test(s) || REGISTRY_CREDENTIAL_ID_REGEX_D8.test(s);
}
