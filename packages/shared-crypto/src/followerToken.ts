/**
 * 粉丝 Token 工具函数（M6-0 / audit-v3 步骤 2.1 共享）。
 *
 * 与 `ed25519.ts` 的 `verifyFollowerToken` 互补——
 * `verifyFollowerToken` 做完整验签；本模块提供「不解签名的 payload 预览」，
 * 用于在 expensive 的 Ed25519 验签之前快速判断 token 是否过期，
 * 并向调用方区分 `TOKEN_EXPIRED` vs `TOKEN_INVALID`。
 *
 * 注意：payload 解码成功不等于 token 合法。调用方必须在预览 exp 后
 * 再调用 `verifyFollowerToken` 做完整 Ed25519 验签。
 */

import { base64urlDecode } from '@hailuo/shared-utils';
import type { FollowerTokenPayload } from '@hailuo/shared-types';

/**
 * 仅解码 payload 段以判断 exp（不验签）。
 *
 * 解码失败统一返回 null，由上层归类为 TOKEN_INVALID。
 *
 * @returns 解码后的 payload，或 null（段数错 / 损坏 / 字段缺失 / 类型错）
 */
export function decodePayloadUnchecked(token: string): FollowerTokenPayload | null {
  // 非字符串（测试/误传）一律 null，避免 .split 抛异常冒成 500
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = new TextDecoder().decode(base64urlDecode(parts[1]));
    const parsed = JSON.parse(json) as Partial<FollowerTokenPayload>;
    if (
      typeof parsed.sub !== 'string' ||
      typeof parsed.iss !== 'string' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    return parsed as FollowerTokenPayload;
  } catch {
    return null;
  }
}
