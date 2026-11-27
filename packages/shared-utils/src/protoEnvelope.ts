import {
  HAILUO_PROTO_VERSION,
  type HailuoProtoVersion,
  type ProtoVersionedEnvelope,
} from '@hailuo/shared-types';

/** M9-6：为跨节点/跨服务 envelope 注入 proto_version（不修改内部 DTO 项） */
export function withProtoVersion<T extends Record<string, unknown>>(
  payload: T,
): T & ProtoVersionedEnvelope {
  return { proto_version: HAILUO_PROTO_VERSION, ...payload };
}

/** M9-6：outbound JSON body 序列化（health / 索引上报等） */
export function serializeProtoEnvelope(payload: Record<string, unknown>): string {
  return JSON.stringify(withProtoVersion(payload));
}

export { HAILUO_PROTO_VERSION, type HailuoProtoVersion };
