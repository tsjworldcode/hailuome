/**
 * M-RTC-1：1:1 语音通话信令（走 DM E2EE 明文 JSON，服务器只见密文）。
 * 注意：SDP/ICE 可能含网络指纹，禁止写入日志或错误 message。
 */
export type CallSignalState = 'invite' | 'accept' | 'reject' | 'hangup' | 'missed';

export interface CallSignalPayload {
  readonly v: 1;
  readonly kind: 'CALL_SIGNAL';
  readonly call_id: string;
  readonly state: CallSignalState;
  /** offer / answer SDP；仅存于 E2EE 密文内 */
  readonly sdp?: string;
  readonly sdp_type?: 'offer' | 'answer';
}

export type CallUiPhase =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'connected'
  | 'ended';

export interface CallUiSnapshot {
  readonly phase: CallUiPhase;
  readonly callId: string | null;
  readonly peerHandle: string | null;
  readonly muted: boolean;
  readonly error: string | null;
  readonly startedAt: number | null;
}

export const CALL_RING_TIMEOUT_MS = 45_000;

export function isCallSignalPayload(value: unknown): value is CallSignalPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as CallSignalPayload;
  return (
    v.v === 1 &&
    v.kind === 'CALL_SIGNAL' &&
    typeof v.call_id === 'string' &&
    v.call_id.length > 0 &&
    typeof v.state === 'string' &&
    ['invite', 'accept', 'reject', 'hangup', 'missed'].includes(v.state)
  );
}

export function newCallId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
