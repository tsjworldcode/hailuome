/**
 * NCF-NOTES-8：写入包裹主密钥（窄 deps，无 Env / Hono）。
 * INSERT OR REPLACE 单条；日志禁止 dump wrapped_key_json。
 * 不碰 Messaging。
 */
import { parsePutPrivateNotesWrappedKeyBody } from './wrappedKeyUtils';
import type {
  PutPrivateNotesWrappedKeyCommand,
  PutPrivateNotesWrappedKeyDeps,
  PutPrivateNotesWrappedKeyResult,
} from './types';

export async function runPutPrivateNotesWrappedKey(
  command: PutPrivateNotesWrappedKeyCommand,
  deps: PutPrivateNotesWrappedKeyDeps,
): Promise<PutPrivateNotesWrappedKeyResult> {
  const parsed = parsePutPrivateNotesWrappedKeyBody(command.body);
  if (!parsed.ok) {
    return {
      status: 'invalid_body',
      httpStatus: 400,
      error_code: 'INVALID_BODY',
      message: parsed.reason === 'invalid_wrapped_key' ? '包裹主密钥格式无效' : '请求体格式无效',
    };
  }

  const updatedAt = deps.clock.nowIso();
  try {
    await deps.store.upsertWrappedKey({
      keyEpoch: parsed.keyEpoch,
      wrappedKeyJson: parsed.wrappedKeyJson,
      updatedAt,
    });
    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        enabled: true,
        key_epoch: parsed.keyEpoch,
        updated_at: updatedAt,
      },
    };
  } catch (err) {
    deps.logger.error('[private-notes] 写入包裹主密钥失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_SAVE_FAILED',
      message: '保存记录加密配置失败，请稍后重试',
    };
  }
}
