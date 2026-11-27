/**
 * NCF-NOTES-8：PUT wrapped-key 请求体解析（纯函数）。
 */
import { PRIVATE_NOTES_WRAPPED_KEY_JSON_MAX } from './types';

export type ParsePutPrivateNotesWrappedKeyBodyResult =
  | { ok: true; keyEpoch: number; wrappedKeyJson: string }
  | { ok: false; reason: 'invalid_body' | 'invalid_wrapped_key' };

function parseKeyEpoch(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

function parseWrappedKeyJson(value: unknown): string | null {
  const wrappedKeyJson =
    typeof value === 'string' ? value.trim() : JSON.stringify(value ?? {});
  if (!wrappedKeyJson || wrappedKeyJson.length > PRIVATE_NOTES_WRAPPED_KEY_JSON_MAX) {
    return null;
  }
  return wrappedKeyJson;
}

export function parsePutPrivateNotesWrappedKeyBody(
  body: Record<string, unknown>,
): ParsePutPrivateNotesWrappedKeyBodyResult {
  const wrappedKeyJson = parseWrappedKeyJson(body.wrapped_key_json);
  if (!wrappedKeyJson) {
    return { ok: false, reason: 'invalid_wrapped_key' };
  }
  return {
    ok: true,
    keyEpoch: parseKeyEpoch(body.key_epoch),
    wrappedKeyJson,
  };
}
