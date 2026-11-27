/**
 * NCF-NOTES-8：读取包裹主密钥状态（窄 deps，无 Env / Hono）。
 * Worker 只返回包裹密文，不解包；无行时 enabled=false。
 * 不碰 Messaging。
 */
import type {
  GetPrivateNotesWrappedKeyCommand,
  GetPrivateNotesWrappedKeyDeps,
  GetPrivateNotesWrappedKeyResult,
} from './types';

export async function runGetPrivateNotesWrappedKey(
  _command: GetPrivateNotesWrappedKeyCommand,
  deps: GetPrivateNotesWrappedKeyDeps,
): Promise<GetPrivateNotesWrappedKeyResult> {
  try {
    const row = await deps.store.loadWrappedKey();
    if (!row) {
      return {
        status: 'ok',
        httpStatus: 200,
        data: { enabled: false },
      };
    }
    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        enabled: true,
        key_epoch: row.key_epoch,
        wrapped_key_json: row.wrapped_key_json,
        updated_at: row.updated_at,
      },
    };
  } catch (err) {
    deps.logger.error('[private-notes] 读取包裹主密钥失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_SAVE_FAILED',
      message: '读取记录加密状态失败，请稍后重试',
    };
  }
}
